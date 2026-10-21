/** Runtime provider-model discovery. Never logs or persists credentials. */
import { providerById, type Provider } from './providers.js';

export type DiscoveredModel = {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
};
export type ModelCatalog = {
  models: DiscoveredModel[];
  source: 'live' | 'fallback';
  note?: string;
  fetchedAt: number;
};
type DiscoveryOptions = {
  providerId: string;
  key?: string;
  baseURL?: string;
  timeoutMs?: number;
  maxPages?: number;
};
const modelId = (x: unknown): x is string =>
  typeof x === 'string' && x.trim().length > 0 && x.length < 300;
const modelsFrom = (raw: unknown): DiscoveredModel[] => {
  const arr =
    (raw as { data?: unknown; models?: unknown })?.data ?? (raw as { models?: unknown })?.models;
  if (!Array.isArray(arr)) throw Error('Unexpected models response shape');
  return arr.flatMap((m: unknown) => {
    if (!m || typeof m !== 'object') return [];
    const r = m as Record<string, unknown>;
    const id = modelId(r.id) ? r.id : modelId(r.name) ? r.name.replace(/^models\//, '') : undefined;
    if (!id) return [];
    const label = modelId(r.displayName)
      ? r.displayName
      : modelId(r.display_name)
        ? r.display_name
        : modelId(r.name) && !r.name.startsWith('models/')
          ? r.name
          : id;
    return [
      {
        id,
        label,
        ...(typeof r.context_window === 'number'
          ? { contextWindow: r.context_window }
          : typeof r.max_input_tokens === 'number'
            ? { contextWindow: r.max_input_tokens }
            : typeof r.inputTokenLimit === 'number'
              ? { contextWindow: r.inputTokenLimit }
              : {}),
        ...(typeof r.max_output_tokens === 'number'
          ? { maxOutputTokens: r.max_output_tokens }
          : typeof r.max_tokens === 'number'
            ? { maxOutputTokens: r.max_tokens }
            : typeof r.outputTokenLimit === 'number'
              ? { maxOutputTokens: r.outputTokenLimit }
              : {}),
      },
    ];
  });
};
export function fallbackCatalog(providerId: string, reason?: string): ModelCatalog {
  const p = providerById(providerId);
  return {
    models: [{ id: p.defaultModel, label: p.defaultModel }],
    source: 'fallback',
    note: reason ?? 'Manual model ID entry is available.',
    fetchedAt: Date.now(),
  };
}
function endpoint(p: Provider, baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '');
  if (p.id === 'ollama') return base.replace(/\/v1$/, '') + '/api/tags';
  return base + '/models';
}
export async function discoverModels(options: DiscoveryOptions): Promise<ModelCatalog> {
  const p = providerById(options.providerId);
  const key = options.key ?? process.env[p.envKey];
  if (!key && p.id !== 'ollama' && p.id !== 'custom')
    return fallbackCatalog(p.id, 'No API key configured');
  const baseURL = options.baseURL ?? process.env[`${p.id.toUpperCase()}_BASE_URL`] ?? p.baseURL;
  const headers: Record<string, string> = {};
  if (p.kind === 'anthropic') {
    headers['x-api-key'] = key ?? '';
    headers['anthropic-version'] = '2023-06-01';
  } else if (p.kind === 'gemini') headers['x-goog-api-key'] = key ?? '';
  else if (key && p.id !== 'ollama') headers.authorization = `Bearer ${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 8000);
  try {
    const collected = new Map<string, DiscoveredModel>();
    let pageToken: string | undefined;
    for (let page = 0; page < Math.min(options.maxPages ?? 4, 10); page++) {
      const url = new URL(endpoint(p, baseURL));
      if (p.kind === 'gemini') {
        url.searchParams.set('pageSize', '100');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
      }
      if (p.kind === 'anthropic') {
        url.searchParams.set('limit', '100');
        if (pageToken) url.searchParams.set('after_id', pageToken);
      }
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (!res.ok) throw Error(`Models API HTTP ${res.status}`);
      const raw = (await res.json()) as any;
      const arr = p.id === 'ollama' ? raw?.models : (raw?.data ?? raw?.models);
      if (!Array.isArray(arr)) throw Error('Invalid models API response');
      for (const m of modelsFrom({ models: arr })) collected.set(m.id, m);
      pageToken =
        p.kind === 'gemini'
          ? raw.nextPageToken
          : p.kind === 'anthropic' && raw.has_more
            ? raw.last_id
            : undefined;
      if (!pageToken) break;
    }
    const models = [...collected.values()].filter(
      (m) => p.kind !== 'gemini' || !m.id.startsWith('embedding-'),
    );
    if (!models.length) throw Error('Models API returned an empty list');
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { models, source: 'live', fetchedAt: Date.now() };
  } catch (e) {
    return fallbackCatalog(
      p.id,
      `Discovery unavailable: ${e instanceof Error ? e.message : String(e)}. Enter a model ID manually.`,
    );
  } finally {
    clearTimeout(timer);
  }
}
