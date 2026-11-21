import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockDiscord, startRestCapture } from "./mock-discord";

const BOT_TOKEN = "bot-token-abcdef0123456789";
const GATEWAY_TOKEN = "gateway-token-wxyz9876543210";
const BOT_USER_ID = "bot-1";
const GATEWAY_DIR = `${import.meta.dir}/..`;

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: (): Response => new Response("probe") });
  const port = probe.port;
  if (typeof port !== "number") throw new Error("probe server was not assigned a port");
  probe.stop(true);
  return port;
}

async function drain(s: ReadableStream<Uint8Array>, lines?: string[]): Promise<void> {
  const r = s.getReader();
  const dec = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      pending += dec.decode(value, { stream: true });
      const complete = pending.split("\n");
      pending = complete.pop() ?? "";
      for (const line of complete) if (line.trim() !== "" && lines) lines.push(line);
    }
  } catch {}
}

describe("event mode: raw dispatches are forwarded to the consumer", () => {
  test("MESSAGE_REACTION_ADD is forwarded to /discord/events", async () => {
    const mock = startMockDiscord({ token: BOT_TOKEN, botUserId: BOT_USER_ID, heartbeatIntervalMs: 200 });
    const rest = startRestCapture({ botUserId: BOT_USER_ID });

    const received: any[] = [];
    const consumer = Bun.serve({
      port: 0,
      async fetch(req): Promise<Response> {
        if (req.method === "POST" && new URL(req.url).pathname === "/discord/events") {
          received.push(await req.json());
          return Response.json({ ok: true });
        }
        return new Response("nf", { status: 404 });
      },
    });
    const consumerPort = consumer.port!;

    const configPath = join(tmpdir(), `agent-gateway-event-${Date.now()}.yaml`);
    writeFileSync(configPath, `discord:
  tokenEnv: DISCORD_BOT_TOKEN
  applicationIdEnv: DISCORD_APPLICATION_ID
  intents: [GUILDS, GUILD_MESSAGE_REACTIONS]
events:
  forward: [MESSAGE_CREATE, MESSAGE_REACTION_ADD, MESSAGE_REACTION_REMOVE]
  channels: []
message:
  requireMention: false
  ignoreBots: true
  audio:
    mode: off
inbound:
  url: http://127.0.0.1:${consumerPort}/discord/events
  authEnv: GATEWAY_TOKEN
  payload: event
  timeoutMs: 5000
  retry: { attempts: 2, backoffMs: 100 }
interactions:
  enabled: false
  path: /interactions
  prefix: deal
  defer: true
commands: []
typing:
  enabled: false
  intervalMs: 8000
logging:
  format: json
  level: info
  shipUrl: null
`);

    const appPort = freePort();
    const lines: string[] = [];
    const proc = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: GATEWAY_DIR, stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        DISCORD_BOT_TOKEN: BOT_TOKEN,
        GATEWAY_TOKEN: GATEWAY_TOKEN,
        DISCORD_APPLICATION_ID: "app1",
        PORT: String(appPort),
        GATEWAY_CONFIG: configPath,
        DISCORD_GATEWAY_URL: `ws://127.0.0.1:${mock.port}/`,
        DISCORD_API_BASE: `http://127.0.0.1:${rest.port}`,
        LOG_LEVEL: "info",
      },
    });
    void drain(proc.stdout, lines); void drain(proc.stderr, lines);

    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${appPort}/health`)).ok) break; } catch {}
      await Bun.sleep(50);
    }
    await Bun.sleep(500);
    const idDeadline = performance.now() + 5000;
    while (performance.now() < idDeadline && !mock.events.some((e) => e.op === 2)) await Bun.sleep(50);
    while (performance.now() < idDeadline && !mock.events.some((e) => e.op === 2)) await Bun.sleep(50);

    mock.pushMessage({ channel_id: "c1", content: "hi", author: { id: "u1", username: "u", bot: false }, mentions: [], attachments: [] });
    await Bun.sleep(200);

    const before = received.length;
    mock.push("MESSAGE_REACTION_ADD", {
      channel_id: "c1", guild_id: "g1", user_id: "u1",
      message_id: "m1", emoji: { name: "✅" },
    });
    await Bun.sleep(200);

    expect(received.length).toBeGreaterThanOrEqual(before + 1);
    const reaction = received.find((r) => r.type === "MESSAGE_REACTION_ADD");
    expect(reaction).toBeDefined();
    expect(reaction.channelId).toBe("c1");
    expect(reaction.event.emoji.name).toBe("✅");

    proc.kill();
    await proc.exited;
    try { unlinkSync(configPath); } catch {}
    await mock.close();
    await rest.close();
    consumer.stop(true);
  });
});