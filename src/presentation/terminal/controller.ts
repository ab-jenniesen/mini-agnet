import type { AgentClient, RuntimeEvent } from '../../app/contracts.js';
import { initialPresentationState, reducePresentation } from '../view-model.js';
import { helpText, routeInput } from '../command-router.js';
import { autocomplete } from './autocomplete.js';
import { ModelDialogs } from './model-dialogs.js';
import { TerminalView } from './view.js';

/** Coordinates views and application commands; all Agent behavior stays behind AgentClient. */
export class TerminalController {
  private state = initialPresentationState();
  private readonly models: ModelDialogs;
  private unsubscribe?: () => void;
  private submitting = false;
  private stopped = false;
  private approvalId?: string;
  private exitResolve?: () => void;
  private readonly exited = new Promise<void>((resolve) => {
    this.exitResolve = resolve;
  });

  constructor(
    private readonly client: AgentClient,
    readonly view: TerminalView,
  ) {
    this.models = new ModelDialogs(client, view, () => this.state.snapshot);
    view.onSubmit = (input) => {
      void this.submit(input);
    };
    view.onCancel = () => {
      void client
        .dispatch({ type: 'cancel' })
        .catch((error) => view.status('error', String(error)));
    };
    view.onExit = () => this.exitResolve?.();
  }

  async start(initialInput?: string): Promise<void> {
    this.unsubscribe = this.client.subscribe((event) => this.receive(event));
    this.view.start();
    const snapshot = await this.client.initialize();
    if (this.stopped) return;
    const providers = await this.client.dispatch({ type: 'models.providers' });
    this.view.editor.setAutocompleteProvider(
      autocomplete(this.client, providers, snapshot.workspaceRoot),
    );
    this.view.status(
      snapshot.interrupted || snapshot.credentialStatus === 'missing' ? 'warning' : 'info',
      snapshot.credentialStatus === 'missing'
        ? `请用 /key ${snapshot.selection.provider} 配置 API Key，或 /model 选择供应商`
        : snapshot.interrupted
          ? '上次执行被中断，请先检查未完成操作'
          : '已就绪 · 输入 / 查看命令',
    );
    if (initialInput) await this.submit(initialInput);
  }

  private receive(event: RuntimeEvent): void {
    if (this.stopped) return;
    this.state = reducePresentation(this.state, event);
    if (
      event.type === 'notice' ||
      (event.type === 'agent' &&
        (event.event.type === 'context' || event.event.type === 'thinking'))
    )
      this.view.clearStatus();
    this.view.update(this.state);
    const approval = this.state.approval;
    if (!approval && this.approvalId) {
      this.approvalId = undefined;
      this.view.closeDialog();
    }
    if (approval && approval.request.id !== this.approvalId) {
      this.approvalId = approval.request.id;
      void this.view
        .confirm(`授权请求：${approval.request.name}`, approval.preview)
        .then((accepted) => {
          if (this.stopped || this.approvalId !== approval.request.id) return;
          return this.client.dispatch({
            type: 'approvals.respond',
            id: approval.request.id,
            accepted,
          });
        })
        .catch((error) => this.view.status('error', String(error)));
    }
  }

  async submit(input: string): Promise<void> {
    if (this.stopped || this.submitting || !input.trim() || !this.state.snapshot) return;
    this.submitting = true;
    this.view.editor.disableSubmit = true;
    this.view.editor.addToHistory(input);
    this.view.closeDialog();
    this.view.clearStatus();
    try {
      const effect = await routeInput(input, this.client, this.state.snapshot);
      if (this.stopped) return;
      switch (effect.type) {
        case 'exit':
          this.exitResolve?.();
          break;
        case 'help':
          this.view.toggleHelp(helpText());
          break;
        case 'providers':
          await this.models.providers();
          break;
        case 'models':
          await this.models.models(effect.provider);
          break;
        case 'key':
          await this.models.key(effect.provider);
          break;
        case 'thinking':
          this.view.cycleThinking(effect.mode);
          break;
        case 'status':
          this.view.status('info', effect.text);
          break;
        case 'panel':
          this.view.panel(effect.title, effect.text);
          break;
        case 'close-output':
          this.view.closeDialog();
          break;
        case 'output':
          await this.openOutput(effect.id, effect.offset);
          break;
        case 'delete-session':
          if (
            await this.view.confirm(
              `删除会话 ${effect.id}？`,
              '将删除该会话的对话、Todo、压缩摘要、执行日志和审批记录。',
            )
          ) {
            await this.client.dispatch({ type: 'sessions.delete', id: effect.id });
            this.view.status('info', `已删除会话 ${effect.id}`);
          }
          break;
        case 'run':
          await this.client.dispatch({ type: 'run', input: effect.input });
          break;
      }
    } catch (error) {
      if (!this.stopped)
        this.view.status('error', error instanceof Error ? error.message : String(error));
    } finally {
      this.submitting = false;
      this.view.editor.disableSubmit = !this.state.snapshot || this.state.snapshot.running;
      this.view.tui.requestRender();
    }
  }

  private async openOutput(id: string, offset: number): Promise<void> {
    const page = await this.client.dispatch({ type: 'artifacts.read', id, offset, limit: 3000 });
    if (this.stopped) return;
    const open = (nextOffset: number) => {
      void this.openOutput(id, nextOffset).catch((error) =>
        this.view.status('error', String(error)),
      );
    };
    this.view.panel(`归档 ${id} · ${page.offset}–${page.next}/${page.total}`, page.content, {
      next: page.next < page.total ? () => open(page.next) : undefined,
      previous: page.offset > 0 ? () => open(Math.max(0, page.offset - 3000)) : undefined,
    });
  }

  waitUntilExit(): Promise<void> {
    return this.exited;
  }
  requestExit(): void {
    this.exitResolve?.();
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.view.stop();
    this.exitResolve?.();
    await this.client.close();
  }
}
