// Slash-command registration. The gateway owns this so the command set always
// mirrors the live config: a removed command disappears instead of lingering as a
// dead entry that fails on use. One PUT replaces the whole set, so it is
// idempotent and safe to re-run on every boot.

import type { GatewayConfig } from "./config";

export type CommandSyncDeps = {
  applicationId: string;
  token: string;
  fetchImpl?: typeof fetch;
};

export async function syncCommands(deps: CommandSyncDeps, commands: GatewayConfig["commands"]): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = commands.map((c) => ({
    name: c.name,
    description: c.description,
    options: c.options ?? [],
    type: 1,
  }));
  const res = await fetchImpl(`https://discord.com/api/v10/applications/${deps.applicationId}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${deps.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`command sync failed: ${res.status} ${await res.text()}`);
}