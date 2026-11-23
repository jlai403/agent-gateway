// Discord interactions: Ed25519-verified POST /interactions, routed by custom_id
// prefix, with defer + follow-up so the 3-second ACK window is never missed.
//
// Consumers never talk to Discord directly. They return a body and the gateway
// does the wire work (defer, PATCH @original, ephemeral flags).

import { createPublicKey, verify as verifySig } from "node:crypto";
import { createLogger } from "./log";

const log = createLogger("interactions");

export type InteractionDeps = {
  publicKey: string;            // hex, from DISCORD_PUBLIC_KEY
  applicationId: string;
  consumerUrl: string;          // base URL of the consumer
  consumerToken: string;
  prefix: string;               // custom_id must start with "<prefix>:"
  path?: string;                // interactions route path, default /interactions
  defer: boolean;
  deferWindowMs: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

const DISCORD_API = "https://discord.com/api/v10";
const MAX_AGE_SECONDS = 300;

function verifySignature(publicKeyHex: string, timestamp: string, body: Uint8Array, signatureHex: string): boolean {
  try {
    const tsBytes = new TextEncoder().encode(timestamp);
    const data = new Uint8Array(tsBytes.length + body.length);
    data.set(tsBytes, 0);
    data.set(body, tsBytes.length);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return verifySig(null, Buffer.from(data), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

function interactionUrl(appId: string, token: string): string {
  return `${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`;
}

async function forwardToConsumer(deps: InteractionDeps, interaction: unknown): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${deps.consumerUrl.replace(/\/$/, "")}/discord/interactions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.consumerToken}` },
      body: JSON.stringify({ type: "INTERACTION", interaction }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn(`consumer returned ${res.status}`, text.slice(0, 300));
      return null;
    }
    return await res.json().catch(() => null);
  } catch (e) {
    log.warn("consumer forward failed", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function followUp(deps: InteractionDeps, appId: string, token: string, body: unknown): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(interactionUrl(appId, token), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn(`follow-up failed: ${res.status}`, text.slice(0, 300));
    }
  } catch (e) {
    log.warn("follow-up error", e);
  }
}

export async function handleInteraction(deps: InteractionDeps, request: Request): Promise<Response> {
  const sig = request.headers.get("x-signature-ed25519");
  const ts = request.headers.get("x-signature-timestamp");
  const raw = await request.arrayBuffer();
  const body = new Uint8Array(raw);

  if (!sig || !ts) return new Response("missing signature", { status: 401 });
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > MAX_AGE_SECONDS) {
    return new Response("stale request", { status: 401 });
  }
  if (!verifySignature(deps.publicKey, ts, body, sig)) {
    return new Response("bad signature", { status: 401 });
  }

  let interaction: any;
  try {
    interaction = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // PING
  if (interaction?.type === 1) {
    log.debug("PING");
    return Response.json({ type: 1 });
  }

  const customId = interaction?.data?.custom_id;
  const name = interaction?.data?.name;
  log.info(`interaction type=${interaction?.type} name=${name ?? "-"} custom_id=${customId ?? "-"}`);

  if (typeof customId === "string" && !customId.startsWith(`${deps.prefix}:`)) {
    return Response.json({ type: 4, data: { content: "Unknown command.", flags: 64 } });
  }

  const appId = deps.applicationId;
  const token = interaction?.token as string;

  // Try a synchronous answer within the defer window so modals and component
  // updates can be returned verbatim (they cannot be deferred).
  if (!deps.defer) {
    const result = await forwardToConsumer(deps, interaction);
    if (result && typeof result === "object" && "type" in (result as object)) {
      return Response.json(result);
    }
    return Response.json({ type: 4, data: { content: "No response.", flags: 64 } });
  }

  // Deferred path, but try to answer synchronously first so modals (type 9) and
  // autocomplete (type 8) can be returned verbatim — Discord requires those
  // inside the initial response. Anything slower, or anything that doesn't need
  // synchronous delivery, falls back to ACK + PATCH @original.
  const deferredType = interaction?.type === 3 ? 6 : 5;
  const syncDeadline = Math.max(0, Math.min(deps.deferWindowMs ?? 1500, 2500));
  const forwardPromise = forwardToConsumer(deps, interaction);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), syncDeadline);
  });
  const result = await Promise.race([forwardPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (result && typeof result === "object" && "type" in (result as object) && ((result as any).type === 8 || (result as any).type === 9)) {
    return Response.json(result);
  }

  void (async () => {
    const r = result ?? (await forwardPromise);
    if (r && typeof r === "object") {
      await followUp(deps, appId, token, r);
    }
  })();

  return Response.json({ type: deferredType });
}