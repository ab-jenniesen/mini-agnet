import type { ToolEvidence, Usage } from './model/types.js';

/** Progress data contains no terminal markup or UI callbacks. */
export type AgentEvent =
  | {
      type: 'model_call';
      id: string;
      status: 'started' | 'completed' | 'failed';
      ms?: number;
      usage?: Usage;
    }
  | { type: 'step'; step: number }
  | { type: 'model_start'; startedAt: number }
  | { type: 'thinking_end'; ms: number }
  | { type: 'text'; text: string }
  | { type: 'assistant_message'; content: string; usage?: Usage }
  | { type: 'thinking'; text: string; source: 'provider' | 'summary' }
  | { type: 'tool_start'; callId: string; name: string; args: unknown }
  | {
      type: 'tool_end';
      callId: string;
      name: string;
      result: string;
      ms: number;
      artifactId?: string;
      evidence?: ToolEvidence[];
      outcome?: 'success' | 'denied' | 'error';
    }
  | { type: 'usage'; usage: Usage }
  | { type: 'compact'; removedMessages: number }
  | {
      type: 'context';
      estimatedTokens: number;
      budget: number;
      recalledMemories: number;
      truncatedToolResults: number;
      summaryCreated: boolean;
      nearLimit?: boolean;
    };
