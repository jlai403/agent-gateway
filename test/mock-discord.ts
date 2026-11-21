import type { ServerWebSocket } from "bun";

export type MockEvent = { at: number; op: number; d: unknown };

export type MockDiscord = {
  port: number;
  events: MockEvent[];
  pushMessage(d: unknown): void;
  push(t: string, d: unknown): void;
  closeClient(): void;
  close(): Promise<void>;
};

export type MockDiscordOptions = {
  token: string;
  botUserId: string;
  heartbeatIntervalMs?: number;
};

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// Discord's observed default; tests pass a tiny value to stay fast.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 41250;

export function startMockDiscord(opts: MockDiscordOptions): MockDiscord {
  const events: MockEvent[] = [];
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let client: ServerWebSocket<undefined> | null = null;
  let nextSeq = 0;

  const server = Bun.serve({
    port: 0,
    fetch(request, serve) {
      if (serve.upgrade(request)) return;
      return new Response("mock discord: websocket required", { status: 426 });
    },
    websocket: {
      open(ws) {
        client = ws;
        nextSeq = 0;
        ws.send(frame(OP_HELLO, { heartbeat_interval: heartbeatIntervalMs }));
      },
      message(ws, data) {
        const parsed = JSON.parse(String(data)) as { op: number; d: unknown };
        events.push({ at: performance.now(), op: parsed.op, d: parsed.d });
        if (parsed.op === OP_HEARTBEAT) {
          ws.send(frame(OP_HEARTBEAT_ACK, null));
          return;
        }
        if (parsed.op === OP_IDENTIFY) {
          const identified = parsed.d as { token?: string } | null;
          if (!identified || identified.token !== opts.token) {
            ws.close(4004, "authentication failed");
            return;
          }
          ws.send(dispatch("READY", { user: { id: opts.botUserId, username: "mock-bot" } }));
        }
      },
      close(ws) {
        if (client === ws) client = null;
      },
    },
  });

  function dispatch(t: string, d: unknown): string {
    nextSeq += 1;
    return JSON.stringify({ t, s: nextSeq, op: OP_DISPATCH, d });
  }

  function frame(op: number, d: unknown): string {
    return JSON.stringify({ t: null, s: null, op, d });
  }

  function pushMessage(d: unknown): void {
    if (!client) throw new Error("pushMessage: no gateway client is connected");
    client.send(dispatch("MESSAGE_CREATE", d));
  }
  function push(t: string, d: unknown): void {
    if (!client) throw new Error("push: no gateway client is connected");
    client.send(dispatch(t, d));
  }

  function closeClient(): void {
    client?.close(4000, "closed by mock");
  }

  async function close(): Promise<void> {
    client?.close(1001, "mock shutting down");
    server.stop(true);
    await Bun.sleep(10); // let close frames flush before the test ends
  }

  const port = server.port;
  if (typeof port !== "number") throw new Error("mock discord server was not assigned a port");
  return { port, events, pushMessage, push, closeClient, close };
}

export type RestCall = { at: number; method: string; path: string; auth: string | null; body: unknown };

export type RestCapture = {
  port: number;
  calls: RestCall[];
  close(): Promise<void>;
};

export type RestCaptureOptions = { botUserId: string };

// A DISCORD_API_BASE stand-in for the e2e: answers the three REST endpoints the
// sidecar uses (getMe, typing, sendMessage) and records every call for assertions.
export function startRestCapture(opts: RestCaptureOptions): RestCapture {
  const calls: RestCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const at = performance.now();
      const url = new URL(request.url);
      const body = parseBody(await request.text());
      calls.push({ at, method: request.method, path: url.pathname, auth: request.headers.get("Authorization"), body });
      if (request.method === "GET" && url.pathname === "/users/@me") {
        return Response.json({ id: opts.botUserId, username: "mock-bot" });
      }
      if (request.method === "POST" && /^\/channels\/[^/]+\/typing$/.test(url.pathname)) {
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(url.pathname)) {
        return Response.json({ id: "m-1" });
      }
      return new Response("not found", { status: 404 });
    },
  });

  async function close(): Promise<void> {
    server.stop(true);
    await Bun.sleep(10); // let close frames flush before the test ends
  }

  const port = server.port;
  if (typeof port !== "number") throw new Error("rest capture server was not assigned a port");
  return { port, calls, close };
}

function parseBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null; // a malformed body is recorded as null, never a capture 500
  }
}
