import { describe, expect, test } from "bun:test";
import { createTranscriber } from "../src/stt";
import { createLogger } from "../src/log";

const log = createLogger("stt-test", { level: "error", write: () => {} });

function fetchStub(handlers: {
  audio?: () => Response;
  stt?: (url: string, init: RequestInit) => Response;
}): { calls: Array<{ url: string; init: RequestInit }>; fetchImpl: typeof fetch } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.includes("/asr")) return handlers.stt?.(url, init) ?? new Response("hi", { status: 200 });
    return handlers.audio?.() ?? new Response(new ArrayBuffer(8), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const attachment = { url: "https://cdn.discordapp.com/voice.ogg?ex=1", contentType: "audio/ogg" };

describe("createTranscriber", () => {
  test("returns null when no endpoint is configured", () => {
    expect(createTranscriber({ endpoint: "  " }, { log })).toBeNull();
  });

  test("posts multipart audio_file to /asr with txt output", async () => {
    const { calls, fetchImpl } = fetchStub({});
    const transcribe = createTranscriber({ endpoint: "http://whisper:9000/" }, { log, fetchImpl });
    const text = await transcribe!(attachment);

    expect(text).toBe("hi");
    const stt = calls.find((call) => call.url.includes("/asr"));
    // The deployed image serves /asr with a multipart `audio_file` field; the
    // OpenAI-shaped /v1/audio/transcriptions it used to call does not exist.
    expect(stt?.url).toBe("http://whisper:9000/asr?output=txt&task=transcribe");
    const body = stt?.init.body as FormData;
    expect(body.get("audio_file")).toBeInstanceOf(Blob);
  });

  test("collapses the text/plain body into one line", async () => {
    const { fetchImpl } = fetchStub({ stt: () => new Response("  jensen   slept\nlast night \n", { status: 200 }) });
    const transcribe = createTranscriber({ endpoint: "http://w" }, { log, fetchImpl });
    expect(await transcribe!(attachment)).toBe("jensen slept last night");
  });

  test("returns null when the STT server rejects the request", async () => {
    const { fetchImpl } = fetchStub({ stt: () => new Response("not found", { status: 404 }) });
    const transcribe = createTranscriber({ endpoint: "http://w" }, { log, fetchImpl });
    expect(await transcribe!(attachment)).toBeNull();
  });

  test("returns null when the CDN url has expired", async () => {
    const { calls, fetchImpl } = fetchStub({ audio: () => new Response("gone", { status: 403 }) });
    const transcribe = createTranscriber({ endpoint: "http://w" }, { log, fetchImpl });
    expect(await transcribe!(attachment)).toBeNull();
    // No point asking the transcriber about audio we could not download.
    expect(calls.some((call) => call.url.includes("/asr"))).toBe(false);
  });

  test("treats an empty transcript as a failure rather than a turn", async () => {
    const { fetchImpl } = fetchStub({ stt: () => new Response("   ", { status: 200 }) });
    const transcribe = createTranscriber({ endpoint: "http://w" }, { log, fetchImpl });
    expect(await transcribe!(attachment)).toBeNull();
  });
});
