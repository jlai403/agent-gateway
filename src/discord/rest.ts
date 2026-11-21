const DEFAULT_API_BASE = "https://discord.com/api/v10";

export type DiscordRestOptions = {
  token: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
};

export class DiscordRest {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimitResetAfter = new Map<string, number>();

  constructor(opts: DiscordRestOptions) {
    this.token = opts.token;
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendMessage(channelId: string, content: string, opts?: { components?: unknown }): Promise<{ id: string }> {
    const body: Record<string, unknown> = { content };
    if (opts?.components) body.components = opts.components;
    const res = await this.request("POST", `/channels/${channelId}/messages`, body);
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: json.id ?? "" };
  }

  async editMessage(channelId: string, messageId: string, body: { content?: string; components?: unknown }): Promise<void> {
    await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, body);
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  async triggerTyping(channelId: string): Promise<void> {
    await this.request("POST", `/channels/${channelId}/typing`);
  }

  async getMe(): Promise<{ id: string; username: string }> {
    const res = await this.request("GET", "/users/@me");
    return (await res.json()) as { id: string; username: string };
  }

  // Central rate-limit handling: respect 429 + retry_after, and sleep on a 0
  // remaining bucket using X-RateLimit-Reset-After before firing.
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const resetAfter = this.rateLimitResetAfter.get(pathKey(method, path));
      if (resetAfter && resetAfter > Date.now()) {
        await Bun.sleep(resetAfter - Date.now());
      }
      const res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const bucketKey = pathKey(method, path);
      const remaining = res.headers.get("x-ratelimit-remaining");
      const resetAfterHeader = res.headers.get("x-ratelimit-reset-after");
      if (remaining === "0" && resetAfterHeader) {
        this.rateLimitResetAfter.set(bucketKey, Date.now() + Math.ceil(Number(resetAfterHeader) * 1000));
      } else {
        this.rateLimitResetAfter.delete(bucketKey);
      }
      if (res.status === 429) {
        let retryAfterMs = 1000;
        try {
          const json = (await res.clone().json()) as { retry_after?: number };
          if (typeof json.retry_after === "number") retryAfterMs = Math.ceil(json.retry_after * 1000);
        } catch { /* fall back to header */ }
        const headerRetry = res.headers.get("retry-after");
        if (headerRetry) retryAfterMs = Math.max(retryAfterMs, Math.ceil(Number(headerRetry) * 1000));
        await Bun.sleep(retryAfterMs);
        continue;
      }
      if (!res.ok && res.status !== 204) {
        throw new Error(`discord ${method} ${path} failed: ${res.status}`);
      }
      return res;
    }
    throw new Error(`discord ${method} ${path} failed: rate limited`);
  }
}

function pathKey(method: string, path: string): string {
  // Collapse ids so all messages in a channel share one bucket key shape.
  return `${method} ${path.replace(/\/\d+/g, "/:id")}`;
}
