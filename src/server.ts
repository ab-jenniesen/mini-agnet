import 'dotenv/config';
import { AgentRuntime } from './host/runtime.js';
import { startHttpServer } from './adapters/http/server.js';

const runtime = new AgentRuntime();
try {
  const port = Number(process.env.AGENT_SERVER_PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid AGENT_SERVER_PORT');
  const server = await startHttpServer(runtime, {
    port,
    token: process.env.AGENT_SERVER_TOKEN,
    origin: process.env.AGENT_CLIENT_ORIGIN,
  });
  console.log(`Mini Agent API: ${server.url}`);
  if (!process.env.AGENT_SERVER_TOKEN) console.log(`本次访问令牌：${server.token}`);
  const stop = () => {
    void server.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  await runtime.close();
  console.error(error);
  process.exitCode = 1;
}
