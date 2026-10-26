export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini';
export type Provider = {
  id: string;
  label: string;
  kind: ProviderKind;
  baseURL: string;
  envKey: string;
  defaultModel: string;
};

export type Selection = { provider: string; model: string; baseURL?: string };

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

export type CredentialStatus = 'env' | 'temporary' | 'saved' | 'local' | 'missing';
