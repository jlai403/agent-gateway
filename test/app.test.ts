import { describe, expect, test } from "bun:test";

import { createApp, handleMessage, type HandleMessageDeps } from "../src/app";
import type { DiscordRest } from "../src/discord/rest";
import type { InboundMessage } from "../src/discord/messages";
import { createLogger } from "../src/log";
import type { TurnResult, WorkerClient } from "../src/worker-client";

const TOKEN = "sekrit";
const BOT_ID = "999";

type SendCall = { channelId: string; content: string };

function restSpy(events?: string[]): { rest: DiscordRest; sends: SendCall[] } {
  const sends: SendCall[] = [];
  const rest = {
    sendMessage: async (channelId: string, content: string): Promise<{ id: string }> => {
      sends.push({ channelId, content });
      events?.push(`send:${channelId}`);
      return { id: "m1" };
    },
    triggerTyping: async (_channelId: string): Promise<void> => {},
  } as unknown as DiscordRest;
  return { rest, sends };
}

function tickerSpy(events: string[]): (rest: DiscordRest, channelId: string) => () => void {
  return (_rest, channelId) => {
    events.push(`typing:${channelId}`);
    return () => events.push(`cancel:${channelId}`);
  };
}

function captureLog(): { log: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger("app-test", { level: "debug", write: (line) => lines.push(line) }), lines };
}

function postInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function mentionDispatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel_id: "c1",
    content: "hi nanny",
    author: { id: "1", username: "dadsmith", global_name: "Dad Smith", bot: false },
    member: { nick: "Dad" },
    mentions: [{ id: BOT_ID }],
    attachments: [],
    ...overrides,
  };
}

function turnHarness(
  turn: TurnResult,
  transcribe: HandleMessageDeps["transcribe"] = null,
): {
  deps: HandleMessageDeps;
  sends: SendCall[];
  turns: InboundMessage[];
  events: string[];
  lines: string[];
} {
  const events: string[] = [];
  const { rest, sends } = restSpy(events);
  const { log, lines } = captureLog();
  const turns: InboundMessage[] = [];
  const worker = {
    runTurn: async (msg: InboundMessage): Promise<TurnResult> => {
      turns.push(msg);
      events.push("turn");
      return turn;
    },
  } as unknown as WorkerClient;
  return {
    deps: { rest, worker, log, botUserId: BOT_ID, transcribe, startTicker: tickerSpy(events) },
    sends,
    turns,
    events,
    lines,
  };
}

describe("createApp", () => {
  test("GET /health reports ok, the image version, and whether STT is configured", async () => {
    const { rest } = restSpy();
    const app = createApp({ rest, token: TOKEN, version: "v9.9.9", sttConfigured: true });

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    // The version is how a deploy proves which image is serving: `ok:true` alone
    // is satisfied by a sidecar from last week. STT is reported here because the
    // worker's deploy gate no longer owns that config.
    expect(await res.json()).toEqual({ ok: true, version: "v9.9.9", stt: true });
  });

  test("GET /health falls back to dev when no version is baked in", async () => {
    const { rest } = restSpy();
    expect(await (await createApp({ rest, token: TOKEN }).request("/health")).json()).toEqual({
      ok: true,
      version: "dev",
      stt: false,
    });
  });

  describe("POST /send", () => {
    test("missing bearer is rejected with 401 and never reaches discord", async () => {
      const { rest, sends } = restSpy();
      const app = createApp({ rest, token: TOKEN });

      const res = await app.request("/send", postInit({ chatId: "discord:c1", body: "time for a feed" }));

      expect(res.status).toBe(401);
      expect(sends).toHaveLength(0);
    });

    test("a wrong or malformed bearer is rejected with 401", async () => {
      const { rest } = restSpy();
      const app = createApp({ rest, token: TOKEN });

      const wrong = await app.request(
        "/send",
        postInit({ chatId: "discord:c1", body: "x" }, { Authorization: "Bearer nope" }),
      );
      const malformed = await app.request(
        "/send",
        postInit({ chatId: "discord:c1", body: "x" }, { Authorization: `Bot ${TOKEN}` }),
      );

      expect(wrong.status).toBe(401);
      expect(malformed.status).toBe(401);
    });

    test("happy path strips the discord: prefix and returns { sent: true }", async () => {
      const { rest, sends } = restSpy();
      const app = createApp({ rest, token: TOKEN });

      const res = await app.request(
        "/send",
        postInit({ chatId: "discord:c1", body: "time for a feed" }, { Authorization: `Bearer ${TOKEN}` }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: true, messageId: "m1" });
      expect(sends).toEqual([{ channelId: "c1", content: "time for a feed" }]);
    });

    test("a chatId without the prefix passes through unchanged", async () => {
      const { rest, sends } = restSpy();
      const app = createApp({ rest, token: TOKEN });

      await app.request("/send", postInit({ chatId: "c1", body: "x" }, { Authorization: `Bearer ${TOKEN}` }));

      expect(sends).toEqual([{ channelId: "c1", content: "x" }]);
    });

    test("a malformed body is a 400, not a discord call", async () => {
      const { rest, sends } = restSpy();
      const app = createApp({ rest, token: TOKEN });

      const res = await app.request("/send", postInit({ chatId: "discord:c1" }, { Authorization: `Bearer ${TOKEN}` }));

      expect(res.status).toBe(400);
      expect(sends).toHaveLength(0);
    });

    test("a discord send failure is a 502 carrying the error", async () => {
      const rest = {
        sendMessage: async (): Promise<void> => {
          throw new Error("discord POST /channels/c1/messages failed: 403");
        },
        triggerTyping: async (): Promise<void> => {},
      } as unknown as DiscordRest;
      const app = createApp({ rest, token: TOKEN });

      const res = await app.request("/send", postInit({ chatId: "discord:c1", body: "x" }, { Authorization: `Bearer ${TOKEN}` }));

      expect(res.status).toBe(502);
      expect(((await res.json()) as { error?: string }).error).toContain("403");
    });
  });
});

describe("handleMessage", () => {
  test("a dispatch that never mentions the bot starts nothing", async () => {
    const h = turnHarness({ text: "unreachable" });

    await handleMessage(h.deps, mentionDispatch({ mentions: [{ id: "555" }] }), "MESSAGE_CREATE");

    expect(h.turns).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.lines.some((line) => line.includes('"level":"debug"'))).toBe(true);
  });

  test("a MESSAGE_UPDATE dispatch mentioning the bot is dropped before the shape filter", async () => {
    const h = turnHarness({ text: "unreachable" });
    // MESSAGE_UPDATE carries the same author/mentions/content as a create, plus id
    // and edited_timestamp — without the t-gate this passes toInboundMessage and
    // answers an edit like a second message.
    const update = mentionDispatch({
      id: "m1",
      edited_timestamp: "2026-11-07T12:00:00.000+00:00",
      content: "edited: hi nanny again",
    });

    await handleMessage(h.deps, update, "MESSAGE_UPDATE");

    expect(h.turns).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.lines.some((line) => line.includes("MESSAGE_UPDATE"))).toBe(true);
    expect(h.lines.some((line) => line.includes('"level":"debug"'))).toBe(true);
  });

  test("an untyped dispatch is dropped — only an explicit MESSAGE_CREATE turns", async () => {
    const h = turnHarness({ text: "unreachable" });

    await handleMessage(h.deps, mentionDispatch());

    expect(h.turns).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.lines.some((line) => line.includes("untyped"))).toBe(true);
  });

  test("happy turn: typing precedes the turn, the reply lands in the channel, typing cancels last", async () => {
    const h = turnHarness({ text: "stub reply" });

    await handleMessage(h.deps, mentionDispatch(), "MESSAGE_CREATE");

    expect(h.turns).toEqual([{ chatId: "discord:c1", speaker: "Dad", text: "hi nanny" }]);
    expect(h.sends).toEqual([{ channelId: "c1", content: "stub reply" }]);
    expect(h.events).toEqual(["typing:c1", "turn", "send:c1", "cancel:c1"]);
  });

  test("a hard worker failure replies with the fixed error copy", async () => {
    const h = turnHarness({ error: "worker HTTP 500" });

    await handleMessage(h.deps, mentionDispatch(), "MESSAGE_CREATE");

    expect(h.sends).toEqual([{ channelId: "c1", content: "Something went wrong: worker HTTP 500" }]);
    expect(h.events).toEqual(["typing:c1", "turn", "send:c1", "cancel:c1"]);
  });

  test("a retryable failure warns and leaves the channel silent", async () => {
    const h = turnHarness({ error: "worker HTTP 404", retryable: true });

    await handleMessage(h.deps, mentionDispatch(), "MESSAGE_CREATE");

    expect(h.sends).toHaveLength(0);
    expect(h.events).toEqual(["typing:c1", "turn", "cancel:c1"]);
    expect(h.lines.some((line) => line.includes('"level":"warn"'))).toBe(true);
  });
});


describe("voice notes", () => {
  const voiceDispatch = (over: Record<string, unknown> = {}) => ({
    channel_id: "123",
    content: "",
    author: { id: "1", username: "dadsmith", bot: false },
    member: { nick: "Dad" },
    mentions: [],
    flags: 8192,
    attachments: [{ url: "https://cdn/voice.ogg", content_type: "audio/ogg" }],
    ...over,
  });

  test("a voice note is a turn even though it cannot carry a mention", async () => {
    const h = turnHarness({ text: "noted" }, async () => "jensen slept");
    await handleMessage(h.deps, voiceDispatch(), "MESSAGE_CREATE");

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]).toEqual({
      chatId: "discord:123",
      speaker: "Dad",
      text: "[voice note] jensen slept",
    });
    // Media never crosses the seam.
    expect(h.turns[0]?.attachment).toBeUndefined();
    expect(h.sends.at(-1)?.content).toBe("noted");
  });

  test("an uploaded audio file with no mention is also a turn", async () => {
    const h = turnHarness({ text: "noted" }, async () => "hello");
    const dispatch = voiceDispatch({ flags: 0 });
    await handleMessage(h.deps, dispatch, "MESSAGE_CREATE");
    expect(h.turns).toHaveLength(1);
  });

  test("a silent text message with no mention is still dropped", async () => {
    const h = turnHarness({ text: "should not happen" });
    await handleMessage(h.deps, voiceDispatch({ content: "hi there", flags: 0, attachments: [] }), "MESSAGE_CREATE");
    expect(h.turns).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  });

  test("an unreadable voice note posts the copy and never reaches the worker", async () => {
    const h = turnHarness({ text: "should not happen" }, async () => null);
    await handleMessage(h.deps, voiceDispatch(), "MESSAGE_CREATE");

    expect(h.turns).toHaveLength(0);
    expect(h.sends.at(-1)?.content).toContain("couldn't transcribe that voice note");
  });

  test("STT disabled behaves like a failed transcription", async () => {
    const h = turnHarness({ text: "should not happen" }, null);
    await handleMessage(h.deps, voiceDispatch(), "MESSAGE_CREATE");
    expect(h.turns).toHaveLength(0);
    expect(h.sends.at(-1)?.content).toContain("couldn't transcribe that voice note");
  });
});
