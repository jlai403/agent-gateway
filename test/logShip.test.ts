import { describe, expect, test } from "bun:test";
import { createLogShipper } from "../src/logShip";

type Captured = { url: string; body: { lines: string[] } };

function stubFetch(status = 200): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) as { lines: string[] } });
    return new Response(JSON.stringify({ accepted: 1 }), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("createLogShipper", () => {
  test("posts buffered lines to the worker's /log", async () => {
    const { calls, fetchImpl } = stubFetch();
    const shipper = createLogShipper({ url: "http://worker:8080", token: "t", fetchImpl });
    shipper.push('{"msg":"a"}');
    shipper.push('{"msg":"b"}');
    await shipper.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://worker:8080/log");
    expect(calls[0]?.body.lines).toEqual(['{"msg":"a"}', '{"msg":"b"}']);
    shipper.stop();
  });

  test("flushes immediately once the batch is full", async () => {
    const { calls, fetchImpl } = stubFetch();
    const shipper = createLogShipper({ url: "http://w", token: "t", fetchImpl, maxLines: 2 });
    shipper.push("1");
    shipper.push("2");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    shipper.stop();
  });

  test("reports a failure once and keeps the process running", async () => {
    const { fetchImpl } = stubFetch(404);
    const errors: string[] = [];
    const shipper = createLogShipper({ url: "http://w", token: "t", fetchImpl, onError: (m) => errors.push(m) });
    shipper.push("1");
    await shipper.flush();
    shipper.push("2");
    await shipper.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("404");
    shipper.stop();
  });

  test("survives a network error without throwing", async () => {
    const errors: string[] = [];
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const shipper = createLogShipper({ url: "http://w", token: "t", fetchImpl, onError: (m) => errors.push(m) });
    shipper.push("1");
    await expect(shipper.flush()).resolves.toBeUndefined();
    expect(errors[0]).toContain("ECONNREFUSED");
    shipper.stop();
  });

  test("drops lines after stop", async () => {
    const { calls, fetchImpl } = stubFetch();
    const shipper = createLogShipper({ url: "http://w", token: "t", fetchImpl });
    shipper.stop();
    shipper.push("1");
    await shipper.flush();
    expect(calls).toHaveLength(0);
  });
});
