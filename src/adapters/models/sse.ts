export type SseFrame = { event: string; data: string };

function parseFrame(frame: string): SseFrame | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join('\n') } : undefined;
}

/** Incremental UTF-8 decoding; network chunks need not align with lines or frames. */
export async function* readSseFrames(response: Response): AsyncGenerator<SseFrame> {
  if (!response.body) throw new Error('No response stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = parseFrame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (frame) yield frame;
      }
      if (buffer.length > 2_000_000) throw new Error('Model SSE frame too large');
      if (done) {
        const frame = parseFrame(buffer);
        if (frame) yield frame;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
