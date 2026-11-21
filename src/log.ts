export type Level = "debug" | "info" | "warn" | "error";

export type LoggerOptions = {
  level?: string;
  write?: (line: string) => void;
};

export type Logger = {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string, err?: unknown): void;
  error(msg: string, err?: unknown): void;
};

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const REDACTED = "[REDACTED]";
const SECRET_ENV_KEYS = ["DISCORD_BOT_TOKEN", "GATEWAY_TOKEN", "STT_API_KEY"] as const;

function parseLevel(raw: string): Level {
  if (Object.hasOwn(LEVEL_RANK, raw)) return raw as Level;
  throw new Error(`LOG_LEVEL must be one of debug|info|warn|error, got "${raw}"`);
}

function secretValues(): string[] {
  return SECRET_ENV_KEYS.flatMap((key) => {
    const value = process.env[key];
    return value ? [value] : [];
  });
}

function redact(text: string): string {
  return secretValues().reduce((out, secret) => out.split(secret).join(REDACTED), text);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extra destination for every line, set once at startup. stdout is always
 * written: Docker's copy is the floor that survives a dead worker, so a sink can
 * never be the only place a line went.
 */
let sink: ((line: string) => void) | null = null;

export function setLogSink(fn: ((line: string) => void) | null): void {
  sink = fn;
}

export function createLogger(scope: string, opts: LoggerOptions = {}): Logger {
  const threshold = LEVEL_RANK[parseLevel(opts.level ?? process.env.LOG_LEVEL ?? "info")];
  const write =
    opts.write ??
    ((line: string) => {
      console.log(line);
      sink?.(line);
    });

  function emit(level: Level, msg: string, err?: unknown): void {
    if (LEVEL_RANK[level] < threshold) return;
    const entry: Record<string, string> = {
      t: new Date().toISOString(),
      level,
      scope,
      msg: redact(msg),
    };
    if (err !== undefined) entry.error = redact(errorText(err));
    write(JSON.stringify(entry));
  }

  return {
    debug: (msg) => emit("debug", msg),
    info: (msg) => emit("info", msg),
    warn: (msg, err) => emit("warn", msg, err),
    error: (msg, err) => emit("error", msg, err),
  };
}
