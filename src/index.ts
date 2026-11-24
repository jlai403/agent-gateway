import { createApp, handleMessage } from "./app";
import { loadConfig, intentsFrom, secret } from "./config";
import { TypingScopes } from "./discord/typing-scopes";
import { syncCommands } from "./commands";
import { DiscordGateway, type ReadyUser } from "./discord/gateway";
import { DiscordRest } from "./discord/rest";
import { createLogger, setLogSink } from "./log";
import { createLogShipper } from "./logShip";
import { createTranscriber } from "./stt";
import { WorkerClient } from "./worker-client";
import type { MessageFilter } from "./discord/messages";

const DEFAULT_PORT = 8090;
const BACKOFF_CAP_MS = 30_000;
const DEFAULT_GATEWAY_WS_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const log = createLogger("gateway");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

function isBotUser(value: unknown): value is ReadyUser {
  if (typeof value !== "object" || value === null) return false;
  const { id, username } = value as Record<string, unknown>;
  return typeof id === "string" && typeof username === "string";
}

async function waitForBotUser(rest: DiscordRest): Promise<ReadyUser> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const me = await rest.getMe();
      if (isBotUser(me)) return me;
      log.warn("GET /users/@me returned a malformed user payload; retrying");
    } catch (err) {
      log.warn("GET /users/@me failed; retrying", err);
    }
    await Bun.sleep(Math.min(1000 * 2 ** attempt, BACKOFF_CAP_MS));
  }
}

const configPath = process.env.GATEWAY_CONFIG ?? "./config/gateway.yaml";
let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const port = Number(process.env.PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log.error(`PORT must be an integer between 1 and 65535, got "${process.env.PORT}"`);
  process.exit(1);
}

const gatewayToken = process.env.GATEWAY_TOKEN;
if (!gatewayToken) {
  log.error("GATEWAY_TOKEN is not set");
  process.exit(1);
}

const botToken = secret(config, config.discord.tokenEnv);
const intents = intentsFrom(config);

if (config.logging.shipUrl) {
  const shipper = createLogShipper({
    url: config.logging.shipUrl,
    token: gatewayToken,
    onError: (message) => console.error(JSON.stringify({ t: new Date().toISOString(), level: "warn", scope: "logShip", msg: message })),
  });
  setLogSink((line) => shipper.push(line));
}

const rest = new DiscordRest({ token: botToken, apiBase: process.env.DISCORD_API_BASE || undefined });
const consumerUrl = config.inbound.url;
const consumerToken = secret(config, config.inbound.authEnv);
const worker = new WorkerClient({ url: consumerUrl, token: consumerToken, timeoutMs: config.inbound.timeoutMs });

const transcribe = config.message.audio.mode === "transcribe" && config.message.audio.endpointEnv
  ? createTranscriber(
      { endpoint: secret(config, config.message.audio.endpointEnv), apiKey: process.env.STT_API_KEY },
      { log: createLogger("stt") },
    )
  : null;

const filter: MessageFilter = {
  ignoreBots: config.message.ignoreBots,
  requireMention: config.message.requireMention,
  audioExempt: config.message.audio.mode !== "off",
};

const typingScopes = new TypingScopes(rest, config.typing.intervalMs);

const interactions = config.interactions.enabled && config.discord.publicKeyEnv && config.discord.applicationIdEnv
  ? {
      publicKey: secret(config, config.discord.publicKeyEnv),
      applicationId: secret(config, config.discord.applicationIdEnv),
      consumerUrl,
      consumerToken,
      prefix: config.interactions.prefix,
      path: config.interactions.path,
      interactionsUrl: config.interactions.url,
      defer: config.interactions.defer,
      deferWindowMs: config.interactions.deferWindowMs,
      timeoutMs: config.inbound.timeoutMs,
    }
  : undefined;

const app = createApp({
  rest,
  token: gatewayToken,
  version: process.env.GATEWAY_VERSION || "dev",
  sttConfigured: transcribe !== null,
  typingScopes,
  interactions,
});

Bun.serve({ port, fetch: app.fetch });

const botUser = await waitForBotUser(rest);
log.info(`gateway up: intents=${intents} consumer=${consumerUrl} bot=${botUser.id} stt=${transcribe ? "on" : "off"} config=${configPath}`);

if (config.interactions.enabled && config.discord.applicationIdEnv) {
  try {
    await syncCommands(
      { applicationId: secret(config, config.discord.applicationIdEnv), token: botToken },
      config.commands,
    );
    log.info(`commands synced: ${config.commands.length}`);
  } catch (err) {
    log.warn("command sync failed", err);
  }
}

const gatewayWsUrl = process.env.DISCORD_GATEWAY_URL || DEFAULT_GATEWAY_WS_URL;

const gateway = new DiscordGateway(
  { token: botToken, intents, url: gatewayWsUrl, presence: config.presence },
  {
    onMessage: (d, t) => {
      if (!t) return;
      if (!config.events.forward.includes(t)) return;
      if (config.inbound.payload === "chat") {
        if (t !== "MESSAGE_CREATE") return;
        handleMessage({ rest, worker, log, botUserId: botUser.id, transcribe, filter, startTicker: undefined }, d, t);
        return;
      }
      // event mode: forward the raw dispatch to the consumer; no turn loop, no reply.
      const channelId = (d as { channel_id?: string } | null)?.channel_id;
      const guildId = (d as { guild_id?: string } | null)?.guild_id;
      const body = { type: t, channelId, guildId, event: d };
      const consumerToken = secret(config, config.inbound.authEnv);
      const url = config.inbound.url;
      const fetchImpl = fetch;
      const retry = config.inbound.retry;
      void (async () => {
        for (let i = 0; i < retry.attempts; i += 1) {
          try {
            const res = await fetchImpl(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${consumerToken}` },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(config.inbound.timeoutMs),
            });
            if (res.ok) return;
            if (res.status === 404 || res.status === 502) {
              log.warn(`consumer not ready (${res.status}) for ${t}`);
              return;
            }
            log.warn(`consumer returned ${res.status} for ${t}`);
            return;
          } catch (err) {
            log.warn(`forward ${t} failed (attempt ${i + 1}/${retry.attempts})`, err);
            if (i < retry.attempts - 1) await Bun.sleep(retry.backoffMs);
          }
        }
      })();
    },
  },
);
gateway.start();
void config;
