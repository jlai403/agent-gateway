import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";

import { createApp } from "../src/app";
import type { DiscordRest } from "../src/discord/rest";
import type { InteractionDeps } from "../src/interactions";

const TOKEN = "sekrit";

function restStub(): DiscordRest {
  return { sendMessage: async () => ({ id: "m1" }), editMessage: async () => {}, addReaction: async () => {}, triggerTyping: async () => {}, getMe: async () => ({ id: "x", username: "b" }) } as unknown as DiscordRest;
}

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const hex = spki.subarray(spki.length - 32).toString("hex");
  return { hex, privateKey };
}

function signBody(privateKey: any, body: string): { sig: string; ts: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = Buffer.from(ts + body);
  const sig = sign(null, msg, privateKey).toString("hex");
  return { sig, ts };
}

describe("interactions", () => {
  test("PING returns PONG", async () => {
    const { hex, privateKey } = makeKeys();
    const body = JSON.stringify({ type: 1 });
    const { sig, ts } = signBody(privateKey, body);
    const deps: InteractionDeps = {
      publicKey: hex, applicationId: "app1", consumerUrl: "http://consumer:8080",
      consumerToken: "tok", prefix: "deal", defer: true, deferWindowMs: 50, timeoutMs: 1000,
    };
    const app = createApp({ rest: restStub(), token: TOKEN, interactions: deps });
    const res = await app.fetch(new Request("http://x/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts },
      body,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  test("bad signature → 401", async () => {
    const { hex } = makeKeys();
    const body = JSON.stringify({ type: 1 });
    const deps: InteractionDeps = {
      publicKey: hex, applicationId: "app1", consumerUrl: "http://consumer:8080",
      consumerToken: "tok", prefix: "deal", defer: true, deferWindowMs: 50, timeoutMs: 1000,
    };
    const app = createApp({ rest: restStub(), token: TOKEN, interactions: deps });
    const res = await app.fetch(new Request("http://x/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": "00".repeat(64), "X-Signature-Timestamp": String(Math.floor(Date.now() / 1000)) },
      body,
    }));
    expect(res.status).toBe(401);
  });

  test("missing signature → 401", async () => {
    const { hex } = makeKeys();
    const deps: InteractionDeps = {
      publicKey: hex, applicationId: "app1", consumerUrl: "http://consumer:8080",
      consumerToken: "tok", prefix: "deal", defer: true, deferWindowMs: 50, timeoutMs: 1000,
    };
    const app = createApp({ rest: restStub(), token: TOKEN, interactions: deps });
    const res = await app.fetch(new Request("http://x/interactions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: 1 }),
    }));
    expect(res.status).toBe(401);
  });

  test("stale timestamp → 401", async () => {
    const { hex, privateKey } = makeKeys();
    const body = JSON.stringify({ type: 1 });
    const { sig } = signBody(privateKey, body);
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    // re-sign with old ts
    const msg = Buffer.from(oldTs + body);
    const sig2 = sign(null, msg, privateKey).toString("hex");
    const deps: InteractionDeps = {
      publicKey: hex, applicationId: "app1", consumerUrl: "http://consumer:8080",
      consumerToken: "tok", prefix: "deal", defer: true, deferWindowMs: 50, timeoutMs: 1000,
    };
    const app = createApp({ rest: restStub(), token: TOKEN, interactions: deps });
    const res = await app.fetch(new Request("http://x/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": sig2, "X-Signature-Timestamp": oldTs },
      body,
    }));
    expect(res.status).toBe(401);
  });

  test("modal returned within window is returned verbatim", async () => {
    const { hex, privateKey } = makeKeys();
    const body = JSON.stringify({ type: 3, data: { custom_id: "deal:prefs:kw" }, token: "tok123" });
    const { sig, ts } = signBody(privateKey, body);
    const deps: InteractionDeps = {
      publicKey: hex, applicationId: "app1", consumerUrl: "http://consumer:8080",
      consumerToken: "tok", prefix: "deal", defer: true, deferWindowMs: 200, timeoutMs: 1000,
      fetchImpl: (async () => new Response(JSON.stringify({ type: 9, data: { custom_id: "deal:prefs:kw", title: "Kw", components: [] } }), { status: 200 })) as any,
    };
    const app = createApp({ rest: restStub(), token: TOKEN, interactions: deps });
    const res = await app.fetch(new Request("http://x/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts },
      body,
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.type).toBe(9);
  });

  test("slow consumer falls back to defer", async () => {
    const { hex, privateKey } = makeKeys();
    const body = JSON.stringify({ type: 3, data: { custom_id: "deal:prefs:kw" }, token: "tok123" });
    const { sig, ts } = signBody(privateKey, body);
    const deps: InteractionDeps = {
      publicKey: hex, applicationId: "app1", consumerUrl: "http://consumer:8080",
      consumerToken: "tok", prefix: "deal", defer: true, deferWindowMs: 50, timeoutMs: 1000,
      fetchImpl: (async () => { await Bun.sleep(200); return new Response(JSON.stringify({ type: 9, data: { custom_id: "deal:prefs:kw", title: "Kw", components: [] } }), { status: 200 }); }) as any,
    };
    const app = createApp({ rest: restStub(), token: TOKEN, interactions: deps });
    const res = await app.fetch(new Request("http://x/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts },
      body,
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.type).toBe(6); // deferred
  });

  test("unknown prefix → 400", async () => {
    const { hex, privateKey } = makeKeys();
    const body = JSON.stringify({ type: 2, data: { custom_id: "nanny:prefs" }, token: "tok123" });
    const { sig, ts } = signBody(privateKey, body);
    const deps: InteractionDeps = {
      publicKey: hex, applicationId: "app1", consumerUrl: "http://consumer:8080",
      consumerToken: "tok", prefix: "deal", defer: true, deferWindowMs: 50, timeoutMs: 1000,
    };
    const app = createApp({ rest: restStub(), token: TOKEN, interactions: deps });
    const res = await app.fetch(new Request("http://x/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts },
      body,
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.type).toBe(4);
  });
});