import 'dotenv/config';
import { AgentRuntime } from './app/runtime.js';
import { runClassic } from './presentation/classic.js';

try {
  await runClassic(new AgentRuntime(), process.argv.slice(2).join(' ') || undefined);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
