import type { Message } from '../model/types.js';

export type ContextCapability = {
  contextWindow: number;
  outputReserve: number;
  source: 'provider' | 'override' | 'fallback';
  note?: string;
};
export type MemorySearchPort = {
  search(query: string, limit?: number): Array<{ scope: 'project' | 'global'; text: string }>;
};
export type CompactionPort = {
  read(history: Message[]): Promise<{ coveredCount: number; summary: string } | undefined>;
  save(history: Message[], coveredCount: number, summary: string): Promise<void>;
};

export type ContextOptions = {
  maxInputTokens?: number;
  reservedOutputTokens?: number;
  recentTurns?: number;
  maxToolResultTokens?: number;
  maxMemoryTokens?: number;
  memoryLimit?: number;
  summarize?: boolean;
  compactThreshold?: number;
  safetyMargin?: number;
  applyMemory?: boolean;
  generateMemory?: boolean;
  warnThreshold?: number;
  showWarnings?: boolean;
  overflowBehavior?: 'trim' | 'error';
};
export type ContextReport = {
  estimatedTokens: number;
  budget: number;
  removedMessages: number;
  summaryCreated: boolean;
  recalledMemories: number;
  truncatedToolResults: number;
  nearLimit?: boolean;
};
