export interface SSEMessage {
  event?: string;
  data: string;
}

/** Parses a `text/event-stream` body into messages. */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        const msg = parseBlock(raw);
        if (msg) yield msg;
      }
    }
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export interface SSEWriter {
  readonly response: Response;
  /** Objects are sent as JSON. Returns false once the client has gone. */
  send(data: unknown, opts?: { event?: string; id?: string }): boolean;
  close(): void;
  readonly closed: boolean;
}

/** A `text/event-stream` response for plugin HTTP routes. A comment line is sent every 15 s to keep proxies open. */
export function createSSE(signal?: AbortSignal, headers: Record<string, string> = {}): SSEWriter {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const ping = setInterval(() => write(": ping\n\n"), 15_000);
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    try {
      controller?.close();
    } catch {
      // already closed by the client
    }
  };
  const write = (text: string): boolean => {
    if (closed || !controller) return false;
    try {
      controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      finish();
      return false;
    }
  };
  signal?.addEventListener("abort", finish, { once: true });
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel: finish,
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", ...headers } }),
    send(data, opts) {
      const text = typeof data === "string" ? data : JSON.stringify(data);
      const lines = [opts?.event ? `event: ${opts.event}` : "", opts?.id ? `id: ${opts.id}` : "", ...text.split("\n").map((l) => `data: ${l}`)].filter(Boolean);
      return write(`${lines.join("\n")}\n\n`);
    },
    close: finish,
    get closed() {
      return closed;
    },
  };
}

function parseBlock(raw: string): SSEMessage | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return undefined;
  return event ? { event, data: data.join("\n") } : { data: data.join("\n") };
}
