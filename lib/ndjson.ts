/**
 * Newline-delimited JSON framing, shared by the producer and the consumer so the two cannot disagree
 * about what a line is.
 *
 * The format is chosen over server-sent events because nothing here needs reconnection, event names or
 * the `text/event-stream` envelope, and NDJSON stays readable through `curl` without a client library.
 */

/** One event, terminated. Values are serialised compactly: this is a wire format, not a document. */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * A complete line that is not JSON.
 *
 * Typed rather than left as the `SyntaxError` that `JSON.parse` raises, because the caller has to tell
 * this apart from the connection failing. Both arrive as a rejection from the same `await`, and read as
 * the same thing to a reader unless they are distinguished: a corrupt line is something this service or
 * something between it and the browser did, and telling somebody to check their connection over it
 * sends them to look at the one part of the system that is working.
 *
 * Distinct from a *truncated* line, which is not an error at all. That is a stream cut mid-event, and it
 * is reported by the absence of a terminal event rather than from here.
 */
export class MalformedLineError extends Error {
  constructor() {
    super('The analysis stream contained a line that was not valid JSON');
    this.name = 'MalformedLineError';
  }
}

function parseLine<T>(line: string): T {
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new MalformedLineError();
  }
}

export type LineParser<T> = {
  /** Complete lines contained in this chunk. A chunk may hold none, or several. */
  push(chunk: string): T[];
  /**
   * Called once the stream ends. A trailing fragment means the stream was cut mid-line, which is
   * reported by the absence of a terminal event rather than by throwing here: the caller is already
   * checking for that, and one failure path is easier to reason about than two.
   */
  flush(): T[];
};

/**
 * Reassembles lines across chunk boundaries, which a network stream splits wherever it likes rather
 * than politely on newlines.
 */
export function createLineParser<T>(): LineParser<T> {
  let buffer = '';

  return {
    push(chunk: string): T[] {
      buffer += chunk;

      const lines = buffer.split('\n');
      // The final element is whatever followed the last newline, which is either an empty string or the
      // beginning of a line whose remainder has not arrived yet. Either way it is not ready to parse.
      buffer = lines.pop() ?? '';

      return lines.map((line) => line.trim()).filter(Boolean).map((line) => parseLine<T>(line));
    },

    flush(): T[] {
      buffer = '';
      return [];
    },
  };
}

/**
 * Drains a response body, reporting each complete event as it arrives.
 *
 * This is the consumer half of the framing and belongs beside the producer half for the same reason
 * `createLineParser` does: it was written inline in the page, where the one piece of it that is easy
 * to get wrong could not be tested. That piece is the decoder. It is held across reads with
 * `stream: true` so a multi-byte character split across two chunks is reassembled rather than turned
 * into a replacement character — a per-chunk `decode` looks identical and corrupts any non-ASCII
 * evidence string unlucky enough to straddle a packet boundary.
 *
 * Deliberately says nothing about which events are terminal. That is the endpoint's contract rather
 * than the format's, and it stays with the caller that knows it.
 */
export async function readNdjsonStream<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createLineParser<T>();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) onEvent(event);
    }
  } finally {
    parser.flush();
    reader.releaseLock();
  }
}
