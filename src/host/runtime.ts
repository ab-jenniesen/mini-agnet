import { validateExecutors } from '../app/nodes/validate.js';
import { readdir, stat, rm } from 'node:fs/promises';
import { PROVIDERS, providerById, saveSelection } from '../adapters/models/providers.js';
import { discoverModels } from '../adapters/models/discovery.js';
import type { Message } from '../core/model/types.js';
import { TodoStore } from '../infra/storage/todo-store.js';
import { registerTodoTools } from '../tools/todos.js';
import { ExecutionJournal } from '../infra/storage/execution-journal.js';
import { contextSettingsSchema } from '../core/context/settings.js';
import { atomicJson } from '../infra/storage/atomic-json.js';
import { commandSchema } from '../protocol/commands.js';
import { loadSession, saveSession } from '../infra/storage/session-store.js';
import { ApprovalQueue } from './approvals.js';
import { runtimeConfig, type RuntimeConfig } from './config.js';
import { createServices, type RuntimeServices, type RuntimeDependencies } from './services.js';
import { TaskRunner } from '../app/tasks/runner.js';
import { TaskExecutionError, type TaskResult } from '../core/execution/result.js';
import type {
  AgentClient,
  Command,
  CommandResult,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionView,
} from '../protocol/contracts.js';

export type {
  RuntimeEvent,
  RuntimeSnapshot,
  SessionView,
  ApprovalView,
} from '../protocol/contracts.js';

export type RuntimeOptions = Partial<RuntimeConfig> & { dependencies?: RuntimeDependencies };

/** Application host. All interfaces use the same command and event contract. */
export class AgentRuntime implements AgentClient {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly approvals = new ApprovalQueue((event) => {
    this.runner?.approvalChanged(this.approvals.list().length > 0);
    this.emit(event);
  });
  private readonly config: RuntimeConfig;
  private services?: RuntimeServices;
  private startup?: Promise<RuntimeSnapshot>;
  private runner?: TaskRunner;
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
    const outgoing: RuntimeEvent = {
      ...event,
      scope: event.scope ?? { sessionId: this.sessionId, ...this.runner?.scope },
    };
    // A broken view must not abort model execution or prevent another client receiving events.
    for (const listener of [...this.listeners, ...(this.options.dependencies?.observers ?? [])]) {
      try {
        listener(structuredClone(outgoing));
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
        this.runner?.observe(event);
        this.emit(event);
        if (event.type === 'agent' && event.event.type === 'tool_end') this.publishState();
      },
      (view) => this.approvals.request(view, this.runner?.signal),
      () => this.runner?.signal,
    );
    if (this.closed) {
      await this.services.close();
      throw new Error('Agent 运行时已关闭');
    }
    try {
      this.runner = new TaskRunner(
        this.services,
        () => this.sessionId,
        (event) => {
          this.emit(event);
          this.publishState();
        },
      );
      await this.runner.restore();
      await saveSession(this.services.project.session(this.sessionId), this.services.agent.history);
      this.publishState();
      return this.snapshot();
    } catch (error) {
      await this.services.close();
      throw error;
    }
  }

  private ready(): RuntimeServices {
    if (this.closed) throw new Error('Agent 运行时已关闭');
    if (!this.services) throw new Error('Agent 尚未初始化');
    return this.services;
  }

  private assertIdle(): void {
    if (this.runner?.running || this.changing)
      throw new Error('Agent 正在运行或更新配置，请稍后重试');
  }

  snapshot(): RuntimeSnapshot {
    const services = this.ready();
    return structuredClone({
      protocolVersion: 2,
      execution: this.runner?.execution,
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
      metrics: this.runner?.metrics ?? services.agent.metrics,
      running: !!this.runner?.running,
      task: this.runner?.snapshot,
      pendingApprovals: this.approvals.list(),
    });
  }

  private publishState(): void {
    if (!this.closed) this.emit({ type: 'state', state: this.snapshot() });
  }

  async dispatch<C extends Command>(command: C): Promise<CommandResult<C>> {
    this.ready();
    return (await this.execute(commandSchema.parse(command))) as CommandResult<C>;
  }

  private async execute(command: Command): Promise<unknown> {
    const services = this.ready();
    switch (command.type) {
      case 'run':
        return this.run(command.input).then((result) => {
          if (result.status !== 'completed') throw new TaskExecutionError(result);
          return result.summary;
        });
      case 'tasks.run':
        return this.run(command.input);
      case 'tasks.current':
        return this.runner?.snapshot;
      case 'tasks.list':
        return this.runner!.list();
      case 'tasks.create':
        this.validateInput(command.input);
        return this.update(() => this.runner!.create(command.input, command.workflowId));
      case 'tasks.select':
        return this.update(() => this.runner!.select(command.id));
      case 'tasks.continue':
        this.assertIdle();
        this.validateInput(command.input ?? '', true);
        return this.runner!.run(command.input ?? '', command.id);
      case 'tasks.cancel':
        if (this.runner?.activeTaskId === command.id) this.approvals.cancelAll();
        return this.update(() => this.runner!.cancelTask(command.id), true);
      case 'execution.get':
        return this.runner!.execution;
      case 'runs.get': {
        const run = this.runner!.execution!.runs.find((item) => item.id === command.id);
        if (!run) throw new Error('执行不存在');
        return run;
      }
      case 'runs.pause':
        if (!this.runner?.running) throw new Error('当前没有运行中的执行');
        this.runner!.pause();
        return;
      case 'runs.resume':
        this.assertIdle();
        return this.runner!.resume(command.id, command.confirmReplay);
      case 'waits.respond':
        return this.update(() => this.runner!.respond(command.id, command.response));
      case 'workflows.list':
        return services.workflows.list();
      case 'workflows.register':
        return this.update(() =>
          services.workflows.register(
            validateExecutors(command.definition, services.nodeExecutors),
          ),
        );
      case 'workflows.select':
        return this.update(() => this.runner!.selectWorkflow(command.id));
      case 'context.get':
        return {
          ...structuredClone(services.context.options),
          maxInputTokens: services.capability.contextWindow,
          reservedOutputTokens: services.capability.outputReserve,
        };
      case 'runtime.capabilities':
        return {
          protocolVersion: 2,
          nodeTypes: ['agent', 'model', 'tool', 'human'],
          nodeExecutors: services.nodeExecutors.names(),
          execution: 'sequential',
          checkpoints: 'node_boundaries',
          isolation: 'application',
          eventReplay: false,
        };
      case 'tools.describe':
        return structuredClone(
          services.registry.list().map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            write: !!tool.write,
          })),
        );
      case 'context.configure':
        return this.update(async () => {
          const settings = contextSettingsSchema.parse({
            ...services.context.options,
            maxInputTokens: services.capability.contextWindow,
            reservedOutputTokens: services.capability.outputReserve,
            ...command.settings,
          });
          const context = services.createContext(this.sessionId, settings);
          const capability = {
            ...services.capability,
            contextWindow: settings.maxInputTokens ?? services.capability.contextWindow,
            outputReserve: settings.reservedOutputTokens ?? services.capability.outputReserve,
          };
          if (capability.outputReserve + 256 >= capability.contextWindow)
            throw new Error('输出预留超过上下文窗口');
          await atomicJson(services.project.path('settings.json'), {
            ...services.settings,
            context: settings,
          });
          Object.assign(services.contextSettings, settings);
          services.settings.context = settings;
          services.context = context;
          context.setCapability(capability);
          services.capability = capability;
          services.agent.setContext(context);
          services.agent.getModel().setMaxOutputTokens?.(capability.outputReserve);
          return structuredClone(context.options);
        });
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
          await rm(services.project.path('tasks', `${this.sessionId}.json`), { force: true });
          await services.persistence.reset(this.sessionId);
          this.runner?.reset();
          await this.runner?.restore();
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

  private update<T>(action: () => Promise<T>, allowRunning = false): Promise<T> {
    if (allowRunning) {
      if (this.changing) throw new Error('正在修改运行时状态，请稍后重试');
    } else this.assertIdle();
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

  private run(input: string): Promise<TaskResult> {
    this.assertIdle();
    this.validateInput(input);
    return this.runner!.run(input);
  }

  private validateInput(input: string, allowEmpty = false): void {
    if ((!allowEmpty && !input.trim()) || input.length > this.config.maxInputChars)
      throw new Error(
        `输入长度必须为 ${allowEmpty ? '0' : '1'}–${this.config.maxInputChars} 个字符`,
      );
  }

  private cancel(): void {
    this.runner?.cancel();
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
    services.journal = journal;
    services.context = context;
    for (const name of ['todo_list', 'todo_add', 'todo_update']) services.registry.unregister(name);
    if (services.enabled('todos')) registerTodoTools(services.registry, todos);
    services.todos = todos;
    services.audit.setFile(services.project.path('approvals', `${id}.jsonl`));
    services.interrupted = !!previous && previous.status !== 'completed';
    this.sessionId = id;
    await this.runner?.restore();
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
    await services.persistence.reset(id);
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
    await this.runner?.wait().catch(() => {});
    await this.updating?.catch(() => {});
    // Wait for run persistence and configuration updates before closing external tools.
    await this.services?.close();
    this.listeners.clear();
  }
}
