import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockDiscord, startRestCapture, type MockDiscord, type RestCapture, type RestCall } from "./mock-discord";

// Offline e2e: the REAL sidecar (src/index.ts) runs as a child process with its
// env pointed at localhost stands — mock Discord gateway (WS), REST capture
// server, stub worker — so socket → handleMessage → worker POST → REST send are
// all production code paths. Only Discord and the worker are fake.

const BOT_TOKEN = "bot-token-abcdef0123456789";
const GATEWAY_TOKEN = "gateway-token-wxyz9876543210";
const BOT_USER_ID = "bot-1";
const HEARTBEAT_INTERVAL_MS = 200; // ~5 beats land inside the 1s slow-turn window
const STUB_REPLY = "stub reply";
const GATEWAY_DIR = `${import.meta.dir}/..`;

// v10 gateway opcodes read out of the mock's event log
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000, context: () => string = () => "condition"): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${context()}`);
    await Bun.sleep(5);
  }
}

function postsTo(rest: RestCapture, channelId: string, leaf: "messages" | "typing"): RestCall[] {
  return rest.calls.filter((c) => c.method === "POST" && c.path === `/channels/${channelId}/${leaf}`);
}

function mentionDispatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel_id: "c1",
    content: "hi",
    author: { id: "u1", username: "dadsmith", global_name: "Dad Smith", bot: false },
    member: { nick: "Dad" },
    mentions: [{ id: BOT_USER_ID }],
    attachments: [],
    ...overrides,
  };
}

type StubMode = { status: number; text?: string; delayMs?: number };

type InboundCall = { at: number; auth: string | null; body: unknown };

type StubWorker = {
  port: number;
  calls: InboundCall[];
  setMode(mode: StubMode): void;
  close(): Promise<void>;
};

function startStubWorker(initial: StubMode): StubWorker {
  const calls: InboundCall[] = [];
  let mode = initial;
  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/inbound") {
        return new Response("not found", { status: 404 });
      }
      const at = performance.now();
      const body = parseBody(await request.text());
      calls.push({ at, auth: request.headers.get("Authorization"), body });
      if (mode.delayMs) await Bun.sleep(mode.delayMs);
      return mode.status === 200
        ? Response.json({ text: mode.text ?? STUB_REPLY })
        : Response.json({}, { status: mode.status });
    },
  });

  function setMode(next: StubMode): void {
    mode = next;
  }

  async function close(): Promise<void> {
    server.stop(true);
    await Bun.sleep(10); // let close frames flush before the test ends
  }

  const port = server.port;
  if (typeof port !== "number") throw new Error("stub worker was not assigned a port");
  return { port, calls, setMode, close };
}

function parseBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeE2eConfig(workerPort: number): string {
  const path = join(tmpdir(), `agent-gateway-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  const yaml = `discord:
  tokenEnv: DISCORD_BOT_TOKEN
  applicationIdEnv: DISCORD_APPLICATION_ID
  intents: [GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT]
events:
  forward: [MESSAGE_CREATE]
  channels: []
message:
  requireMention: true
  ignoreBots: true
  audio:
    mode: off
inbound:
  url: http://127.0.0.1:${workerPort}
  authEnv: GATEWAY_TOKEN
  payload: chat
  timeoutMs: 90000
  retry: { attempts: 3, backoffMs: 500 }
interactions:
  enabled: false
  path: /interactions
  prefix: nanny
  defer: true
commands: []
typing:
  enabled: true
  intervalMs: 8000
logging:
  format: json
  level: info
  shipUrl: null
`;
  writeFileSync(path, yaml);
  return path;
}

function startSidecar(opts: { mockPort: number; restPort: number; workerPort: number }) {
  const appPort = freePort();
  const configPath = writeE2eConfig(opts.workerPort);
  const proc = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: GATEWAY_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      GATEWAY_TOKEN: GATEWAY_TOKEN,
      PORT: String(appPort),
      GATEWAY_CONFIG: configPath,
      DISCORD_GATEWAY_URL: `ws://127.0.0.1:${opts.mockPort}/`,
      DISCORD_API_BASE: `http://127.0.0.1:${opts.restPort}`,
      LOG_LEVEL: "info",
    },
  });
  const lines: string[] = [];
  void drain(proc.stdout, lines);
  void drain(proc.stderr, lines);
  return { proc, lines, appPort, configPath };
}

type Sidecar = ReturnType<typeof startSidecar>;

// The app binds PORT eagerly, so the number must exist before the spawn; the
// /health poll in ready() turns any lost race into a clear timeout.
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: (): Response => new Response("probe") });
  const port = probe.port;
  if (typeof port !== "number") throw new Error("probe server was not assigned a port");
  probe.stop(true);
  return port;
}

async function drain(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const complete = pending.split("\n");
      pending = complete.pop() ?? "";
      for (const line of complete) {
        if (line.trim() !== "") lines.push(line);
      }
    }
  } catch {
    // a killed child can error its pipes; keep whatever lines already landed
  }
}

type Harness = {
  mock: MockDiscord;
  rest: RestCapture;
  worker: StubWorker;
  sidecar: Sidecar;
  ready(): Promise<void>;
  stop(): Promise<void>;
};

const harnesses: Harness[] = [];

function startHarness(stubMode: StubMode): Harness {
  const mock = startMockDiscord({ token: BOT_TOKEN, botUserId: BOT_USER_ID, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
  const rest = startRestCapture({ botUserId: BOT_USER_ID });
  const worker = startStubWorker(stubMode);
  const sidecar = startSidecar({ mockPort: mock.port, restPort: rest.port, workerPort: worker.port });

  function sidecarLines(): string {
    return sidecar.lines.slice(-5).join(" | ") || "(no output yet)";
  }

  async function ready(): Promise<void> {
    await waitFor(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${sidecar.appPort}/health`)).ok;
        } catch {
          return false;
        }
      },
      5000,
      () => `sidecar /health on :${sidecar.appPort}; lines: ${sidecarLines()}`,
    );
    await waitFor(
      () => mock.events.some((e) => e.op === OP_IDENTIFY),
      5000,
      () => `IDENTIFY in mock events; lines: ${sidecarLines()}`,
    );
    // "ready as mock-bot" proves the child processed READY, so a push lands in a live session
    await waitFor(
      () => sidecar.lines.some((line) => line.includes("ready as mock-bot")),
      5000,
      () => `sidecar READY log; lines: ${sidecarLines()}`,
    );
  }

  async function stop(): Promise<void> {
    sidecar.proc.kill();
    await sidecar.proc.exited;
    try { unlinkSync(sidecar.configPath); } catch { /* best effort */ }
    await mock.close();
    await rest.close();
    await worker.close();
  }

  const harness: Harness = { mock, rest, worker, sidecar, ready, stop };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()!.stop();
  }
});

describe("gateway e2e — the real sidecar (src/index.ts) against a mock Discord", () => {
  test("(a) happy turn: mention → worker sees Bearer + shaped body → reply posted → typing fired", async () => {
    const h = startHarness({ status: 200 });
    await h.ready();

    h.mock.pushMessage(mentionDispatch());

    await waitFor(() => h.worker.calls.length === 1, 5000, () => `worker /inbound call (have ${h.worker.calls.length})`);
    expect(h.worker.calls[0]!.auth).toBe(`Bearer ${GATEWAY_TOKEN}`);
    expect(h.worker.calls[0]!.body).toEqual({ chatId: "discord:c1", speaker: "Dad", text: "hi" });

    await waitFor(
      () => postsTo(h.rest, "c1", "messages").length === 1,
      5000,
      () => `reply POST /channels/c1/messages (have ${postsTo(h.rest, "c1", "messages").length})`,
    );
    const reply = postsTo(h.rest, "c1", "messages")[0]!;
    expect(reply.auth).toBe(`Bot ${BOT_TOKEN}`);
    expect(reply.body).toEqual({ content: STUB_REPLY });

    await waitFor(
      () => postsTo(h.rest, "c1", "typing").length >= 1,
      5000,
      () => `typing POST /channels/c1/typing (have ${postsTo(h.rest, "c1", "typing").length})`,
    );
  }, 15000);

  test("(b) a bot-authored MESSAGE_CREATE that mentions the bot yields zero /inbound calls", async () => {
    const h = startHarness({ status: 200 });
    await h.ready();

    h.mock.pushMessage(
      mentionDispatch({
        content: "the nanny talking to itself",
        author: { id: BOT_USER_ID, username: "mock-bot", bot: true },
      }),
    );
    // Frames on one socket are handled in order and the bot-authored frame is
    // filtered synchronously, so once the human turn below completes, the bot
    // frame is provably done — and only the human turn ever reached the worker.
    h.mock.pushMessage(mentionDispatch({ content: "human follow-up" }));

    await waitFor(
      () => postsTo(h.rest, "c1", "messages").some((c) => (c.body as { content?: string }).content === STUB_REPLY),
      5000,
      () => `human turn's reply POST`,
    );

    expect(h.worker.calls).toHaveLength(1);
    expect((h.worker.calls[0]!.body as { text?: string }).text).toBe("human follow-up");
  }, 15000);

  test("(c) op1 heartbeats keep flowing while a slow worker turn is in flight", async () => {
    const h = startHarness({ status: 200, delayMs: 1000 });
    await h.ready();

    h.mock.pushMessage(mentionDispatch({ content: "slow please" }));

    await waitFor(
      () => postsTo(h.rest, "c1", "messages").length === 1,
      8000,
      () => `slow turn's reply POST (have ${postsTo(h.rest, "c1", "messages").length})`,
    );
    expect(h.worker.calls).toHaveLength(1);

    const turnStart = h.worker.calls[0]!.at; // inbound arrival
    const turnEnd = postsTo(h.rest, "c1", "messages")[0]!.at; // reply posted
    expect(turnEnd - turnStart).toBeGreaterThanOrEqual(900); // the 1s delay really happened

    const beatsDuringTurn = h.mock.events.filter((e) => e.op === OP_HEARTBEAT && e.at > turnStart && e.at < turnEnd);
    expect(beatsDuringTurn.length).toBeGreaterThanOrEqual(2);
  }, 15000);

  test("(d-i) worker 503 → the error-reply channel message fires", async () => {
    const h = startHarness({ status: 503 });
    await h.ready();

    h.mock.pushMessage(mentionDispatch());

    await waitFor(
      () => postsTo(h.rest, "c1", "messages").length === 1,
      5000,
      () => `error-reply POST (have ${postsTo(h.rest, "c1", "messages").length})`,
    );
    expect(h.worker.calls).toHaveLength(1);
    expect(postsTo(h.rest, "c1", "messages")[0]!.body).toEqual({ content: "Something went wrong: worker HTTP 503" });
  }, 15000);

  test("(d-ii) worker 404 → retryable: warn only, no error-reply message", async () => {
    const h = startHarness({ status: 404 });
    await h.ready();

    h.mock.pushMessage(mentionDispatch());

    await waitFor(() => h.worker.calls.length === 1, 5000, () => `worker /inbound call (have ${h.worker.calls.length})`);
    // the warn line is the retryable branch's fingerprint — it fires nowhere else
    await waitFor(
      () => h.sidecar.lines.some((line) => line.includes("worker not ready for discord:c1")),
      5000,
      () => `sidecar warn line; lines: ${h.sidecar.lines.slice(-5).join(" | ")}`,
    );
    expect(postsTo(h.rest, "c1", "messages")).toHaveLength(0);
  }, 15000);

  test("(e) POST /send through the same app end-to-end", async () => {
    const h = startHarness({ status: 200 });
    await h.ready();

    const res = await fetch(`http://127.0.0.1:${h.sidecar.appPort}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "discord:c9", body: "time for a feed" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, messageId: "m-1" });
    // /send awaits rest.sendMessage, so the capture record exists before the response
    expect(postsTo(h.rest, "c9", "messages")).toHaveLength(1);
    expect(postsTo(h.rest, "c9", "messages")[0]!.body).toEqual({ content: "time for a feed" });
  }, 15000);
});
