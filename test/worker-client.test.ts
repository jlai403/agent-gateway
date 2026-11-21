import { describe, expect, test } from "bun:test";

import type { InboundMessage } from "../src/discord/messages";
import { WorkerClient } from "../src/worker-client";

const WORKER_URL = "http://worker.test";
const TOKEN = "sekrit";

type RecordedCall = { url: string; init: RequestInit | undefined };

function stubFetch(respond: () => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return await respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const mention: InboundMessage = { chatId: "discord:c1", speaker: "Dad", text: "when was the last feed?" };

function newWorker(fetchImpl: typeof fetch): WorkerClient {
  return new WorkerClient({ url: WORKER_URL, token: TOKEN, fetchImpl });
}

describe("WorkerClient", () => {
  describe("runTurn request", () => {
    test("POSTs <url>/inbound with the bearer token and the inbound body", async () => {
      const { fetchImpl, calls } = stubFetch(() => Response.json({ text: "stub reply" }));

      const result = await newWorker(fetchImpl).runTurn(mention);

      expect(result).toEqual({ text: "stub reply" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${WORKER_URL}/inbound`);
      expect(calls[0]!.init?.method).toBe("POST");
      expect(calls[0]!.init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
        chatId: "discord:c1",
        speaker: "Dad",
        text: "when was the last feed?",
      });
    });

    test("a voice-note attachment rides along; no attachment key without one", async () => {
      const { fetchImpl, calls } = stubFetch(() => Response.json({ text: "ok" }));
      const voiceNote: InboundMessage = {
        ...mention,
        attachment: { url: "https://cdn/voice.ogg", contentType: "audio/ogg" },
      };

      await newWorker(fetchImpl).runTurn(voiceNote);
      await newWorker(fetchImpl).runTurn(mention);

      expect(JSON.parse(String(calls[0]!.init?.body)).attachment).toEqual({
        url: "https://cdn/voice.ogg",
        contentType: "audio/ogg",
      });
      expect(JSON.parse(String(calls[1]!.init?.body))).not.toHaveProperty("attachment");
    });
  });

  describe("status branches", () => {
    test("404 marks the worker not ready (retryable)", async () => {
      const { fetchImpl } = stubFetch(() => Response.json({}, { status: 404 }));

      expect(await newWorker(fetchImpl).runTurn(mention)).toEqual({ error: "worker HTTP 404", retryable: true });
    });

    test("502 is retryable as well", async () => {
      const { fetchImpl } = stubFetch(() => Response.json({}, { status: 502 }));

      expect(await newWorker(fetchImpl).runTurn(mention)).toEqual({ error: "worker HTTP 502", retryable: true });
    });

    test("any other non-2xx is a hard failure without a retryable flag", async () => {
      const { fetchImpl } = stubFetch(() => Response.json({}, { status: 500 }));

      const result = await newWorker(fetchImpl).runTurn(mention);

      expect(result.error).toBe("worker HTTP 500");
      expect(result.retryable).toBeUndefined();
    });

    test("a JSON error body is surfaced, not discarded", async () => {
      const { fetchImpl } = stubFetch(() =>
        Response.json({ error: "MCP tools/list failed: HTTP 401" }, { status: 500 }),
      );

      const result = await newWorker(fetchImpl).runTurn(mention);

      expect(result.error).toBe("worker HTTP 500: MCP tools/list failed: HTTP 401");
      expect(result.retryable).toBeUndefined();
    });

    test("a non-JSON body is included and collapsed to one line", async () => {
      const { fetchImpl } = stubFetch(() => new Response("Bad\n  Gateway\n", { status: 503 }));

      expect((await newWorker(fetchImpl).runTurn(mention)).error).toBe("worker HTTP 503: Bad Gateway");
    });

    test("an oversized body is truncated", async () => {
      const { fetchImpl } = stubFetch(() => new Response("x".repeat(500), { status: 500 }));

      const error = (await newWorker(fetchImpl).runTurn(mention)).error ?? "";

      expect(error.startsWith("worker HTTP 500: ")).toBe(true);
      expect(error.endsWith("…")).toBe(true);
      expect(error.length).toBeLessThan(240);
    });

    test("an empty body keeps the bare status", async () => {
      const { fetchImpl } = stubFetch(() => new Response("", { status: 500 }));

      expect((await newWorker(fetchImpl).runTurn(mention)).error).toBe("worker HTTP 500");
    });
  });

  describe("transport failure", () => {
    test("a fetch throw surfaces the error message, not retryable", async () => {
      const { fetchImpl } = stubFetch(() => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:1");
      });

      const result = await newWorker(fetchImpl).runTurn(mention);

      expect(result.error).toBe("connect ECONNREFUSED 127.0.0.1:1");
      expect(result.retryable).toBeUndefined();
      expect(result.text).toBeUndefined();
    });
  });
});
