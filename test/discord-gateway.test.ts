import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { DiscordGateway, type ReadyUser } from "../src/discord/gateway";
import { startMockDiscord, type MockDiscord } from "./mock-discord";

// The client logs at info in production; silence it so bun test output stays clean.
process.env.LOG_LEVEL = "error";

const TOKEN = "test-token";
const INTENTS = 33281;
const BOT_USER_ID = "bot-1";
const BACKOFF_CAP_MS = 50;
const HEARTBEAT_INTERVAL_MS = 25;

type Session = {
  mock: MockDiscord;
  gw: DiscordGateway;
  received: unknown[];
  eventTypes: (string | undefined)[];
  readyUser: () => ReadyUser | undefined;
};

const sessions: Session[] = [];

function startSession(): Session {
  const mock = startMockDiscord({ token: TOKEN, botUserId: BOT_USER_ID, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
  const received: unknown[] = [];
  const eventTypes: (string | undefined)[] = [];
  let ready: ReadyUser | undefined;
  const gw = new DiscordGateway(
    { token: TOKEN, intents: INTENTS, url: `ws://127.0.0.1:${mock.port}/`, backoffCapMs: BACKOFF_CAP_MS },
    {
      onMessage: (d, t) => {
        received.push(d);
        eventTypes.push(t);
      },
      onReady: (user) => {
        ready = user;
      },
    },
  );
  const session: Session = { mock, gw, received, eventTypes, readyUser: () => ready };
  sessions.push(session);
  gw.start();
  return session;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await sleep(5);
  }
}

afterEach(async () => {
  while (sessions.length > 0) {
    const { gw, mock } = sessions.pop()!;
    gw.stop();
    await mock.close();
  }
});

afterAll(() => {
  delete process.env.LOG_LEVEL;
});

describe("DiscordGateway against a mock Discord v10 gateway", () => {
  test("(a) IDENTIFY carries the token, intents and hucklenanny properties", async () => {
    const { mock } = startSession();

    await waitFor(() => mock.events.some((e) => e.op === 2));
    const identify = mock.events.find((e) => e.op === 2)!;
    const d = identify.d as { token?: string; intents?: number; properties?: Record<string, string> };

    expect(d.token).toBe(TOKEN);
    expect(d.intents).toBe(INTENTS);
    expect(d.properties).toEqual({ os: "linux", browser: "hucklenanny-gateway", device: "hucklenanny-gateway" });
  });

  test("(a2) IDENTIFY carries presence when configured", async () => {
    const mock = startMockDiscord({ token: TOKEN, botUserId: BOT_USER_ID, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
    const gw = new DiscordGateway(
      {
        token: TOKEN, intents: INTENTS, url: `ws://127.0.0.1:${mock.port}/`,
        backoffCapMs: BACKOFF_CAP_MS,
        presence: { status: "online", activities: [{ name: "for deals", type: 3 }] },
      },
      { onMessage: () => {}, onReady: () => {} },
    );
    gw.start();
    await waitFor(() => mock.events.some((e) => e.op === 2));
    const identify = mock.events.find((e) => e.op === 2)!;
    const d = identify.d as { presence?: { status: string; since: number | null; afk: boolean; activities: { name: string; type: number }[] } };
    expect(d.presence).toEqual({ status: "online", since: null, afk: false, activities: [{ name: "for deals", type: 3 }] });
    gw.stop();
    await mock.close();
  });

  test("(b) READY fires onReady with the mock bot's user", async () => {
    const { readyUser } = startSession();

    await waitFor(() => readyUser() !== undefined);

    expect(readyUser()).toEqual({ id: BOT_USER_ID, username: "mock-bot" });
  });

  test("(c) a MESSAGE_CREATE dispatch reaches onMessage with its data", async () => {
    const { mock, received, readyUser } = startSession();
    await waitFor(() => readyUser() !== undefined);

    const message = { content: "hello nanny", channel_id: "c1" };
    mock.pushMessage(message);

    await waitFor(() => received.some((m) => (m as { content?: string }).content === "hello nanny"));
    expect(received).toContainEqual(message);
    // the dispatch carried s:2, so every later heartbeat must echo it
    await waitFor(() => mock.events.some((e) => e.op === 1 && e.d === 2));
  });

  test("(f) a MESSAGE_CREATE dispatch reaches onMessage with its event type as the second argument", async () => {
    const { mock, received, eventTypes, readyUser } = startSession();
    await waitFor(() => readyUser() !== undefined);

    mock.pushMessage({ content: "typed hello", channel_id: "c1" });

    await waitFor(() => received.some((m) => (m as { content?: string }).content === "typed hello"));
    const at = received.findIndex((m) => (m as { content?: string }).content === "typed hello");
    expect(eventTypes[at]).toBe("MESSAGE_CREATE");
  });

  test("(d) a server-side close still yields a re-IDENTIFY within the backoff cap", async () => {
    const { mock, readyUser } = startSession();
    await waitFor(() => readyUser() !== undefined);
    expect(mock.events.filter((e) => e.op === 2)).toHaveLength(1);

    const closedAt = performance.now();
    mock.closeClient();

    await waitFor(() => mock.events.filter((e) => e.op === 2).length >= 2);
    // the reconnect delay is the 50ms cap, so the retry cannot land sooner
    expect(performance.now() - closedAt).toBeGreaterThanOrEqual(BACKOFF_CAP_MS - 10);
  });

  test("(e) heartbeats flow between HELLO and READY at the HELLO interval", async () => {
    const { mock } = startSession();
    await waitFor(() => mock.events.some((e) => e.op === 2));

    // HELLO precedes every recorded frame and READY is sent on IDENTIFY,
    // so a beat before the IDENTIFY is strictly between HELLO and READY.
    const firstBeat = mock.events.findIndex((e) => e.op === 1);
    const identifyAt = mock.events.findIndex((e) => e.op === 2);
    expect(firstBeat).toBeGreaterThanOrEqual(0);
    expect(firstBeat).toBeLessThan(identifyAt);

    await waitFor(() => mock.events.filter((e) => e.op === 1).length >= 3);
    const beats = mock.events.filter((e) => e.op === 1);
    for (let i = 1; i < beats.length; i += 1) {
      const gap = beats[i].at - beats[i - 1].at;
      // never materially faster than the HELLO value, and not slower either
      // (timer jitter aside — a client ignoring HELLO would beat every 41250ms)
      expect(gap).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS - 2);
      expect(gap).toBeLessThanOrEqual(HEARTBEAT_INTERVAL_MS * 2 + 20);
    }
  });
});
