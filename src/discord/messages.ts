export type InboundMessage = {
  chatId: string;
  speaker: string;
  text: string;
  attachment?: { url: string; contentType: string };
};

type DiscordUser = { id?: string; username?: string; global_name?: string | null; bot?: boolean };

type DiscordAttachment = { url: string; content_type?: string };

type MessageCreate = {
  channel_id: string;
  content: string;
  author: DiscordUser;
  member?: { nick?: string | null };
  mentions?: DiscordUser[];
  attachments?: DiscordAttachment[];
  /** Bitfield; 8192 (`IS_VOICE_MESSAGE`) marks a recorded voice note. */
  flags?: number;
};

/** A recorded voice note. Its `content` is empty and it cannot carry a mention,
 *  which is why the mention filter used to swallow every one of them. */
const IS_VOICE_MESSAGE = 1 << 13;

/** Why a dispatch produced no turn. Logged verbatim: a silent drop is what hid
 *  the voice-note bug for a week. */
export type DropReason = "malformed" | "bot-author" | "no-mention";

export type Classified =
  | { ok: true; msg: InboundMessage }
  | { ok: false; reason: DropReason; attachments: string[] };

export type MessageFilter = {
  /** Drop messages from bot authors. */
  ignoreBots: boolean;
  /** Require a @mention unless the message is a voice note. When false, every
   *  non-bot message is addressed (deal-finder's mode: no plain-text commands). */
  requireMention: boolean;
  /** Treat an audio attachment / voice flag as always-addressed. */
  audioExempt: boolean;
};

export const DEFAULT_MESSAGE_FILTER: MessageFilter = {
  ignoreBots: true,
  requireMention: true,
  audioExempt: true,
};

/** The filter and the shaping, with the reason kept so the caller can log it. */
export function classifyMessage(d: unknown, botUserId: string, filter: MessageFilter = DEFAULT_MESSAGE_FILTER): Classified {
  if (!isMessageCreate(d)) return { ok: false, reason: "malformed", attachments: [] };
  const attachments = (d.attachments ?? []).map((a) => a.content_type ?? "unknown");
  if (filter.ignoreBots && d.author.bot) return { ok: false, reason: "bot-author", attachments };

  const attachment = firstAudioAttachment(d.attachments ?? []);
  const voiced = filter.audioExempt && (attachment !== undefined || ((d.flags ?? 0) & IS_VOICE_MESSAGE) !== 0);
  if (filter.requireMention && !mentionsBot(d, botUserId) && !voiced) {
    return { ok: false, reason: "no-mention", attachments };
  }

  return {
    ok: true,
    msg: {
      chatId: `discord:${d.channel_id}`,
      speaker: speakerName(d),
      text: d.content,
      ...(attachment ? { attachment } : {}),
    },
  };
}

export function toInboundMessage(d: unknown, botUserId: string, filter: MessageFilter = DEFAULT_MESSAGE_FILTER): InboundMessage | null {
  const classified = classifyMessage(d, botUserId, filter);
  return classified.ok ? classified.msg : null;
}

function isMessageCreate(d: unknown): d is MessageCreate {
  if (typeof d !== "object" || d === null) return false;
  const candidate = d as Partial<MessageCreate>;
  return typeof candidate.channel_id === "string" && typeof candidate.author === "object" && candidate.author !== null;
}

function mentionsBot(d: MessageCreate, botUserId: string): boolean {
  return Array.isArray(d.mentions) && d.mentions.some((user) => user.id === botUserId);
}

function speakerName(d: MessageCreate): string {
  return d.member?.nick ?? d.author.global_name ?? d.author.username ?? "";
}

function firstAudioAttachment(attachments: DiscordAttachment[]): { url: string; contentType: string } | undefined {
  const audio = attachments.find((a) => a.content_type?.startsWith("audio/"));
  if (!audio || !audio.content_type) return undefined;
  return { url: audio.url, contentType: audio.content_type };
}
