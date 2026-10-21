import 'dotenv/config';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import { AgentRuntime } from './app/runtime.js';
import { runClassic } from './presentation/classic.js';
import { TerminalView } from './presentation/terminal/view.js';
import { TerminalController } from './presentation/terminal/controller.js';

async function main(): Promise<void> {
  const runtime = new AgentRuntime();
  const input = process.argv.slice(2).join(' ') || undefined;
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') {
    await runClassic(runtime, input);
    return;
  }
  const view = new TerminalView(new ProcessTerminal(), process.env.AGENT_TUI_SCREEN !== 'regular', {
    maxToolEntries:
      process.env.AGENT_TUI_MAX_TOOL_ENTRIES === undefined
        ? undefined
        : Number(process.env.AGENT_TUI_MAX_TOOL_ENTRIES),
  });
  const controller = new TerminalController(runtime, view);
  const onExit = () => controller.requestExit();
  const restore = () => view.stop();
  process.once('SIGINT', onExit);
  process.once('SIGTERM', onExit);
  process.once('exit', restore);
  try {
    await controller.start(input);
    await controller.waitUntilExit();
  } finally {
    await controller.close();
    process.off('SIGINT', onExit);
    process.off('SIGTERM', onExit);
    process.off('exit', restore);
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
