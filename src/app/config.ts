import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_CONTEXT_WINDOW } from '../core/context/defaults.js';

export type RuntimeConfig = {
  root: string;
  configDirectory: string;
  selectionPath: string;
  credentialsPath: string;
  memoryPath?: string;
  globalMemoryPath: string;
  artifactDirectory?: string;
  sessionId: string;
  maxSteps: number;
  maxInputChars: number;
  contextWindow?: number;
  outputReserve?: number;
  summarize?: boolean;
  compactThreshold?: number;
  mcpCommand?: string;
  mcpArgs: string[];
};

function positiveInteger(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`Expected a positive integer, got ${value}`);
  return parsed;
}

/** Read process configuration once; explicit options make tests and multiple hosts independent. */
export function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const env = process.env;
  const configDirectory = overrides.configDirectory ?? resolve(homedir(), '.config/mini-agent');
  const mcpArgs: unknown = JSON.parse(env.MCP_ARGS_JSON ?? '[]');
  if (!Array.isArray(mcpArgs) || !mcpArgs.every((value) => typeof value === 'string'))
    throw new Error('MCP_ARGS_JSON must be a string array');
  const config = {
    root: resolve(env.AGENT_WORKSPACE ?? process.cwd()),
    configDirectory,
    selectionPath: env.AGENT_MODEL_STATE_FILE ?? resolve(configDirectory, 'model-selection.json'),
    credentialsPath: env.AGENT_CREDENTIALS_FILE ?? resolve(configDirectory, 'credentials.json'),
    memoryPath: env.AGENT_MEMORY_FILE,
    globalMemoryPath: env.AGENT_GLOBAL_MEMORY_FILE ?? resolve(configDirectory, 'memories.json'),
    artifactDirectory: env.AGENT_ARTIFACT_DIR,
    sessionId: env.AGENT_SESSION_ID ?? 'default',
    maxSteps: positiveInteger(env.AGENT_MAX_STEPS, 15)!,
    maxInputChars: positiveInteger(env.AGENT_MAX_INPUT_CHARS, 65536)!,
    contextWindow: positiveInteger(env.AGENT_CONTEXT_WINDOW_OVERRIDE, DEFAULT_CONTEXT_WINDOW),
    outputReserve: positiveInteger(env.AGENT_OUTPUT_RESERVE),
    summarize:
      env.AGENT_CONTEXT_SUMMARIZE === undefined ? undefined : env.AGENT_CONTEXT_SUMMARIZE !== '0',
    compactThreshold:
      env.AGENT_COMPACT_THRESHOLD === undefined ? undefined : Number(env.AGENT_COMPACT_THRESHOLD),
    mcpCommand: env.MCP_COMMAND,
    mcpArgs,
    ...overrides,
  };
  if (
    !Number.isFinite(config.compactThreshold ?? 0.8) ||
    (config.compactThreshold ?? 0.8) <= 0 ||
    (config.compactThreshold ?? 0.8) > 1
  )
    throw new Error('Invalid compact threshold');
  for (const key of ['maxSteps', 'maxInputChars'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}`);
  }
  return config;
}
