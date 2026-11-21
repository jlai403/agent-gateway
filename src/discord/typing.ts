import { createLogger } from "../log";
import type { DiscordRest } from "./rest";

const DEFAULT_INTERVAL_MS = 8000;

const log = createLogger("discord");

export function startTypingTicker(rest: DiscordRest, channelId: string, intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  const fire = (): void => {
    rest.triggerTyping(channelId).catch((err: unknown) => log.warn(`typing failed for channel ${channelId}`, err));
  };

  fire();
  const timer = setInterval(fire, intervalMs);
  return () => clearInterval(timer);
}
