import type { Usage } from './types.js';

/** Progress data contains no terminal markup or UI callbacks. */
export type AgentEvent =
  | { type: 'step'; step: number }
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
    };
