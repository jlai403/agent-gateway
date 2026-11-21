import { describe, expect, test } from "bun:test";
import { classifyMessage, toInboundMessage } from "../src/discord/messages";

const BOT_ID = "999";

function mentionMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel_id: "123",
    content: "when was the last feed?",
    author: { id: "1", username: "dadsmith", global_name: "Dad Smith", bot: false },
    member: { nick: "Dad" },
    mentions: [{ id: BOT_ID }],
    attachments: [],
    ...overrides,
  };
}

describe("toInboundMessage", () => {
  describe("filter", () => {
    test("bot author is dropped", () => {
      const d = mentionMessage({ author: { id: "2", username: "nanny", bot: true } });
      expect(toInboundMessage(d, BOT_ID)).toBeNull();
    });

    test("message without a bot mention is dropped", () => {
      const d = mentionMessage({ mentions: [{ id: "555" }] });
      expect(toInboundMessage(d, BOT_ID)).toBeNull();
    });
  });

  describe("shaping", () => {
    test("mention becomes a chat-scoped inbound with the member nick as speaker", () => {
      expect(toInboundMessage(mentionMessage(), BOT_ID)).toEqual({
        chatId: "discord:123",
        speaker: "Dad",
        text: "when was the last feed?",
      });
    });

    test("speaker falls back to global_name when member nick is null", () => {
      const d = mentionMessage({ member: { nick: null } });
      expect(toInboundMessage(d, BOT_ID)?.speaker).toBe("Dad Smith");
    });

    test("speaker falls back to username when nick and global_name are absent", () => {
      const d = mentionMessage({
        member: undefined,
        author: { id: "1", username: "dadsmith", bot: false },
      });
      expect(toInboundMessage(d, BOT_ID)?.speaker).toBe("dadsmith");
    });

    test("image-only attachment is ignored and text is still forwarded", () => {
      const d = mentionMessage({
        attachments: [{ url: "https://cdn/photo.png", content_type: "image/png" }],
      });
      const inbound = toInboundMessage(d, BOT_ID);
      expect(inbound?.attachment).toBeUndefined();
      expect(inbound?.text).toBe("when was the last feed?");
    });

    test("voice note yields the audio attachment with its content type", () => {
      const d = mentionMessage({
        content: "",
        attachments: [{ url: "https://cdn/voice.ogg", content_type: "audio/ogg" }],
      });
      expect(toInboundMessage(d, BOT_ID)?.attachment).toEqual({
        url: "https://cdn/voice.ogg",
        contentType: "audio/ogg",
      });
    });

    test("only the first audio attachment is used", () => {
      const d = mentionMessage({
        content: "",
        attachments: [
          { url: "https://cdn/voice.ogg", content_type: "audio/ogg" },
          { url: "https://cdn/clip.mp4", content_type: "video/mp4" },
        ],
      });
      expect(toInboundMessage(d, BOT_ID)?.attachment).toEqual({
        url: "https://cdn/voice.ogg",
        contentType: "audio/ogg",
      });
    });
  });
});


describe("classifyMessage", () => {
  test("a voice note with no mention is forwarded, because it cannot mention", () => {
    // The shape a Discord voice message actually arrives in: no content, no
    // mentions, one audio attachment, flags 8192. Requiring a mention here is
    // what made every voice note vanish.
    const d = mentionMessage({
      content: "",
      mentions: [],
      flags: 8192,
      attachments: [{ url: "https://cdn/voice.ogg", content_type: "audio/ogg" }],
    });
    const classified = classifyMessage(d, BOT_ID);
    if (!classified.ok) throw new Error(`dropped as ${classified.reason}`);
    expect(classified.msg.attachment).toEqual({ url: "https://cdn/voice.ogg", contentType: "audio/ogg" });
  });

  test("text with no mention is still dropped", () => {
    const d = mentionMessage({ content: "just chatting", mentions: [], fingerprints: undefined });
    expect(classifyMessage(d, BOT_ID)).toEqual({ ok: false, reason: "no-mention", attachments: [] });
  });

  test("a bot-authored message reports why it was dropped", () => {
    const d = mentionMessage({ author: { id: "2", username: "nanny", bot: true } });
    expect(classifyMessage(d, BOT_ID)).toMatchObject({ ok: false, reason: "bot-author" });
  });

  test("a malformed payload names the reason instead of returning null", () => {
    expect(classifyMessage({ hello: "world" }, BOT_ID)).toEqual({
      ok: false,
      reason: "malformed",
      attachments: [],
    });
  });

  test("an accepted message is the same object toInboundMessage returns", () => {
    const classified = classifyMessage(mentionMessage(), BOT_ID);
    if (!classified.ok) throw new Error(`expected a turn, got ${classified.reason}`);
    const viaWrapper = toInboundMessage(mentionMessage(), BOT_ID);
    expect(classified.msg).toEqual(viaWrapper as NonNullable<typeof viaWrapper>);
  });
});
