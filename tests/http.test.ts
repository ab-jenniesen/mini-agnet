import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHttpServer } from '../src/adapters/http/server.js';
import { HttpAgentClient } from '../src/adapters/http/client.js';
import type { RuntimeEvent } from '../src/app/contracts.js';
import { runtimeFixture, echoModel } from './helpers/runtime.js';

test('HTTP/SSE clients share the runtime without terminal imports, using validated commands', async () => {
  const f = await runtimeFixture(echoModel);
  const server = await startHttpServer(f.runtime);
  const client = new HttpAgentClient(server.url, server.token);
  try {
    assert.equal((await fetch(`${server.url}/api/state`)).status, 401);
    const events: RuntimeEvent[] = [];
    client.subscribe((event) => events.push(event));
    const initial = await client.initialize();
    assert.equal(initial.id, 'default');
    assert.equal(await client.dispatch({ type: 'run', input: 'remote' }), '答复：remote');
    assert.deepEqual(await client.dispatch({ type: 'sessions.list' }), ['default']);
    assert.equal(f.runtime.snapshot().history.at(-1)?.content, '答复：remote');
    const invalid = await fetch(`${server.url}/api/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: '{"type":"permissions.set","mode":"typo"}',
    });
    assert.equal(invalid.status, 400);
    const denied = await fetch(`${server.url}/api/state`, {
      headers: { origin: 'http://untrusted.example', authorization: `Bearer ${server.token}` },
    });
    assert.equal(denied.status, 403);
    assert.ok(events.some((event) => event.type === 'message'));
    const structured = await client.dispatch({ type: 'tasks.run', input: 'structured' });
    assert.equal(structured.status, 'completed');
    assert.equal(structured.verification.status, 'not_run');
    assert.equal((await client.dispatch({ type: 'tasks.current' }))?.runId, structured.runId);
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

test('HTTP clients approve a tool through a separate request while run is in progress', async () => {
  let step = 0;
  const f = await runtimeFixture({
    async complete() {
      return ++step === 1
        ? {
            content: null,
            toolCalls: [
              {
                id: 'remote-write',
                name: 'write_file',
                arguments: '{"path":"from-http.txt","content":"ok"}',
              },
            ],
          }
        : { content: 'saved', toolCalls: [] };
    },
  });
  const server = await startHttpServer(f.runtime);
  const client = new HttpAgentClient(server.url, server.token);
  try {
    let decision: Promise<void> | undefined;
    client.subscribe((event) => {
      if (event.type === 'approval_requested')
        decision = client.dispatch({
          type: 'approvals.respond',
          id: event.approval.request.id,
          accepted: true,
        });
    });
    await client.initialize();
    assert.equal(await client.dispatch({ type: 'run', input: 'save' }), 'saved');
    await decision;
    assert.ok(decision);
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

test('a malformed event stream cancels its reader before rejecting initialization', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: invalid-json\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const client = new HttpAgentClient('https://example.invalid', 'fake');
  try {
    await assert.rejects(client.initialize(), SyntaxError);
    assert.equal(cancelled, true);
  } finally {
    await client.close();
    globalThis.fetch = originalFetch;
  }
});
