import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeEvent } from '../src/app/contracts.js';
import { runtimeFixture, echoModel } from './helpers/runtime.js';

test('runtime initializes once, isolates subscribers, and persists typed messages with usage', async () => {
  const f = await runtimeFixture(echoModel);
  try {
    const events: RuntimeEvent[] = [];
    f.runtime.subscribe(() => {
      throw new Error('broken view');
    });
    f.runtime.subscribe((event) => {
      if (event.type === 'message') event.message.content = 'mutated';
    });
    f.runtime.subscribe((event) => events.push(event));
    const [first, second] = await Promise.all([f.runtime.initialize(), f.runtime.initialize()]);
    assert.deepEqual(first, second);
    assert.deepEqual(await f.runtime.dispatch({ type: 'sessions.list' }), ['default']);
    assert.equal(await f.runtime.dispatch({ type: 'run', input: '你好' }), '答复：你好');
    const snapshot = f.runtime.snapshot();
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.history.at(-1)?.content, '答复：你好');
    assert.equal(snapshot.metrics.totalTokens, 12);
    const saved = JSON.parse(
      await readFile(join(f.directory, '.mini-agent/sessions/default.json'), 'utf8'),
    );
    assert.equal(saved.at(-1).usage.totalTokens, 12);
    assert.equal(events.filter((event) => event.type === 'message').length, 2);
    assert.doesNotThrow(() => JSON.stringify(events));
    snapshot.history.splice(0);
    assert.equal(f.runtime.snapshot().history.length, 2);
  } finally {
    await f.close();
  }
});

test('updating the active provider key rebuilds its model immediately without persisting the key in history', async () => {
  const keys: Array<string | undefined> = [];
  const reserves: number[] = [];
  const f = await runtimeFixture(echoModel, {
    dependencies: {
      createModel: (_selection, key) => {
        keys.push(key);
        return {
          setMaxOutputTokens: (tokens) => reserves.push(tokens),
          async complete() {
            if (key !== 'fake_replacement_key') throw new Error('Old credentials');
            return { content: 'ready', toolCalls: [] };
          },
        };
      },
      resolveCapability: async () => ({
        contextWindow: 32768,
        outputReserve: 4096,
        source: 'override',
      }),
    },
  });
  try {
    const snapshot = await f.runtime.initialize();
    await f.runtime.dispatch({
      type: 'credentials.set',
      provider: snapshot.selection.provider,
      key: 'fake_replacement_key',
      persist: false,
    });
    assert.equal(keys.length, 2);
    assert.equal(keys.at(-1), 'fake_replacement_key');
    assert.deepEqual(reserves, [4096, 4096]);
    assert.equal(await f.runtime.dispatch({ type: 'run', input: 'go' }), 'ready');
    assert.doesNotMatch(JSON.stringify(f.runtime.snapshot().history), /fake_replacement_key/);
  } finally {
    await f.close();
  }
});

test('session switching and deletion preserve project memory and isolate session state', async () => {
  const f = await runtimeFixture(echoModel);
  try {
    await f.runtime.initialize();
    await f.runtime.dispatch({ type: 'run', input: 'one' });
    await f.runtime.dispatch({ type: 'sessions.switch', id: 'work' });
    assert.equal(f.runtime.snapshot().history.length, 0);
    await f.runtime.dispatch({ type: 'run', input: 'two' });
    await f.runtime.dispatch({ type: 'sessions.switch', id: 'default' });
    assert.equal(f.runtime.snapshot().history[0]?.content, 'one');
    await f.runtime.dispatch({ type: 'sessions.delete', id: 'work' });
    for (const path of ['sessions/work.json', 'journals/work.json'])
      await assert.rejects(access(join(f.directory, '.mini-agent', path)));
    await f.runtime.dispatch({ type: 'sessions.delete', id: 'default' });
    assert.notEqual(f.runtime.snapshot().id, 'default');
    await assert.rejects(f.runtime.dispatch({ type: 'sessions.switch', id: '../escape' }));
    await f.runtime.dispatch({ type: 'sessions.reset' });
    assert.equal(f.runtime.snapshot().history.length, 0);
  } finally {
    await f.close();
  }
});

test('approval travels as JSON and is answered by ID before any write', async () => {
  let calls = 0;
  const f = await runtimeFixture({
    async complete() {
      return ++calls === 1
        ? {
            content: null,
            toolCalls: [
              {
                id: 'write-1',
                name: 'write_file',
                arguments: '{"path":"created.txt","content":"ok"}',
              },
            ],
          }
        : { content: 'done', toolCalls: [] };
    },
  });
  try {
    await f.runtime.initialize();
    let approvalId = '';
    f.runtime.subscribe((event) => {
      if (event.type === 'approval_requested') {
        approvalId = event.approval.request.id;
        assert.match(event.approval.preview, /created.txt/);
        void f.runtime.dispatch({ type: 'approvals.respond', id: approvalId, accepted: true });
      }
    });
    await f.runtime.dispatch({ type: 'run', input: 'create a file' });
    assert.ok(approvalId);
    assert.equal(await readFile(join(f.directory, 'created.txt'), 'utf8'), 'ok');
    await assert.rejects(
      f.runtime.dispatch({ type: 'approvals.respond', id: approvalId, accepted: true }),
      /审批/,
    );
  } finally {
    await f.close();
  }
});

test('cancelling an approval prevents writes and repairs every unfinished tool pair', async () => {
  const f = await runtimeFixture({
    async complete() {
      return {
        content: null,
        toolCalls: ['a', 'b'].map((id) => ({
          id,
          name: 'write_file',
          arguments: JSON.stringify({ path: `${id}.txt`, content: 'never' }),
        })),
      };
    },
  });
  try {
    await f.runtime.initialize();
    let resolveApproval!: () => void;
    const requested = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });
    f.runtime.subscribe((event) => {
      if (event.type === 'approval_requested') resolveApproval();
    });
    const run = f.runtime.dispatch({ type: 'run', input: 'write' });
    const rejected = assert.rejects(run, /cancel/i);
    await requested;
    assert.equal(f.runtime.snapshot().pendingApprovals.length, 1);
    await assert.rejects(f.runtime.dispatch({ type: 'sessions.switch', id: 'other' }), /正在运行/);
    await assert.rejects(f.runtime.dispatch({ type: 'run', input: 'concurrent' }), /正在运行/);
    await f.runtime.dispatch({ type: 'cancel' });
    await rejected;
    assert.equal(f.runtime.snapshot().pendingApprovals.length, 0);
    const tools = f.runtime.snapshot().history.filter((message) => message.role === 'tool');
    assert.deepEqual(tools.map((message) => message.tool_call_id).sort(), ['a', 'b']);
    for (const name of ['a.txt', 'b.txt']) await assert.rejects(access(join(f.directory, name)));
  } finally {
    await f.close();
  }
});

test('closing during approval cancels the run and waits for history persistence', async () => {
  const f = await runtimeFixture({
    async complete() {
      return {
        content: null,
        toolCalls: [
          { id: 'c', name: 'write_file', arguments: '{"path":"c.txt","content":"never"}' },
        ],
      };
    },
  });
  try {
    await f.runtime.initialize();
    let ready!: () => void;
    const pending = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.runtime.subscribe((event) => {
      if (event.type === 'approval_requested') ready();
    });
    const rejected = assert.rejects(f.runtime.dispatch({ type: 'run', input: 'write' }));
    await pending;
    await f.runtime.close();
    await rejected;
    const saved = JSON.parse(
      await readFile(join(f.directory, '.mini-agent/sessions/default.json'), 'utf8'),
    );
    assert.equal(saved.at(-1).role, 'tool');
    assert.throws(() => f.runtime.snapshot(), /已关闭/);
  } finally {
    await f.close();
  }
});
