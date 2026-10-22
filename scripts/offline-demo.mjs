// Dependency-free and model-free smoke demo of the Agent Loop protocol.
import { readFile } from 'node:fs/promises';
let turn = 0;
const messages = [
  { role: 'system', content: 'You are a coding assistant.' },
  { role: 'user', content: 'Explain the add function in hello.ts' },
];
async function mockModel() {
  if (++turn === 1)
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"hello.ts"}' },
        },
      ],
    };
  return {
    role: 'assistant',
    content: 'The add function returns the sum of a and b (a + b).',
    tool_calls: [],
  };
}
while (true) {
  const reply = await mockModel(messages);
  messages.push(reply);
  if (!reply.tool_calls.length) {
    console.log('AGENT:', reply.content);
    break;
  }
  for (const call of reply.tool_calls) {
    const { path } = JSON.parse(call.function.arguments);
    const result =
      call.function.name === 'read_file' && path === 'hello.ts'
        ? await readFile(new URL('../workspace/hello.ts', import.meta.url), 'utf8')
        : 'Denied';
    messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    console.log('TOOL:', call.function.name, JSON.stringify(result));
  }
}
console.log('MESSAGE ROLES:', messages.map((m) => m.role).join(' -> '));
