import type { DiscordRest } from "./rest";
import { startTypingTicker } from "./typing";

/** Refcounted typing tickers per channel. Several concurrent `work` scopes on one
 *  channel keep a single ticker alive; it stops when the last scope ends. */
export class TypingScopes {
  private readonly rest: DiscordRest;
  private readonly intervalMs: number;
  private readonly active = new Map<string, { count: number; stop: () => void }>();
  private readonly requestToChannel = new Map<string, string>();

  constructor(rest: DiscordRest, intervalMs: number = 8000) {
    this.rest = rest;
    this.intervalMs = intervalMs;
  }

  start(channelId: string, requestId: string): void {
    this.requestToChannel.set(requestId, channelId);
    const entry = this.active.get(channelId);
    if (entry) {
      entry.count += 1;
      return;
    }
    const stop = startTypingTicker(this.rest, channelId, this.intervalMs);
    this.active.set(channelId, { count: 1, stop });
  }

  stop(_channelId: string, requestId: string): void {
    const channelId = this.requestToChannel.get(requestId) ?? _channelId;
    this.requestToChannel.delete(requestId);
    const entry = this.active.get(channelId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) {
      entry.stop();
      this.active.delete(channelId);
    }
  }

  stopAll(): void {
    for (const entry of this.active.values()) entry.stop();
    this.active.clear();
    this.requestToChannel.clear();
  }

  activeCount(): number {
    return this.active.size;
  }
}