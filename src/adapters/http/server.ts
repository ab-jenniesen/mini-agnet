import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentClient, RuntimeSnapshot } from '../../protocol/index.js';
import { commandSchema } from '../../protocol/commands.js';

const BODY_LIMIT = 2 * 1024 * 1024;

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

/** A local authenticated host. Native/web/desktop clients all use the same JSON contract. */
export async function startHttpServer(
  runtime: AgentClient & { snapshot(): RuntimeSnapshot },
  options: { port?: number; token?: string; origin?: string } = {},
) {
  await runtime.initialize();
  const token = options.token ?? randomBytes(32).toString('hex');
  if (!token) throw new Error('Server token must not be empty');
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent)
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (origin) {
      if (!options.origin || origin !== options.origin) {
        json(response, 403, { error: 'Origin not allowed' });
        return;
      }
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
      });
      response.end();
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      json(response, 401, { error: 'Unauthorized' });
      return;
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/api/state') {
      json(response, 200, runtime.snapshot());
      return;
    }
    if (request.method === 'GET' && path === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.flushHeaders();
      const send = (event: unknown) => {
        if (response.writableLength > BODY_LIMIT) {
          response.destroy();
          return;
        }
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const unsubscribe = runtime.subscribe(send);
      send({ type: 'state', state: runtime.snapshot() });
      streams.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
      response.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(response);
      });
      return;
    }
    if (request.method === 'POST' && path === '/api/commands') {
      const command = commandSchema.parse(await readJson(request));
      const result = await runtime.dispatch(command);
      json(response, 200, { result: result ?? null });
      return;
    }
    json(response, 404, { error: 'Not found' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable');
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close(): Promise<void> {
      closing ??= (async () => {
        for (const stream of streams) stream.end();
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await runtime.close();
        server.closeAllConnections();
        await stopped;
      })();
      return closing;
    },
  };
}
