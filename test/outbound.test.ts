import { describe, expect, test } from "bun:test";

import { createApp } from "../src/app";
import type { DiscordRest } from "../src/discord/rest";
import { TypingScopes } from "../src/discord/typing-scopes";
import { createLogger } from "../src/log";
import type { WorkerClient } from "../src/worker-client";

const TOKEN = "sekrit";

function restSpy(): { rest: DiscordRest; calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const rest = {
    sendMessage: async () => ({ id: "m1" }),
    editMessage: async (c: string, m: string, b: unknown) => { calls.push({ method: "PATCH", path: `/channels/${c}/messages/${m}`, body: b }); },
    addReaction: async (c: string, m: string, e: string) => { calls.push({ method: "PUT", path: `/channels/${c}/messages/${m}/reactions/${e}/@me` }); },
    triggerTyping: async (c: string) => { calls.push({ method: "POST", path: `/channels/${c}/typing` }); },
    getMe: async () => ({ id: "x", username: "b" }),
  } as unknown as DiscordRest;
  return { rest, calls };
}

function workerStub(): WorkerClient {
  return { runTurn: async () => ({ text: "ok" }) } as unknown as WorkerClient;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://x${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function patch(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://x${path}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("outbound routes", () => {
  test("PATCH /messages edits with auth", async () => {
    const { rest, calls } = restSpy();
    const app = createApp({ rest, token: TOKEN, typingScopes: new TypingScopes(rest, 1000) });
    const res = await app.fetch(patch("/messages/c1/m1", { content: "edited" }, { Authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ content: "edited" });
  });

  test("PATCH /messages rejects bad token", async () => {
    const { rest } = restSpy();
    const app = createApp({ rest, token: TOKEN });
    const res = await app.fetch(patch("/messages/c1/m1", { content: "x" }, { Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  test("POST /react requires fields", async () => {
    const { rest } = restSpy();
    const app = createApp({ rest, token: TOKEN });
    const res = await app.fetch(post("/react", { channelId: "c1" }, { Authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(400);
  });

  test("POST /react happy path", async () => {
    const { rest, calls } = restSpy();
    const app = createApp({ rest, token: TOKEN });
    const res = await app.fetch(post("/react", { channelId: "c1", messageId: "m1", emoji: "✅" }, { Authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(calls[0]!.path).toContain("/reactions/");
  });

  test("POST /work + /done drives typing scopes", async () => {
    const { rest } = restSpy();
    const scopes = new TypingScopes(rest, 1000);
    const app = createApp({ rest, token: TOKEN, typingScopes: scopes });
    const r1 = await app.fetch(post("/work", { channelId: "c1", requestId: "r1" }, { Authorization: `Bearer ${TOKEN}` }));
    expect(r1.status).toBe(200);
    expect(scopes.activeCount()).toBe(1);
    const r2 = await app.fetch(post("/done", { requestId: "r1", channelId: "c1" }, { Authorization: `Bearer ${TOKEN}` }));
    expect(r2.status).toBe(200);
    expect(scopes.activeCount()).toBe(0);
  });

  test("POST /typing fires once", async () => {
    const { rest, calls } = restSpy();
    const app = createApp({ rest, token: TOKEN });
    const res = await app.fetch(post("/typing", { channelId: "c1" }, { Authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.path === "/channels/c1/typing")).toBe(true);
  });
});