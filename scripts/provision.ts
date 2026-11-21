#!/usr/bin/env bun
// Discord app/bot provisioning. Idempotent: every subcommand can be re-run.
//
//   bun run provision check            # exits 1 on drift
//   bun run provision apply [--dry-run] # PATCH interactions URL + PUT commands
//   bun run provision invite            # print the OAuth2 install URL
//
// App *creation* (client id + bot token) is NOT scriptable: one manual trip to
// the Developer Portal. Everything after that is code.

import { loadConfig } from "../src/config";
import { parseArgs } from "node:util";

const API = "https://discord.com/api/v10";
const PERMISSIONS = 1024 | 2048 | 16384 | 65536 | 64; // VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | READ_MESSAGE_HISTORY | ADD_REACTIONS

function token(): string {
  const t = process.env.DISCORD_BOT_TOKEN;
  if (!t) throw new Error("DISCORD_BOT_TOKEN is not set");
  return t;
}

async function discord(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token()}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function check(cfgPath: string): Promise<number> {
  const cfg = loadConfig(cfgPath);
  const me = await discord("GET", "/users/@me");
  if (!me.json?.id) { console.error("token invalid:", me.text); return 1; }
  const app = await discord("GET", "/applications/@me");
  if (!app.json?.id) { console.error("application fetch failed:", app.text); return 1; }
  const remote = await discord("GET", `/applications/${app.json.id}/commands`);
  const local = cfg.commands.map((c) => ({ name: c.name, description: c.description, options: c.options ?? [] }));
  const remoteNames = (remote.json ?? []).map((c: any) => c.name).sort();
  const localNames = local.map((c) => c.name).sort();
  const drift = JSON.stringify(remoteNames) !== JSON.stringify(localNames);

  console.log(`bot:        ${me.json.username} (${me.json.id})`);
  console.log(`app:        ${app.json.name} (${app.json.id})`);
  console.log(`interactions: ${app.json.interactions_endpoint_url ?? "(unset)"}`);
  console.log(`commands remote: ${remoteNames.join(", ") || "(none)"}`);
  console.log(`commands local:  ${localNames.join(", ") || "(none)"}`);
  if (drift) { console.error("DRIFT: command set differs from config"); return 1; }
  console.log("OK: no drift");
  return 0;
}

async function apply(cfgPath: string, dryRun: boolean): Promise<number> {
  const cfg = loadConfig(cfgPath);
  const app = await discord("GET", "/applications/@me");
  if (!app.json?.id) { console.error("application fetch failed:", app.text); return 1; }
  const appId = app.json.id as string;

  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl && cfg.interactions.enabled) {
    const url = `${publicUrl.replace(/\/$/, "")}${cfg.interactions.path}`;
    if (dryRun) console.log(`[dry-run] PATCH /applications/@me interactions_endpoint_url=${url}`);
    else {
      const r = await discord("PATCH", "/applications/@me", { interactions_endpoint_url: url });
      if (r.status >= 400) { console.error("patch failed:", r.text); return 1; }
      console.log(`interactions_endpoint_url = ${url}`);
    }
  }

  const body = cfg.commands.map((c) => ({ name: c.name, description: c.description, options: c.options ?? [], type: 1 }));
  if (dryRun) console.log(`[dry-run] PUT /applications/${appId}/commands (${body.length} commands)`);
  else {
    const r = await discord("PUT", `/applications/${appId}/commands`, body);
    if (r.status >= 400) { console.error("command sync failed:", r.text); return 1; }
    console.log(`synced ${body.length} commands`);
  }
  return 0;
}

function invite(): number {
  const clientId = process.env.DISCORD_APPLICATION_ID;
  if (!clientId) { console.error("DISCORD_APPLICATION_ID is not set"); return 1; }
  const guild = process.env.DISCORD_GUILD_ID;
  const url = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${PERMISSIONS}&scope=bot%20applications.commands${guild ? `&guild_id=${guild}` : ""}`;
  console.log(url);
  return 0;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { "dry-run": { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const cfgPath = process.env.GATEWAY_CONFIG ?? "./config/gateway.yaml";
  const cmd = positionals[0];
  let code = 0;
  if (cmd === "check") code = await check(cfgPath);
  else if (cmd === "apply") code = await apply(cfgPath, values["dry-run"] === true);
  else if (cmd === "invite") code = invite();
  else { console.error("usage: provision check|apply [--dry-run]|invite"); code = 2; }
  process.exit(code);
}

main().catch((err) => { console.error(err); process.exit(1); });
