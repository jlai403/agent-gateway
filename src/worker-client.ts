import type { InboundMessage } from "./discord/messages";

/** One turn against the worker: a reply, or a failure the policy layer reacts to. */
export type TurnResult = { text?: string; error?: string; retryable?: boolean };

export type WorkerClientOptions = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

// 404/502 = the worker is up but /inbound is not (rollout window): warn-only
// upstream, no error spam in the channel. Everything else is a hard failure.
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([404, 502]);
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_DETAIL_CHARS = 200;

/** The worker's error body carries why (`{"error":"…"}`). A bare status code in
 *  the channel forced operators to read container logs to learn anything. */
export function detailFromBody(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  let message = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const fromJson = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : undefined;
    // A JSON body with no error/message says nothing useful — `{}` is not detail.
    if (!fromJson) return undefined;
    message = fromJson;
  } catch {
    // Not JSON (a proxy's HTML page, say) — fall back to the raw text.
  }
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > MAX_DETAIL_CHARS ? `${oneLine.slice(0, MAX_DETAIL_CHARS)}…` : oneLine;
}

export class WorkerClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: WorkerClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async runTurn(msg: InboundMessage): Promise<TurnResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}/inbound`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: msg.chatId, speaker: msg.speaker, text: msg.text, attachment: msg.attachment }),
        signal: controller.signal,
      });
      if (res.ok) {
        const json = (await res.json()) as { text?: string };
        return { text: json.text };
      }
      const detail = detailFromBody(await res.text().catch(() => ""));
      const error = detail ? `worker HTTP ${res.status}: ${detail}` : `worker HTTP ${res.status}`;
      return RETRYABLE_STATUSES.has(res.status) ? { error, retryable: true } : { error };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { error: `worker timed out after ${this.timeoutMs}ms`, retryable: true };
      }
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
