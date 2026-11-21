import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockDiscord, startRestCapture, type MockDiscord, type RestCapture, type RestCall } from "./mock-discord";

const BOT_TOKEN = "bot-token-abcdef0123456789";
const GATEWAY_TOKEN = "gateway-token-wxyz9876543210";
const BOT_USER_ID = "bot-1";
const HEARTBEAT_INTERVAL_MS = 200;
const STUB_REPLY = "stub reply";
const GATEWAY_DIR = `${import.meta.dir}/..`;
const OP_IDENTIFY = 2;

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: (): Response => new Response("probe") });
  const port = probe.port;
  if (typeof port !== "number") throw new Error("probe server was not assigned a port");
  probe.stop(true);
  return port;
}

async function drain(stream: ReadableStream<Uint8Array>, lines?: string[]): Promise<void> {
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
      for (const line of complete) if (line.trim() !== "" && lines) lines.push(line);
    }
  } catch { /* killed child */ }
}

function writeConfig(workerPort: number, sttPort: number, mockCdnPort: number): string {
  const path = join(tmpdir(), `agent-gateway-nanny-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
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
    mode: transcribe
    endpointEnv: STT_ENDPOINT
    prefix: "[voice note] "
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
  // STT endpoint is injected via env, not the file, to keep the file secret-free.
  void sttPort; void mockCdnPort;
  return path;
}

type StubWorker = { port: number; calls: { auth: string | null; body: any }[]; close(): Promise<void> };
function startStubWorker(): StubWorker {
  const calls: { auth: string | null; body: any }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/inbound") {
        return new Response("not found", { status: 404 });
      }
      const body = await request.json().catch(() => ({}));
      calls.push({ auth: request.headers.get("Authorization"), body });
      return Response.json({ text: "stub reply" });
    },
  });
  return { port: server.port!, calls, close: async () => server.stop(true) };
}

function startMockWhisper(): { port: number; close(): Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      if (new URL(request.url).pathname !== "/asr") return new Response("nf", { status: 404 });
      return new Response("hello from the voice note", { headers: { "Content-Type": "text/plain" } });
    },
  });
  return { port: server.port!, close: async () => server.stop(true) };
}

function startMockCdn(bytes: any): { port: number; url: string; close(): Promise<void> } {
  const server = Bun.serve({
    port: 0,
    fetch(): Response {
      return new Response(bytes, { headers: { "Content-Type": "audio/ogg" } });
    },
  });
  return { port: server.port!, url: `http://127.0.0.1:${server.port}/audio.ogg`, close: async () => server.stop(true) };
}

const harnesses: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

describe("nanny-compat: the fork can serve hucklenanny unchanged", () => {
  test("IDENTIFY carries the nanny intent mask (33281)", async () => {
    const mock = startMockDiscord({ token: BOT_TOKEN, botUserId: BOT_USER_ID, heartbeatIntervalMs: 200 });
    const rest = startRestCapture({ botUserId: BOT_USER_ID });
    const worker = startStubWorker();
    const configPath = writeConfig(worker.port, 0, 0);
    const appPort = freePort();
    const lines: string[] = [];
    const proc = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: GATEWAY_DIR,
      stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        DISCORD_BOT_TOKEN: BOT_TOKEN,
        GATEWAY_TOKEN: GATEWAY_TOKEN,
        STT_ENDPOINT: "http://127.0.0.1:9",
        PORT: String(appPort),
        GATEWAY_CONFIG: configPath,
        DISCORD_GATEWAY_URL: `ws://127.0.0.1:${mock.port}/`,
        DISCORD_API_BASE: `http://127.0.0.1:${rest.port}`,
        LOG_LEVEL: "info",
      },
    });
    void drain(proc.stdout, lines); void drain(proc.stderr, lines);
    harnesses.push({ close: async () => { proc.kill(); await proc.exited; try { unlinkSync(configPath); } catch {} await mock.close(); await rest.close(); await worker.close(); } });

    // wait for ready
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${appPort}/health`)).ok) break; } catch {}
      await Bun.sleep(50);
    }
    const idDeadline = performance.now() + 5000;
    while (performance.now() < idDeadline && !mock.events.some((e) => e.op === OP_IDENTIFY)) await Bun.sleep(50);
    const identify = mock.events.find((e) => e.op === OP_IDENTIFY);
    expect(identify).toBeDefined();
    expect((identify!.d as { intents?: number }).intents).toBe(33281);
  });

  test("a bot-authored MESSAGE_CREATE yields zero /inbound calls", async () => {
    const mock = startMockDiscord({ token: BOT_TOKEN, botUserId: BOT_USER_ID, heartbeatIntervalMs: 200 });
    const rest = startRestCapture({ botUserId: BOT_USER_ID });
    const worker = startStubWorker();
    const configPath = writeConfig(worker.port, 0, 0);
    const appPort = freePort();
    const proc = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: GATEWAY_DIR, stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", DISCORD_BOT_TOKEN: BOT_TOKEN, GATEWAY_TOKEN: GATEWAY_TOKEN,
        PORT: String(appPort), GATEWAY_CONFIG: configPath,
        STT_ENDPOINT: "http://127.0.0.1:9", DISCORD_GATEWAY_URL: `ws://127.0.0.1:${mock.port}/`, DISCORD_API_BASE: `http://127.0.0.1:${rest.port}`, LOG_LEVEL: "info" },
    });
    void drain(proc.stdout); void drain(proc.stderr);
    harnesses.push({ close: async () => { proc.kill(); await proc.exited; try { unlinkSync(configPath); } catch {} await mock.close(); await rest.close(); await worker.close(); } });
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${appPort}/health`)).ok) break; } catch {} await Bun.sleep(50); }
    const idDeadline = performance.now() + 5000;
    while (performance.now() < idDeadline && !mock.events.some((e) => e.op === 2)) await Bun.sleep(50);
    mock.pushMessage({ channel_id: "c1", content: "hi", author: { id: "bot-2", username: "other", bot: true }, mentions: [{ id: BOT_USER_ID }], attachments: [] });
    await Bun.sleep(200);
    expect(worker.calls.length).toBe(0);
  });

  test("a voice note is transcribed and posted as [voice note] ...", async () => {
    const whisper = startMockWhisper();
    const cdn = startMockCdn(new Uint8Array([1, 2, 3]) as any);
    const mock = startMockDiscord({ token: BOT_TOKEN, botUserId: BOT_USER_ID, heartbeatIntervalMs: 200 });
    const rest = startRestCapture({ botUserId: BOT_USER_ID });
    const worker = startStubWorker();
    const configPath = join(tmpdir(), `nanny-voice-${Date.now()}.yaml`);
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
    mode: transcribe
    endpointEnv: STT_ENDPOINT
    prefix: "[voice note] "
inbound:
  url: http://127.0.0.1:${worker.port}
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
    writeFileSync(configPath, yaml);
    const appPort = freePort();
    const proc = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: GATEWAY_DIR, stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        DISCORD_BOT_TOKEN: BOT_TOKEN,
        GATEWAY_TOKEN: GATEWAY_TOKEN,
        STT_ENDPOINT: `http://127.0.0.1:${whisper.port}`,
        PORT: String(appPort),
        GATEWAY_CONFIG: configPath,
        DISCORD_GATEWAY_URL: `ws://127.0.0.1:${mock.port}/`,
        DISCORD_API_BASE: `http://127.0.0.1:${rest.port}`,
        LOG_LEVEL: "info",
      },
    });
    void drain(proc.stdout); void drain(proc.stderr);
    harnesses.push({ close: async () => { proc.kill(); await proc.exited; try { unlinkSync(configPath); } catch {} await mock.close(); await rest.close(); await worker.close(); await whisper.close(); await cdn.close(); } });
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${appPort}/health`)).ok) break; } catch {} await Bun.sleep(50); }
    const idDeadline = performance.now() + 5000;
    while (performance.now() < idDeadline && !mock.events.some((e) => e.op === 2)) await Bun.sleep(50);
    mock.pushMessage({
      channel_id: "c1", content: "", author: { id: "u1", username: "dadsmith", global_name: "Dad Smith", bot: false },
      member: { nick: "Dad" }, mentions: [], attachments: [{ url: cdn.url, content_type: "audio/ogg" }], flags: 0,
    });
    await Bun.sleep(500);
    expect(worker.calls.length).toBe(1);
    expect(worker.calls[0]!.body.speaker).toBe("Dad");
    expect(worker.calls[0]!.body.text).toBe("[voice note] hello from the voice note");
  });

  test("interactions route is absent when disabled", async () => {
    const mock = startMockDiscord({ token: BOT_TOKEN, botUserId: BOT_USER_ID, heartbeatIntervalMs: 200 });
    const rest = startRestCapture({ botUserId: BOT_USER_ID });
    const worker = startStubWorker();
    const configPath = writeConfig(worker.port, 0, 0);
    const appPort = freePort();
    const proc = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: GATEWAY_DIR, stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", DISCORD_BOT_TOKEN: BOT_TOKEN, GATEWAY_TOKEN: GATEWAY_TOKEN,
        PORT: String(appPort), GATEWAY_CONFIG: configPath,
        STT_ENDPOINT: "http://127.0.0.1:9", DISCORD_GATEWAY_URL: `ws://127.0.0.1:${mock.port}/`, DISCORD_API_BASE: `http://127.0.0.1:${rest.port}`, LOG_LEVEL: "info" },
    });
    void drain(proc.stdout); void drain(proc.stderr);
    harnesses.push({ close: async () => { proc.kill(); await proc.exited; try { unlinkSync(configPath); } catch {} await mock.close(); await rest.close(); await worker.close(); } });
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${appPort}/health`)).ok) break; } catch {} await Bun.sleep(50); }
    const res = await fetch(`http://127.0.0.1:${appPort}/interactions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});