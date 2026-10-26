import 'dotenv/config';
import { AgentRuntime } from './host/runtime.js';
import { runClassic } from './ui/classic.js';

try {
  await runClassic(new AgentRuntime(), process.argv.slice(2).join(' ') || undefined);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
