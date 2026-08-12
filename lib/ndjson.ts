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

      return lines.map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
    },

    flush(): T[] {
      buffer = '';
      return [];
    },
  };
}
