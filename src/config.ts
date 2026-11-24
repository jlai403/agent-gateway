// Agent-agnostic gateway configuration. Loaded from a YAML file (path from
// GATEWAY_CONFIG, default ./config/gateway.yaml). Nothing here knows about deals
// or babies: every agent-specific fact arrives through the file.
//
// Secrets are referenced by env-var *name* ("tokenEnv": "DISCORD_TOKEN"), never
// stored, so the config is safe to commit and review.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const INTENT_BITS: Readonly<Record<string, number>> = Object.freeze({
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EMOJIS_AND_STICKERS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
});

const IntentName = z.enum(Object.keys(INTENT_BITS) as [string, ...string[]]);

const AudioSchema = z
  .object({
    mode: z.enum(["off", "transcribe"]).default("off"),
    endpointEnv: z.string().optional(),
    prefix: z.string().default("[voice note] "),
  })
  .strict();

const MessageSchema = z
  .object({
    requireMention: z.boolean().default(false),
    ignoreBots: z.boolean().default(true),
    audio: AudioSchema.default({ mode: "off", prefix: "[voice note] " } as any),
  })
  .strict()
  .default({ requireMention: false, ignoreBots: true, audio: { mode: "off", prefix: "[voice note] " } } as any);

const InboundSchema = z
  .object({
    url: z.string().url(),
    authEnv: z.string(),
    payload: z.enum(["event", "chat"]).default("event"),
    timeoutMs: z.number().int().positive().default(90000),
    retry: z.object({ attempts: z.number().int().min(1).default(3), backoffMs: z.number().int().min(0).default(500) }).strict().default({ attempts: 3, backoffMs: 500 }),
  })
  .strict();

const InteractionsSchema = z
  .object({
    enabled: z.boolean().default(false),
    path: z.string().default("/interactions"),
    url: z.string().url().optional(),
    prefix: z.string().min(1),
    defer: z.boolean().default(true),
    deferWindowMs: z.number().int().min(0).default(1500),
  })
  .strict();

const OptionSchema = z
  .object({
    type: z.number().int(),
    name: z.string().min(1),
    description: z.string().min(1),
    required: z.boolean().optional(),
  })
  .strict();

const CommandSchema = z
  .object({
    name: z.string().min(1).regex(/^[a-z0-9_-]{1,32}$/),
    description: z.string().min(1).max(100),
    options: z.array(OptionSchema).optional(),
  })
  .strict();

const LoggingSchema = z
  .object({
    format: z.enum(["json", "text"]).default("json"),
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    shipUrl: z.string().url().nullable().default(null),
  })
  .strict();

const ConfigSchema = z
  .object({
    discord: z
      .object({
        tokenEnv: z.string().min(1),
        applicationIdEnv: z.string().min(1).optional(),
        publicKeyEnv: z.string().min(1).optional(),
        intents: z.array(IntentName).min(1),
      })
      .strict(),
    events: z
      .object({
        forward: z.array(z.string()).default([]),
        channels: z.array(z.string()).default([]),
      })
      .strict()
      .default({ forward: [], channels: [] }),
    message: MessageSchema.default({ requireMention: false, ignoreBots: true, audio: { mode: "off", prefix: "[voice note] " } } as any),
    inbound: InboundSchema,
    interactions: InteractionsSchema,
    presence: z
      .object({
        status: z.enum(["online", "idle", "dnd", "invisible"]).default("online"),
        activities: z.array(z.object({ name: z.string().min(1), type: z.number().int().min(0).max(5) })).default([]),
      })
      .strict()
      .optional(),
    commands: z.array(CommandSchema).default([]),
    typing: z.object({ enabled: z.boolean().default(true), intervalMs: z.number().int().positive().default(8000) }).strict().default({ enabled: true, intervalMs: 8000 }),
    logging: LoggingSchema.default({ format: "json", level: "info", shipUrl: null }),
  })
  .strict();

export type GatewayConfig = z.infer<typeof ConfigSchema>;

function resolveEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`config references env "${name}" but it is not set`);
  return v;
}

export function loadConfig(path: string): GatewayConfig {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read config ${path}: ${msg}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
    throw new Error(`invalid config ${path}:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.interactions.enabled) {
    if (!cfg.discord.applicationIdEnv) throw new Error(`invalid config ${path}: interactions.enabled requires discord.applicationIdEnv`);
    if (!cfg.discord.publicKeyEnv) throw new Error(`invalid config ${path}: interactions.enabled requires discord.publicKeyEnv`);
  }
  // resolve env names up front so a missing secret fails at boot, not mid-request
  resolveEnv(cfg.discord.tokenEnv);
  if (cfg.interactions.enabled) {
    if (cfg.discord.applicationIdEnv) resolveEnv(cfg.discord.applicationIdEnv);
    if (cfg.discord.publicKeyEnv) resolveEnv(cfg.discord.publicKeyEnv);
  }
  resolveEnv(cfg.inbound.authEnv);
  if (cfg.message.audio.mode === "transcribe" && cfg.message.audio.endpointEnv) resolveEnv(cfg.message.audio.endpointEnv);
  return cfg;
}

export function intentsFrom(cfg: GatewayConfig): number {
  return cfg.discord.intents.reduce((acc, name) => acc | INTENT_BITS[name], 0);
}

export function secret(cfg: GatewayConfig, envName: string): string {
  return resolveEnv(envName);
}

export function redacted(cfg: GatewayConfig): unknown {
  return {
    ...cfg,
    discord: { ...cfg.discord, tokenEnv: `<${cfg.discord.tokenEnv}>`, applicationIdEnv: `<${cfg.discord.applicationIdEnv}>`, publicKeyEnv: cfg.discord.publicKeyEnv ? `<${cfg.discord.publicKeyEnv}>` : undefined },
    inbound: { ...cfg.inbound, authEnv: `<${cfg.inbound.authEnv}>` },
    message: { ...cfg.message, audio: { ...cfg.message.audio, endpointEnv: cfg.message.audio.endpointEnv ? `<${cfg.message.audio.endpointEnv}>` : undefined } },
  };
}
