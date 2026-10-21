import type { Usage } from '../types.js';
import { readSseFrames } from './sse.js';
export function usage(prompt = 0, completion = 0): Usage {
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}
export function requestSignal(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(new Error('Model timeout')), 120000);
  const onAbort = () => c.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) c.abort(signal.reason);
  return {
    signal: c.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
export async function* sse(response: Response): AsyncGenerator<{ event: string; data: any }> {
  for await (const frame of readSseFrames(response)) {
    if (frame.data === '[DONE]') continue;
    const data = JSON.parse(frame.data);
    if (frame.event === 'error' || data.error)
      throw new Error('Model stream error: ' + JSON.stringify(data.error ?? data));
    yield { event: frame.event, data };
  }
}
