import { discoverModels } from './discovery.js';
import type { Selection } from './providers.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_RESERVE } from '../../core/context/defaults.js';

import type { ContextCapability } from '../../core/context/types.js';
export type { ContextCapability } from '../../core/context/types.js';
export type CapabilityOptions = {
  key?: string;
  fallbackWindow?: number;
  windowOverride?: number;
  outputReserve?: number;
  timeoutMs?: number;
};
const positive = (n: number | undefined): n is number =>
  n !== undefined && Number.isSafeInteger(n) && n > 0;
/** Models endpoints are heterogeneous: only trust context data actually provided by the vendor. */
export async function resolveContextCapability(
  selection: Selection,
  opts: CapabilityOptions = {},
): Promise<ContextCapability> {
  const fallbackWindow = opts.fallbackWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (!positive(fallbackWindow)) throw Error('Invalid fallback context window');
  let window = fallbackWindow;
  let source: ContextCapability['source'] = 'fallback';
  let note: string | undefined =
    'Provider did not publish context capacity. Using a configurable unverified fallback; set AGENT_CONTEXT_WINDOW_OVERRIDE to the documented capacity.';
  let providerMaxOutput: number | undefined;
  if (opts.windowOverride !== undefined && !positive(opts.windowOverride))
    throw Error('Invalid context window override');
  if (positive(opts.windowOverride)) {
    window = opts.windowOverride;
    source = 'override';
    note = undefined;
  } else {
    const catalog = await discoverModels({
      providerId: selection.provider,
      key: opts.key,
      baseURL: selection.baseURL,
      timeoutMs: opts.timeoutMs ?? 5000,
    });
    const discovered =
      catalog.source === 'live' ? catalog.models.find((m) => m.id === selection.model) : undefined;
    if (discovered && positive(discovered.contextWindow)) {
      window = discovered.contextWindow;
      source = 'provider';
      note = undefined;
      providerMaxOutput = discovered.maxOutputTokens;
    }
  }
  const desired = opts.outputReserve ?? Math.min(DEFAULT_OUTPUT_RESERVE, Math.floor(window * 0.1));
  if (!positive(desired)) throw Error('Invalid output reserve');
  const reserve = Math.min(desired, providerMaxOutput ?? desired);
  if (window - reserve < 512) throw Error('Output reserve leaves too little input context');
  return { contextWindow: window, outputReserve: reserve, source, ...(note ? { note } : {}) };
}
