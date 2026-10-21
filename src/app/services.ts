import { resolve } from 'node:path';
import { Agent } from '../core/agent.js';
import { ToolRegistry } from '../core/registry.js';
import { PermissionManager } from '../core/permissions/manager.js';
import { loadSelection, modelFor, type Selection } from '../core/providers.js';
import { resolveContextCapability, type ContextCapability } from '../core/context/capabilities.js';
import { ContextManager } from '../core/context/manager.js';
import type { Model } from '../core/types.js';
import { Workspace } from '../infra/files.js';
import { ProjectState } from '../infra/project-state.js';
import { CredentialStore } from '../infra/credentials.js';
import { ScopedMemory } from '../infra/scoped-memory.js';
import { TodoStore, registerTodoTools } from '../infra/todos.js';
import { ToolArtifacts, registerArtifactTools } from '../infra/tool-artifacts.js';
import { CompactionStore } from '../infra/compaction.js';
import { ExecutionJournal } from '../infra/execution-journal.js';
import { loadSession } from '../infra/memory.js';
import { loadLayeredSettings } from '../infra/layered-settings.js';
import { connectProjectMcp } from '../infra/project-mcp.js';
import { connectMcpStdio } from '../infra/mcp.js';
import { approvalPreview } from '../infra/approval-preview.js';
import { registerWorkspaceTools } from '../tools/workspace.js';
import { registerLocalTools } from '../tools/local.js';
import { registerCommandTools } from '../tools/command.js';
import { registerMemoryTools } from '../tools/memory.js';
import { registerHistoryTools } from '../tools/history.js';
import { systemPrompt } from './system-prompt.js';
import type { RuntimeConfig } from './config.js';
import type { ApprovalView, RuntimeEvent } from './contracts.js';

export type RuntimeDependencies = {
  createModel?: (selection: Selection, key?: string) => Model;
  resolveCapability?: (selection: Selection, key?: string) => Promise<ContextCapability>;
};

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
  const credentials = await CredentialStore.open(config.credentialsPath);
  const selection = await loadSelection(config.selectionPath);
  const permissions = new PermissionManager(
    project.path('approvals', `${config.sessionId}.jsonl`),
    async (request) => {
      try {
        return await askApproval({ request, preview: await approvalPreview(request, workspace) });
      } catch (error) {
        emit({ type: 'notice', level: 'error', text: `无法预览审批：${String(error)}` });
        return false;
      }
    },
  );
  permissions.subscribe((event) => emit({ type: 'permission', event }));
  registry.setPermissions(permissions);
  registerWorkspaceTools(registry, workspace);
  registerLocalTools(registry, workspace);
  registerCommandTools(registry, workspace);
  const artifacts = new ToolArtifacts(config.artifactDirectory ?? project.path('artifacts'));
  registerArtifactTools(registry, artifacts);
  const memory = await ScopedMemory.open(
    config.memoryPath ?? project.path('memories.json'),
    config.globalMemoryPath,
  );
  registerMemoryTools(registry, memory);
  const settings = await loadLayeredSettings(
    project.path('settings.json'),
    resolve(config.configDirectory, 'settings.json'),
  );
  const contextSettings = {
    summarize: config.summarize ?? settings.context?.summarize ?? true,
    compactThreshold: config.compactThreshold ?? settings.context?.compactThreshold ?? 0.8,
  };
  const createModel = dependencies.createModel ?? modelFor;
  const capabilityFor =
    dependencies.resolveCapability ??
    ((choice: Selection, key?: string) =>
      resolveContextCapability(choice, {
        key,
        windowOverride: config.contextWindow,
        outputReserve: config.outputReserve,
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
  const system = await systemPrompt(project, config.configDirectory);
  const createContext = (id: string) => {
    const context = new ContextManager(
      contextSettings,
      memory,
      new CompactionStore(project.path('compactions', `${id}.json`)),
    );
    return context;
  };
  const context = createContext(config.sessionId);
  context.setCapability(capability);
  model.setMaxOutputTokens?.(capability.outputReserve);
  const todos = await TodoStore.open(project.path('todos', `${config.sessionId}.json`));
  registerTodoTools(registry, todos);
  const journal = new ExecutionJournal(project.path('journals', `${config.sessionId}.json`));
  const previous = await journal.load();
  const agent = new Agent(
    model,
    registry,
    system,
    {
      maxSteps: config.maxSteps,
      context,
      artifacts,
      journal,
      onProgress: (event) => emit({ type: 'agent', event }),
      onMessage: (message) => emit({ type: 'message', message }),
      get signal() {
        return getSignal();
      },
    },
    await loadSession(project.session(config.sessionId)),
  );
  registerHistoryTools(registry, agent.history);

  // Connect external processes last; earlier initialization failures need no process cleanup.
  const closers: Array<() => Promise<void>> = [];
  const report = (text: string) => emit({ type: 'notice', level: 'error', text });
  try {
    closers.push(
      await connectProjectMcp(
        registry,
        project,
        resolve(config.configDirectory, 'mcp.json'),
        report,
      ),
    );
    if (config.mcpCommand)
      closers.push(await connectMcpStdio(registry, config.mcpCommand, config.mcpArgs));
  } catch (error) {
    await Promise.allSettled(closers.map((close) => close()));
    throw error;
  }
  return {
    workspace,
    project,
    registry,
    credentials,
    permissions,
    artifacts,
    memory,
    todos,
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
      await Promise.allSettled(closers.reverse().map((close) => close()));
    },
  };
}

export type RuntimeServices = Awaited<ReturnType<typeof createServices>>;
