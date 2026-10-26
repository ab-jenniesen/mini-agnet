import type { AgentClient, RuntimeSnapshot } from '../../protocol/index.js';
import type { TerminalView } from './view.js';

/** Model dialogs only collect choices; the host owns providers, credentials and model instances. */
export class ModelDialogs {
  constructor(
    private readonly client: AgentClient,
    private readonly view: TerminalView,
    private readonly state: () => RuntimeSnapshot | undefined,
  ) {}

  async providers(): Promise<void> {
    const providers = await this.client.dispatch({ type: 'models.providers' });
    const provider = await this.view.select(
      '选择模型供应商',
      providers.map((item) => ({
        value: item.id,
        label: `${item.label} (${item.id})`,
        description: item.credentialStatus,
      })),
    );
    if (provider) await this.models(provider);
  }

  async models(provider: string): Promise<void> {
    const providers = await this.client.dispatch({ type: 'models.providers' });
    const item = providers.find((item) => item.id === provider);
    if (!item) throw new Error(`未知供应商：${provider}`);
    this.view.status('info', `正在获取 ${item.label} 模型列表…`);
    const catalog = await this.client.dispatch({ type: 'models.discover', provider });
    const selected = await this.view.select(
      `${item.label} 模型 · ${catalog.source === 'live' ? '在线列表' : '备用列表'}`,
      catalog.models.map((model) => ({
        value: model.id,
        label: model.label,
        description: model.id,
      })),
      '↑↓ 选择 · Enter 确认 · M 手动输入 · R 刷新 · Esc 返回',
      { m: '__manual', r: '__refresh' },
    );
    if (selected === '__refresh') {
      await this.models(provider);
      return;
    }
    const model = selected === '__manual' ? await this.view.prompt('输入模型 ID') : selected;
    if (!model?.trim()) return;
    if (item.credentialStatus === 'missing' && !(await this.key(provider))) return;
    const capability = await this.client.dispatch({
      type: 'models.select',
      provider,
      model: model.trim(),
    });
    this.view.status(
      'info',
      `已切换 ${provider}/${model} · 上下文窗口 ${capability.contextWindow} Token`,
    );
  }

  async key(provider: string): Promise<boolean> {
    const providers = await this.client.dispatch({ type: 'models.providers' });
    const item = providers.find((item) => item.id === provider);
    if (!item) throw new Error(`未知供应商：${provider}`);
    const key = await this.view.prompt(`${item.label} API Key（输入已隐藏）`, true);
    if (key === undefined) return false;
    if (!key.trim()) throw new Error('API Key 不能为空');
    const choice = await this.view.select('密钥保存方式', [
      { value: 'temporary', label: '仅本次运行使用' },
      { value: 'saved', label: '保存到本机凭据文件', description: '明文文件，仅限本机用户访问' },
    ]);
    if (!choice) return false;
    await this.client.dispatch({
      type: 'credentials.set',
      provider,
      key,
      persist: choice === 'saved',
    });
    const current = this.state()?.selection;
    if (current?.provider === provider)
      await this.client.dispatch({ type: 'models.select', provider, model: current.model });
    this.view.status(
      'info',
      choice === 'saved' ? 'API Key 已保存到本机' : 'API Key 仅用于本次运行',
    );
    return true;
  }
}
