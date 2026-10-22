/** Provider-independent termination information. Missing metadata remains explicit. */
export type ModelFinishReason =
  'stop' | 'tool_calls' | 'length' | 'blocked' | 'pause' | 'error' | 'unknown';

export function finishReason(raw: string | null | undefined, toolCount: number): ModelFinishReason {
  switch (raw?.toLowerCase()) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return toolCount ? 'tool_calls' : 'stop';
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_calls';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'pause_turn':
    case 'continuation':
      return 'pause';
    case 'content_filter':
    case 'refusal':
    case 'safety':
    case 'recitation':
    case 'blocklist':
    case 'prohibited_content':
    case 'spii':
    case 'image_safety':
    case 'model_armor':
      return 'blocked';
    case 'malformed_function_call':
    case 'unexpected_tool_call':
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

export class ModelCompletionError extends Error {
  constructor(
    readonly code:
      'output_truncated' | 'model_blocked' | 'model_paused' | 'empty_response' | 'invalid_response',
    message: string,
    readonly finishReason: ModelFinishReason,
    readonly rawFinishReason?: string,
  ) {
    super(message);
    this.name = 'ModelCompletionError';
  }
}
