import { readdir, stat, rm } from 'node:fs/promises';
import { PROVIDERS, providerById, saveSelection } from '../core/providers.js';
import { discoverModels } from '../core/model-discovery.js';
import type { Message } from '../core/types.js';
import { TodoStore, registerTodoTools } from '../infra/todos.js';
import { ExecutionJournal } from '../infra/execution-journal.js';
import { loadSession, saveSession } from '../infra/memory.js';
import { ApprovalQueue } from './approvals.js';
import { runtimeConfig, type RuntimeConfig } from './config.js';
import { createServices, type RuntimeServices, type RuntimeDependencies } from './services.js';
import type {
  AgentClient,
  Command,
  CommandResult,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionView,
} from './contracts.js';

export type { RuntimeEvent, RuntimeSnapshot, SessionView, ApprovalView } from './contracts.js';

export type RuntimeOptions = Partial<RuntimeConfig> & { dependencies?: RuntimeDependencies };

/** Application host. All interfaces use the same command and event contract. */
export class AgentRuntime implements AgentClient {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly approvals = new ApprovalQueue((event) => this.emit(event));
  private readonly config: RuntimeConfig;
  private services?: RuntimeServices;
  private startup?: Promise<RuntimeSnapshot>;
  private activeRun?: Promise<string>;
  private controller?: AbortController;
  private changing = false;
  private updating?: Promise<unknown>;
  private closed = false;
  private shutdown?: Promise<void>;
  private sessionId: string;

  constructor(private readonly options: RuntimeOptions = {}) {
    this.config = runtimeConfig(options);
    this.sessionId = this.config.sessionId;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    // A broken view must not abort model execution or prevent another client receiving events.
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        /* subscribers own their errors */
      }
    }
  }

  initialize(): Promise<RuntimeSnapshot> {
    if (this.closed) return Promise.reject(new Error('Agent 运行时已关闭'));
    this.startup ??= this.start();
    return this.startup.then(() => this.snapshot());
  }

  private async start(): Promise<RuntimeSnapshot> {
    this.services = await createServices(
      this.config,
      this.options.dependencies ?? {},
      (event) => {
        this.emit(event);
        if (event.type === 'agent' && event.event.type === 'tool_end') this.publishState();
      },
      (view) => this.approvals.request(view, this.controller?.signal),
      () => this.controller?.signal,
    );
    if (this.closed) {
      await this.services.close();
      throw new Error('Agent 运行时已关闭');
    }
    await saveSession(this.services.project.session(this.sessionId), this.services.agent.history);
    this.publishState();
    return this.snapshot();
  }

  private ready(): RuntimeServices {
    if (this.closed) throw new Error('Agent 运行时已关闭');
    if (!this.services) throw new Error('Agent 尚未初始化');
    return this.services;
  }

  private assertIdle(): void {
    if (this.activeRun || this.changing) throw new Error('Agent 正在运行或更新配置，请稍后重试');
  }

  snapshot(): RuntimeSnapshot {
    const services = this.ready();
    return structuredClone({
      id: this.sessionId,
      history: services.agent.history.filter((message) => message.role !== 'system'),
      interrupted: services.interrupted,
      created: false,
      selection: services.selection,
      capability: services.capability,
      credentialStatus: services.credentials.status(services.selection.provider),
      workspaceRoot: services.workspace.root,
      extraWritable: services.workspace.listWritable().length - 1,
      permissionMode: services.permissions.getMode(),
      todos: services.todos.list(),
      metrics: services.agent.metrics,
      running: !!this.activeRun,
      pendingApprovals: this.approvals.list(),
    });
  }

  private publishState(): void {
    if (!this.closed) this.emit({ type: 'state', state: this.snapshot() });
  }

  async dispatch<C extends Command>(command: C): Promise<CommandResult<C>> {
    this.ready();
    return (await this.execute(command)) as CommandResult<C>;
  }

  private async execute(command: Command): Promise<unknown> {
    const services = this.ready();
    switch (command.type) {
      case 'run':
        return this.run(command.input);
      case 'cancel':
        this.cancel();
        return;
      case 'sessions.list':
        return this.listSessions();
      case 'sessions.switch':
        return this.update(() => this.switchSession(command.id));
      case 'sessions.delete':
        return this.update(() => this.deleteSession(command.id));
      case 'sessions.reset':
        return this.update(async () => {
          services.agent.history.splice(1);
          await saveSession(services.project.session(this.sessionId), services.agent.history);
          await services.todos.clear();
          await rm(services.project.path('compactions', `${this.sessionId}.json`), { force: true });
          await rm(services.project.path('journals', `${this.sessionId}.json`), { force: true });
          services.interrupted = false;
        });
      case 'models.providers':
        return PROVIDERS.map((provider) => ({
          ...provider,
          credentialStatus: services.credentials.status(provider.id),
        }));
      case 'models.discover':
        return discoverModels({
          providerId: command.provider,
          key: services.credentials.get(command.provider),
          ...(command.provider === services.selection.provider
            ? { baseURL: services.selection.baseURL }
            : {}),
        });
      case 'models.select':
        return this.update(async () => {
          providerById(command.provider);
          if (!command.model.trim() || command.model.length > 300)
            throw new Error('Invalid model ID');
          const selection = {
            provider: command.provider,
            model: command.model,
            ...(services.selection.provider === command.provider && services.selection.baseURL
              ? { baseURL: services.selection.baseURL }
              : {}),
          };
          const key = services.credentials.get(command.provider);
          const model = services.createModel(selection, key);
          const capability = await services.capabilityFor(selection, key);
          await saveSelection(this.config.selectionPath, selection);
          model.setMaxOutputTokens?.(capability.outputReserve);
          services.agent.setModel(model);
          services.context.setCapability(capability);
          services.selection = selection;
          services.capability = capability;
          return capability;
        });
      case 'credentials.set':
        return this.update(async () => {
          await services.credentials.set(command.provider, command.key, command.persist);
          if (command.provider === services.selection.provider) {
            const model = services.createModel(
              services.selection,
              services.credentials.get(command.provider),
            );
            model.setMaxOutputTokens?.(services.capability.outputReserve);
            services.agent.setModel(model);
          }
        });
      case 'permissions.set':
        return this.update(async () => services.permissions.setMode(command.mode));
      case 'workspace.status':
        return { root: services.workspace.root, writable: services.workspace.listWritable() };
      case 'workspace.grant':
        return this.update(() => this.addDirectory(command.path));
      case 'tools.list':
        return services.registry.list().map((tool) => tool.name);
      case 'memories.list':
        return services.memory.list(command.scope);
      case 'artifacts.list':
        return this.artifacts();
      case 'artifacts.read':
        return services.artifacts.page(command.id, command.offset, command.limit);
      case 'approvals.respond': {
        if (!this.approvals.respond(command.id, command.accepted))
          throw new Error('审批已结束或不存在');
        return;
      }
    }
  }

  private update<T>(action: () => Promise<T>): Promise<T> {
    this.assertIdle();
    this.changing = true;
    const update = Promise.resolve()
      .then(action)
      .finally(() => {
        this.changing = false;
        this.updating = undefined;
        this.publishState();
      });
    this.updating = update;
    return update;
  }

  private run(input: string): Promise<string> {
    const services = this.ready();
    this.assertIdle();
    if (!input.trim() || input.length > this.config.maxInputChars)
      throw new Error(`输入长度必须为 1–${this.config.maxInputChars} 个字符`);
    this.controller = new AbortController();
    // Schedule the loop after assigning activeRun, so synchronous subscribers see running=true.
    const task = Promise.resolve().then(() => services.agent.run(input));
    const finished = this.finishRun(task, services);
    this.activeRun = finished;
    this.publishState();
    return finished;
  }

  private async finishRun(task: Promise<string>, services: RuntimeServices): Promise<string> {
    try {
      const result = await task;
      services.interrupted = false;
      return result;
    } catch (error) {
      services.interrupted = true;
      this.emit({ type: 'run_error', text: String(error) });
      throw error;
    } finally {
      try {
        await saveSession(services.project.session(this.sessionId), services.agent.history);
      } finally {
        this.controller = undefined;
        this.activeRun = undefined;
        this.publishState();
      }
    }
  }

  private cancel(): void {
    this.controller?.abort(new Error('Task cancelled'));
    this.approvals.cancelAll();
  }

  private async listSessions(): Promise<string[]> {
    const services = this.ready();
    return (await readdir(services.project.path('sessions')))
      .filter((name) => /^[a-zA-Z0-9_-]{1,64}\.json$/.test(name))
      .map((name) => name.slice(0, -5))
      .sort();
  }

  private async switchSession(id: string): Promise<SessionView> {
    const services = this.ready();
    const path = services.project.session(id);
    if (id === this.sessionId) return { ...this.snapshot(), created: false };
    await saveSession(services.project.session(this.sessionId), services.agent.history);
    const saved = await loadSession(path);
    const history: Message[] = [
      { role: 'system', content: services.system },
      ...(saved ?? []).filter((message) => message.role !== 'system'),
    ];
    const todos = await TodoStore.open(services.project.path('todos', `${id}.json`));
    const journal = new ExecutionJournal(services.project.path('journals', `${id}.json`));
    const previous = await journal.load();
    const context = services.createContext(id);
    context.setCapability(services.capability);
    await saveSession(path, history);
    services.agent.history.splice(0, services.agent.history.length, ...history);
    services.agent.setContext(context);
    services.agent.setJournal(journal);
    services.context = context;
    for (const name of ['todo_list', 'todo_add', 'todo_update']) services.registry.unregister(name);
    registerTodoTools(services.registry, todos);
    services.todos = todos;
    services.permissions.setAuditPath(services.project.path('approvals', `${id}.jsonl`));
    services.interrupted = !!previous && previous.status !== 'completed';
    this.sessionId = id;
    return {
      id,
      history: this.snapshot().history,
      created: !saved,
      interrupted: services.interrupted,
    };
  }

  private async deleteSession(id: string): Promise<SessionView | undefined> {
    const services = this.ready();
    await stat(services.project.session(id));
    let next: SessionView | undefined;
    if (id === this.sessionId) {
      const fallback =
        id !== 'default'
          ? 'default'
          : ((await this.listSessions()).find((name) => name !== id) ?? `session_${Date.now()}`);
      next = await this.switchSession(fallback);
    }
    await services.project.deleteSession(id);
    return next;
  }

  private async addDirectory(requested: string): Promise<{ accepted: boolean; path?: string }> {
    const services = this.ready();
    const target = await services.workspace.safePath(requested);
    let missing = false;
    try {
      if (!(await stat(target)).isDirectory()) throw new Error('该路径不是目录');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = true;
    }
    const tool = services.registry.list().find((tool) => tool.name === 'request_write_directory');
    if (!tool) throw new Error('Directory authorization tool is unavailable');
    const accepted = await services.permissions.authorize(tool, {
      path: target,
      createIfMissing: missing,
    });
    if (!accepted.allowed || this.closed) return { accepted: false };
    return { accepted: true, path: await services.workspace.addDirectory(target, missing) };
  }

  private artifacts() {
    const calls = new Map<string, string>();
    const result: Array<{ id: string; name: string }> = [];
    for (const message of this.ready().agent.history) {
      if (message.role === 'assistant')
        for (const call of message.tool_calls ?? []) calls.set(call.id, call.function.name);
      if (message.role === 'tool') {
        const id = /^\[ARCHIVED id=([^\s\]]+)/.exec(message.content)?.[1];
        if (id) result.push({ id, name: calls.get(message.tool_call_id) ?? 'tool' });
      }
    }
    return result;
  }

  close(): Promise<void> {
    this.shutdown ??= this.stop();
    return this.shutdown;
  }

  private async stop(): Promise<void> {
    this.closed = true;
    this.cancel();
    await this.startup?.catch(() => {});
    await this.activeRun?.catch(() => {});
    await this.updating?.catch(() => {});
    // Wait for run persistence and configuration updates before closing external tools.
    await this.services?.close();
    this.listeners.clear();
  }
}
