import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { AgentClient, RuntimeEvent, RuntimeSnapshot } from '../app/contracts.js';
import { routeInput, helpText } from './command-router.js';
import { usageText } from './terminal/transcript-view.js';
import { safeText } from './terminal/theme.js';
import { taskStatusText } from './task-status.js';

/** The readline adapter shares the same host, commands and approvals as the TUI. */
export async function runClassic(client: AgentClient, initialInput?: string): Promise<void> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: !!process.stdin.isTTY && !!process.stdout.isTTY,
  });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string, secret = false): Promise<string | undefined> => {
    process.stdout.write(prompt);
    muted = secret;
    try {
      const next = await lines.next();
      return next.done ? undefined : next.value;
    } finally {
      muted = false;
      if (secret) process.stdout.write('\n');
    }
  };
  let state: RuntimeSnapshot;
  let streamed = false;
  let streaming = false;
  let thinking = false;
  const finishLine = () => {
    if (streaming) console.log();
    streaming = false;
    thinking = false;
  };
  const approvals = new Map<string, Promise<void>>();
  const receive = (event: RuntimeEvent): void => {
    if (event.type === 'state') state = event.state;
    if (event.type === 'task' && event.task.result) {
      finishLine();
      console.log(safeText(taskStatusText(event.task)));
    }
    if (event.type === 'notice' || event.type === 'run_error') {
      finishLine();
      console.log(safeText(event.text));
    }
    if (event.type === 'approval_requested') {
      finishLine();
      const { request, preview } = event.approval;
      const task = (async () => {
        console.log(`授权请求：${request.name}\n${safeText(preview)}`);
        const answer = await ask('同意？[y/N] ');
        if (!approvals.has(request.id)) return;
        await client.dispatch({
          type: 'approvals.respond',
          id: request.id,
          accepted: /^y(es)?$/i.test(answer ?? ''),
        });
      })().catch((error) => console.error(String(error)));
      approvals.set(request.id, task);
    }
    if (event.type === 'approval_resolved') approvals.delete(event.id);
    if (
      event.type === 'message' &&
      event.message.role === 'assistant' &&
      event.message.content !== null
    ) {
      finishLine();
      if (!streamed) console.log(`助手 > ${safeText(event.message.content)}`);
      console.log(
        usageText({
          kind: 'assistant',
          text: event.message.content,
          usage: event.message.usage,
          usageScope: event.message.tool_calls?.length ? 'call' : 'turn',
        }),
      );
    }
    if (event.type !== 'agent') return;
    const e = event.event;
    if (e.type === 'step') {
      finishLine();
      streamed = false;
    }
    if (e.type === 'text') {
      if (thinking) finishLine();
      if (!streaming) process.stdout.write('助手 > ');
      process.stdout.write(safeText(e.text));
      streamed = true;
      streaming = true;
    }
    if (e.type === 'thinking') {
      if (!streaming) process.stdout.write('思考 > ');
      process.stdout.write(safeText(e.text));
      streaming = true;
      thinking = true;
    }
    if (e.type === 'tool_start') {
      finishLine();
      console.log(`工具 > ${e.name}`);
    }
    if (e.type === 'tool_end')
      console.log(`  ↳ ${safeText(e.result).replace(/\n/g, ' ').slice(0, 180)}`);
  };
  const unsubscribe = client.subscribe(receive);
  rl.on('SIGINT', () => {
    if (state?.running) void client.dispatch({ type: 'cancel' });
    else rl.close();
  });
  try {
    state = await client.initialize();
    console.log(
      `Mini Agent · ${state.selection.provider}/${state.selection.model} · 会话 ${state.id}\n${state.workspaceRoot}`,
    );
    let input = initialInput;
    while (true) {
      input ??= await ask('你 > ');
      if (input === undefined) break;
      if (!input.trim()) {
        input = undefined;
        continue;
      }
      try {
        const effect = await routeInput(input, client, state);
        if (effect.type === 'exit') break;
        switch (effect.type) {
          case 'run':
            await client.dispatch({ type: 'tasks.run', input: effect.input });
            break;
          case 'help':
            console.log(helpText());
            break;
          case 'status':
          case 'panel':
            console.log(safeText(effect.text));
            break;
          case 'delete-session':
            if (/^y(es)?$/i.test((await ask(`删除会话 ${effect.id}？[y/N] `)) ?? ''))
              await client.dispatch({ type: 'sessions.delete', id: effect.id });
            break;
          case 'providers':
            console.log(
              (await client.dispatch({ type: 'models.providers' }))
                .map((p) => `${p.id}: ${p.defaultModel} (${p.credentialStatus})`)
                .join('\n'),
            );
            break;
          case 'models':
            console.log(
              (await client.dispatch({ type: 'models.discover', provider: effect.provider })).models
                .map((m) => m.id)
                .join('\n'),
            );
            break;
          case 'key': {
            const key = await ask('API Key（输入已隐藏）> ', true);
            if (!key) break;
            const persist = /^y(es)?$/i.test((await ask('保存到本机明文凭据文件？[y/N] ')) ?? '');
            await client.dispatch({
              type: 'credentials.set',
              provider: effect.provider,
              key,
              persist,
            });
            if (state.selection.provider === effect.provider)
              await client.dispatch({ type: 'models.select', ...state.selection });
            break;
          }
          case 'output':
            console.log(
              (
                await client.dispatch({
                  type: 'artifacts.read',
                  id: effect.id,
                  offset: effect.offset,
                })
              ).content,
            );
            break;
          case 'thinking':
          case 'close-output':
            break;
        }
      } catch (error) {
        finishLine();
        console.error(error instanceof Error ? error.message : String(error));
      }
      input = undefined;
    }
  } finally {
    unsubscribe();
    rl.close();
    await client.close();
  }
}
