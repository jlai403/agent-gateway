import { Hono } from "hono";

import type { DiscordRest } from "./discord/rest";
import { classifyMessage, type InboundMessage, type MessageFilter, DEFAULT_MESSAGE_FILTER } from "./discord/messages";
import { startTypingTicker } from "./discord/typing";
import { TypingScopes } from "./discord/typing-scopes";
import { handleInteraction, type InteractionDeps } from "./interactions";
import type { Logger } from "./log";
import type { Transcriber } from "./stt";
import type { WorkerClient } from "./worker-client";

const CHAT_ID_PREFIX = "discord:";

export type AppDeps = {
  rest: DiscordRest;
  token: string;
  /** Image tag, baked at build time. Reported by /health so a deploy can assert it. */
  version?: string;
  /** Reported by /health: the worker's deploy gate no longer owns STT config. */
  sttConfigured?: boolean;
  /** Refcounted typing tickers; created in index.ts and shared with the routes. */
  typingScopes?: TypingScopes;
  /** When set, POST /interactions is mounted and routed through this handler. */
  interactions?: InteractionDeps;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, version: deps.version ?? "dev", sha: process.env.GIT_SHA ?? null, stt: deps.sttConfigured === true }),
  );

  app.post("/send", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== deps.token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => null);
    if (!isSendBody(body)) {
      return c.json({ error: "POST /send requires { chatId, body }" }, 400);
    }
    try {
      const msg = await deps.rest.sendMessage(channelIdOf(body.chatId), body.body);
      return c.json({ sent: true, messageId: (msg as any)?.id ?? null });
    } catch (err) {
      return c.json({ error: errorText(err) }, 502);
    }
  });

  app.patch("/messages/:channelId/:messageId", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== deps.token) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return c.json({ error: "bad body" }, 400);
    try {
      await deps.rest.editMessage(c.req.param("channelId"), c.req.param("messageId"), body as { content?: string; components?: unknown });
      return c.json({ edited: true });
    } catch (err) {
      return c.json({ error: errorText(err) }, 502);
    }
  });

  app.post("/react", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== deps.token) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return c.json({ error: "bad body" }, 400);
    const { channelId, messageId, emoji } = body as Record<string, unknown>;
    if (typeof channelId !== "string" || typeof messageId !== "string" || typeof emoji !== "string") {
      return c.json({ error: "requires { channelId, messageId, emoji }" }, 400);
    }
    try {
      await deps.rest.addReaction(channelId, messageId, emoji);
      return c.json({ reacted: true });
    } catch (err) {
      return c.json({ error: errorText(err) }, 502);
    }
  });

  app.post("/typing", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== deps.token) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return c.json({ error: "bad body" }, 400);
    const { channelId } = body as Record<string, unknown>;
    if (typeof channelId !== "string") return c.json({ error: "requires { channelId }" }, 400);
    try {
      await deps.rest.triggerTyping(channelId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorText(err) }, 502);
    }
  });

  app.post("/work", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== deps.token) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return c.json({ error: "bad body" }, 400);
    const { channelId, requestId } = body as Record<string, unknown>;
    if (typeof channelId !== "string" || typeof requestId !== "string") {
      return c.json({ error: "requires { channelId, requestId }" }, 400);
    }
    deps.typingScopes?.start(channelId, requestId);
    return c.json({ ok: true });
  });

  app.post("/done", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== deps.token) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return c.json({ error: "bad body" }, 400);
    const { requestId, channelId } = body as Record<string, unknown>;
    if (typeof requestId !== "string") return c.json({ error: "requires { requestId }" }, 400);
    if (deps.typingScopes) deps.typingScopes.stop(typeof channelId === "string" ? channelId : "", requestId);
    return c.json({ ok: true });
  });

  if (deps.interactions) {
    app.post(deps.interactions.path ?? "/interactions", async (c) => {
      const res = await handleInteraction(deps.interactions!, c.req.raw);
      return res;
    });
  }

  return app;
}

export type HandleMessageDeps = {
  rest: DiscordRest;
  worker: WorkerClient;
  log: Logger;
  /** The mention filter needs the bot's own user id (GET /users/@me at startup). */
  botUserId: string;
  /** Null when STT is not configured: a voice note then gets the failure copy. */
  transcribe: Transcriber | null;
  /** Message filter from config. Defaults to the nanny shape when absent. */
  filter?: MessageFilter;
  /** Test seam; the default starts the real typing ticker. */
  startTicker?: typeof startTypingTicker;
};

/** The one user-facing failure for unreadable audio, kept in one place. */
export const TRANSCRIBE_FAILED = "I couldn't transcribe that voice note — could you type it instead? 🎙️";

// Only an explicit MESSAGE_CREATE is a new message: MESSAGE_UPDATE carries the same
// author/mentions/content on the wire and would otherwise pass the shape filter twice.
export async function handleMessage(deps: HandleMessageDeps, d: unknown, t?: string): Promise<void> {
  if (t !== "MESSAGE_CREATE") {
    deps.log.debug(`ignoring a ${t ?? "untyped"} dispatch; only MESSAGE_CREATE starts a turn`);
    return;
  }
  const classified = classifyMessage(d, deps.botUserId, deps.filter ?? DEFAULT_MESSAGE_FILTER);
  if (!classified.ok) {
    // An audio attachment with no mention is the voice-note case: it is the one
    // legitimate reason for warn, and the one we used to lose in silence.
    const line = `dropped: ${classified.reason}${
      classified.attachments.length > 0 ? `, attachments: [${classified.attachments.join(", ")}]` : ""
    }`;
    if (classified.attachments.some((type) => type.startsWith("audio/"))) deps.log.warn(line);
    else deps.log.debug(line);
    return;
  }
  const msg = classified.msg;

  const channelId = channelIdOf(msg.chatId);
  const stopTyping = (deps.startTicker ?? startTypingTicker)(deps.rest, channelId);
  try {
    // A voice note becomes text here and never crosses the seam as media: the
    // worker takes a sentence, and stops being the component that fetches a
    // caller-supplied url.
    const turnInput = await toTurnInput(deps, msg);
    if (!turnInput) return;

    const turn = await deps.worker.runTurn(turnInput);
    if (typeof turn.text === "string" && turn.text.trim()) {
      await deps.rest.sendMessage(channelId, turn.text);
    } else if (turn.error !== undefined && !turn.retryable) {
      await deps.rest.sendMessage(channelId, `Something went wrong: ${turn.error}`);
    } else if (turn.retryable) {
      deps.log.warn(`worker not ready for ${msg.chatId}: ${turn.error}`);
    } else {
      deps.log.warn(`worker turn for ${msg.chatId} returned neither text nor error`);
    }
  } finally {
    stopTyping();
  }
}

/** Transcribes when there is audio; null when the parent has already been told. */
async function toTurnInput(deps: HandleMessageDeps, msg: InboundMessage): Promise<InboundMessage | null> {
  if (!msg.attachment) return msg;
  const transcript = deps.transcribe ? await deps.transcribe(msg.attachment) : null;
  if (!transcript) {
    await deps.rest.sendMessage(channelIdOf(msg.chatId), TRANSCRIBE_FAILED);
    return null;
  }
  deps.log.info(`transcribed a voice note (${transcript.length} chars)`);
  return { chatId: msg.chatId, speaker: msg.speaker, text: `[voice note] ${transcript}` };
}

type SendBody = { chatId: string; body: string };

function isSendBody(value: unknown): value is SendBody {
  if (typeof value !== "object" || value === null) return false;
  const { chatId, body } = value as Record<string, unknown>;
  return typeof chatId === "string" && typeof body === "string";
}

// The seam speaks opaque "discord:<channelId>" chat ids; Discord REST needs the raw channel id.
function channelIdOf(chatId: string): string {
  return chatId.startsWith(CHAT_ID_PREFIX) ? chatId.slice(CHAT_ID_PREFIX.length) : chatId;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
