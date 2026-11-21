import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../src/log";

const GATEWAY_ROOT = join(import.meta.dir, "..");

function captureLines(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("gateway env example", () => {
  test("documents every gateway variable", () => {
    const example = readFileSync(join(GATEWAY_ROOT, ".env.example"), "utf8");
    for (const key of ["DISCORD_BOT_TOKEN", "WORKER_URL", "GATEWAY_TOKEN", "PORT=8090", "LOG_LEVEL"]) {
      expect(example).toContain(key);
    }
  });
});

describe("createLogger", () => {
  test("writes a JSON line with level, scope and msg", () => {
    const { lines, write } = captureLines();
    const log = createLogger("gateway", { level: "info", write });

    log.info("ready");

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: "info", scope: "gateway", msg: "ready" });
    expect(typeof entry.t).toBe("string");
  });

  test("redacts DISCORD_BOT_TOKEN from messages and errors", () => {
    process.env.DISCORD_BOT_TOKEN = "abc123";
    try {
      const { lines, write } = captureLines();
      const log = createLogger("gateway", { level: "info", write });

      log.warn("fetch failed abc123 401", new Error("bad token abc123"));

      expect(lines[0]).not.toContain("abc123");
      const entry = JSON.parse(lines[0]!);
      expect(entry.msg).toBe("fetch failed [REDACTED] 401");
      expect(entry.error).toBe("bad token [REDACTED]");
    } finally {
      delete process.env.DISCORD_BOT_TOKEN;
    }
  });

  test("redacts GATEWAY_TOKEN", () => {
    process.env.GATEWAY_TOKEN = "gw-secret-9";
    try {
      const { lines, write } = captureLines();
      const log = createLogger("gateway", { level: "info", write });

      log.error("forwarded with gw-secret-9");

      expect(lines[0]).not.toContain("gw-secret-9");
    } finally {
      delete process.env.GATEWAY_TOKEN;
    }
  });

  test("drops lines below the configured level", () => {
    const { lines, write } = captureLines();
    const log = createLogger("gateway", { level: "info", write });

    log.debug("noisy");
    log.info("kept");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe("kept");
  });

  test("throws on an unknown level", () => {
    expect(() => createLogger("gateway", { level: "loud" })).toThrow();
  });

  test("rejects prototype keys as levels", () => {
    expect(() => createLogger("gateway", { level: "constructor" })).toThrow();
  });
});
