// Speech-to-text, at the edge.
//
// Discord voice notes arrive as a signed CDN url plus a content type. Turning
// that into text is a transport concern — the worker is channel-agnostic and
// should never fetch a caller-supplied url — so the gateway does it and hands the
// worker a plain sentence.
//
// The endpoint contract is whisper-asr-webservice's, not OpenAI's: `POST /asr`
// with a multipart `audio_file` field, `output=txt` returning `text/plain`. The
// worker used to post to `/v1/audio/transcriptions`, which that image does not
// serve, so every voice note 404'd and was reported to the parent as "couldn't
// transcribe that" — indistinguishable from a broken microphone.

import type { Logger } from "./log";

export type SttOptions = {
  /** Base URL, e.g. `http://whisper:9000`. Empty disables transcription. */
  endpoint: string;
  apiKey?: string;
};

export type AudioAttachment = { url: string; contentType: string };

export type Transcriber = (attachment: AudioAttachment) => Promise<string | null>;

const DEFAULT_TIMEOUT_MS = 60_000;

/** Null when STT is not configured — the caller decides what that means. */
export function createTranscriber(
  opts: SttOptions,
  deps: { log: Logger; fetchImpl?: typeof fetch; timeoutMs?: number },
): Transcriber | null {
  const endpoint = opts.endpoint.trim().replace(/\/+$/, "");
  if (!endpoint) return null;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${endpoint}/asr?output=txt&task=transcribe`;

  return async (attachment) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const audio = await fetchImpl(attachment.url, { signal: controller.signal });
      if (!audio.ok) {
        // A signed CDN url expires; say so rather than blaming the transcriber.
        deps.log.warn(`download ${audio.status} from the CDN`);
        return null;
      }
      const bytes = await audio.arrayBuffer();
      const form = new FormData();
      form.append("audio_file", new Blob([bytes], { type: attachment.contentType }), "audio.ogg");
      const res = await fetchImpl(url, {
        method: "POST",
        headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : undefined,
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        // The URL belongs in this line: a 404 means the endpoint shape is wrong,
        // and that used to look exactly like unusable audio.
        deps.log.warn(`transcribe ${res.status} from ${url}`);
        return null;
      }
      const text = (await res.text()).replace(/\s+/g, " ").trim();
      if (!text) {
        deps.log.warn(`empty transcript (${bytes.byteLength} bytes, ${attachment.contentType})`);
        return null;
      }
      return text;
    } catch (err) {
      deps.log.warn("transcribe failed", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
