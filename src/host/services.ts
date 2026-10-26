import { FilePermissionAudit } from '../infra/permissions/file-audit.js';
import { FileTaskPersistence } from '../infra/storage/task-persistence.js';
import { FileDeliveryChecker } from '../infra/verification/files.js';
import { createNodeExecutors } from '../app/nodes/catalog.js';
import { validateExecutors } from '../app/nodes/validate.js';
import type { ExecutionServices } from '../app/ports.js';
import type { ContextOptions } from '../core/context/types.js';
import { resolve } from 'node:path';
import { Agent } from '../core/agent.js';
import { ToolRegistry } from '../core/tools/registry.js';
import { PermissionManager } from '../core/permissions/manager.js';
import { loadSelection, modelFor, type Selection } from '../adapters/models/providers.js';
import { resolveContextCapability } from '../adapters/models/capabilities.js';
import { ContextManager } from '../core/context/manager.js';
import { WorkflowLibrary } from '../infra/configuration/workflows.js';
import { registerConfiguredTools } from '../infra/configuration/configured-tools.js';
import type { Model } from '../core/model/types.js';
import { Workspace } from '../infra/workspace/files.js';
import { ProjectState } from '../infra/workspace/project-state.js';
import { CredentialStore } from '../infra/configuration/credentials.js';
import { ScopedMemory } from '../infra/storage/scoped-memory.js';
import { TodoStore } from '../infra/storage/todo-store.js';
import { registerTodoTools } from '../tools/todos.js';
import { ToolArtifacts } from '../infra/storage/tool-artifacts.js';
import { registerArtifactTools } from '../tools/artifacts.js';
import { CompactionStore } from '../infra/storage/compaction.js';
import { ExecutionJournal } from '../infra/storage/execution-journal.js';
import { loadSession } from '../infra/storage/session-store.js';
import { loadLayeredSettings } from '../infra/configuration/layered-settings.js';
import { connectProjectMcp } from '../infra/extensions/project-mcp.js';
import { connectMcpStdio } from '../infra/extensions/mcp.js';
import { approvalPreview } from '../infra/permissions/approval-preview.js';
import { registerWorkspaceTools } from '../tools/workspace.js';
import { registerLocalTools } from '../tools/local.js';
import { registerCommandTools } from '../tools/command.js';
import { registerMemoryTools } from '../tools/memory.js';
import { registerHistoryTools } from '../tools/history.js';
import { systemPrompt } from './system-prompt.js';
import type { RuntimeConfig } from './config.js';
import type { ApprovalView, RuntimeEvent } from '../protocol/contracts.js';

import type { RuntimeDependencies } from './dependencies.js';
export type { RuntimeDependencies } from './dependencies.js';

export async function createServices(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies,
  emit: (event: RuntimeEvent) => void,
  askApproval: (view: ApprovalView) => Promise<boolean>,
  getSignal: () => AbortSignal | undefined,
) {
  const workspace = await Workspace.create(config.root);
  const project = await ProjectState.open(workspace.root);
  project.session(config.sessionId);
  const registry = new ToolRegistry();
  const toolsets = dependencies.toolsets ?? {};
  const enabled = (name: import('./dependencies.js').BuiltinToolset) => toolsets[name] !== false;
  const nodeExecutors = createNodeExecutors(dependencies.nodeExecutors);
  const workflows = await (
    dependencies.createWorkflows ??
    (async ({ file }) => {
      const library = new WorkflowLibrary(file);
      await library.load();
      return library;
    })
  )({ file: project.path('workflows.json') });
  for (const workflow of workflows.list()) validateExecutors(workflow, nodeExecutors);
  const persistence = await (
    dependencies.createPersistence ?? (({ project }) => new FileTaskPersistence(project))
  )({ project });
  const deliveries = (
    dependencies.createDelivery ?? (({ workspace }) => new FileDeliveryChecker(workspace))
  )({ workspace });
  const credentials = await CredentialStore.open(config.credentialsPath);
  const selection = await loadSelection(config.selectionPath);
  const audit = new FilePermissionAudit(project.path('approvals', `${config.sessionId}.jsonl`));
  const permissions = (
    dependencies.createPermissions ??
    (({ audit, present }) => new PermissionManager(audit, present))
  )({
    audit,
    present: async (request) => {
      try {
        return await askApproval({ request, preview: await approvalPreview(request, workspace) });
      } catch (error) {
        emit({ type: 'notice', level: 'error', text: `无法预览审批：${String(error)}` });
        return false;
      }
    },
  });
  permissions.subscribe((event) => emit({ type: 'permission', event }));
  registry.setPermissions(permissions);
  if (enabled('workspace')) registerWorkspaceTools(registry, workspace);
  if (enabled('files')) registerLocalTools(registry, workspace);
  if (enabled('command')) registerCommandTools(registry, workspace);
  const artifacts = new ToolArtifacts(config.artifactDirectory ?? project.path('artifacts'));
  if (enabled('artifacts')) registerArtifactTools(registry, artifacts);
  const memory = await (
    dependencies.createMemory ??
    (({ projectFile, globalFile }) => ScopedMemory.open(projectFile, globalFile))
  )({
    projectFile: config.memoryPath ?? project.path('memories.json'),
    globalFile: config.globalMemoryPath,
  });
  if (enabled('memory')) registerMemoryTools(registry, memory);
  const settings = await loadLayeredSettings(
    project.path('settings.json'),
    resolve(config.configDirectory, 'settings.json'),
  );
  const contextSettings = {
    ...settings.context,
    summarize: config.summarize ?? settings.context?.summarize ?? true,
    compactThreshold: config.compactThreshold ?? settings.context?.compactThreshold ?? 0.8,
  };
  const createModel = dependencies.createModel ?? modelFor;
  registry.setGuard((name) => {
    if (contextSettings.generateMemory === false && ['memory_save', 'memory_update'].includes(name))
      throw new Error('Memory generation is disabled');
    if (contextSettings.applyMemory === false && ['memory_search', 'memory_list'].includes(name))
      throw new Error('Memory application is disabled');
  });
  const capabilityFor =
    dependencies.resolveCapability ??
    ((choice: Selection, key?: string) =>
      resolveContextCapability(choice, {
        key,
        windowOverride: settings.context?.maxInputTokens ?? config.contextWindow,
        outputReserve: settings.context?.reservedOutputTokens ?? config.outputReserve,
      }));
  let model: Model;
  try {
    model = createModel(selection, credentials.get(selection.provider));
  } catch (error) {
    const reason = String(error);
    model = {
      async complete() {
        throw new Error(reason);
      },
    };
    emit({ type: 'notice', level: 'error', text: reason });
  }
  const capability = await capabilityFor(selection, credentials.get(selection.provider));
  const defaultPrompt = await systemPrompt(project, config.configDirectory);
  const system = dependencies.createSystemPrompt
    ? await dependencies.createSystemPrompt({ workspaceRoot: workspace.root, defaultPrompt })
    : defaultPrompt;
  const createContext = (id: string, options: ContextOptions = contextSettings) =>
    (
      dependencies.createContext ??
      (({ options, memory, compactions }) => new ContextManager(options, memory, compactions))
    )({
      sessionId: id,
      options: structuredClone(options),
      memory,
      compactions: new CompactionStore(project.path('compactions', `${id}.json`)),
    });
  const context = createContext(config.sessionId);
  context.setCapability(capability);
  model.setMaxOutputTokens?.(capability.outputReserve);
  const todos = await TodoStore.open(project.path('todos', `${config.sessionId}.json`));
  if (enabled('todos')) registerTodoTools(registry, todos);
  const journal = new ExecutionJournal(project.path('journals', `${config.sessionId}.json`));
  const previous = await journal.load();
  const agent = (
    dependencies.createAgent ??
    (({ model, tools, system, options, history }) =>
      new Agent(model, tools, system, options, history))
  )({
    model,
    tools: registry,
    system,
    options: {
      context,
      artifacts: enabled('artifacts') ? artifacts : undefined,
      journal,
      onProgress: (event) => emit({ type: 'agent', event }),
      onMessage: (message) => emit({ type: 'message', message }),
      get signal() {
        return getSignal();
      },
    },
    history: (await loadSession(project.session(config.sessionId))) ?? [],
  });
  if (enabled('history')) registerHistoryTools(registry, agent.history);
  for (const tool of dependencies.tools ?? []) registry.register(tool);

  // Connect external processes last; earlier initialization failures need no process cleanup.
  const closers: Array<() => Promise<void>> = [];
  const report = (text: string) => emit({ type: 'notice', level: 'error', text });
  try {
    if (enabled('mcp'))
      closers.push(
        await connectProjectMcp(
          registry,
          project,
          resolve(config.configDirectory, 'mcp.json'),
          report,
        ),
      );
    if (enabled('mcp') && config.mcpCommand)
      closers.push(await connectMcpStdio(registry, config.mcpCommand, config.mcpArgs));
    const moduleIds = new Set<string>();
    for (const module of dependencies.modules ?? []) {
      if (!module.id.trim() || moduleIds.has(module.id))
        throw new Error(`Duplicate or empty module ID: ${module.id}`);
      moduleIds.add(module.id);
      const dispose = await module.setup({
        workspaceRoot: workspace.root,
        registerTool: (tool) => registry.register(tool),
        signal: getSignal,
      });
      if (dispose)
        closers.push(async () => {
          await dispose();
        });
    }
    if (enabled('configured')) await registerConfiguredTools(registry, project.path('tools.json'));
    if (
      registry
        .list()
        .some((tool) => ['submit_delivery_checklist', 'task_plan_update'].includes(tool.name))
    )
      throw new Error(
        'submit_delivery_checklist and task_plan_update are reserved kernel tool names',
      );
  } catch (error) {
    for (const close of [...closers].reverse()) await close().catch(() => {});
    throw error;
  }
  return {
    persistence,
    deliveries,
    nodeExecutors,
    audit,
    enabled,
    workspace,
    workflows,
    confirmPlan: config.confirmPlan,
    settings,
    contextSettings,
    project,
    registry,
    credentials,
    permissions,
    artifacts,
    memory,
    todos,
    journal,
    agent,
    context,
    selection,
    capability,
    system,
    createModel,
    capabilityFor,
    createContext,
    interrupted: !!previous && previous.status !== 'completed',
    async close() {
      for (const close of closers.splice(0).reverse()) await close().catch(() => {});
    },
  } satisfies ExecutionServices & Record<string, unknown>;
}

export type RuntimeServices = Awaited<ReturnType<typeof createServices>>;
