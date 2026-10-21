import { readFile } from 'node:fs/promises';
import { atomicJson } from '../infra/memory.js';
import type { Model } from './types.js';
import { CompatibleChatModel } from './model.js';
import { AnthropicModel, GeminiModel } from './providers/adapters.js';
export { AnthropicModel, GeminiModel } from './providers/adapters.js';

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini';
export type Provider = {
  id: string;
  label: string;
  kind: ProviderKind;
  baseURL: string;
  envKey: string;
  defaultModel: string;
};
export const PROVIDERS: Provider[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-flash',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.4',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5-5',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    envKey: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'qwen',
    label: 'Alibaba Qwen',
    kind: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-plus',
  },
  {
    id: 'kimi',
    label: 'Moonshot Kimi',
    kind: 'openai-compatible',
    baseURL: 'https://api.moonshot.ai/v1',
    envKey: 'KIMI_API_KEY',
    defaultModel: 'kimi-k2.6',
  },
  {
    id: 'zhipu',
    label: 'Zhipu GLM',
    kind: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'ZHIPU_API_KEY',
    defaultModel: 'glm-4.7',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    kind: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1',
    envKey: 'SILICONFLOW_API_KEY',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compatible',
    baseURL: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    envKey: 'OLLAMA_API_KEY',
    defaultModel: 'qwen3:8b',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    kind: 'openai-compatible',
    baseURL: 'http://127.0.0.1:8000/v1',
    envKey: 'CUSTOM_API_KEY',
    defaultModel: 'custom-model',
  },
];
export type Selection = { provider: string; model: string; baseURL?: string };
export function providerById(id: string): Provider {
  const p = PROVIDERS.find((p) => p.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
export function modelFor(selection: Selection, credential?: string): Model {
  const provider = providerById(selection.provider);
  const key =
    credential ||
    process.env[provider.envKey] ||
    (provider.id === 'ollama' || provider.id === 'custom' ? 'ollama' : undefined);
  if (!key)
    throw new Error(
      `Missing ${provider.envKey} for ${provider.label}; configure it in the terminal or .env`,
    );
  const url =
    selection.baseURL ?? process.env[`${provider.id.toUpperCase()}_BASE_URL`] ?? provider.baseURL;
  if (provider.kind === 'anthropic') return new AnthropicModel(url, key, selection.model);
  if (provider.kind === 'gemini') return new GeminiModel(url, key, selection.model);
  return new CompatibleChatModel(url, key, selection.model);
}
export async function loadSelection(path: string): Promise<Selection> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<Selection>;
    if (typeof raw.provider === 'string' && typeof raw.model === 'string') {
      providerById(raw.provider);
      return {
        provider: raw.provider,
        model: raw.model,
        ...(typeof raw.baseURL === 'string' ? { baseURL: raw.baseURL } : {}),
      };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  // First-run default; no automatic fallback to a different provider on missing key.
  return {
    provider: 'deepseek',
    model: process.env.DEEPSEEK_MODEL ?? providerById('deepseek').defaultModel,
  };
}
export async function saveSelection(path: string, selection: Selection): Promise<void> {
  await atomicJson(path, selection);
}
