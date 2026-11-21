// Ships the gateway's JSON log lines to the worker, which re-emits them so celld
// records them alongside the worker's own lines (same Parquet, same query).
//
// Fire-and-forget by design: the gateway rolls independently of the worker
// bundle, so a worker that predates `POST /log` answers 404 and this must cost a
// turn nothing. stdout is still written by the logger, so a dead worker cannot
// swallow the evidence — it only stops it being searchable from a laptop.
//
// Failures report through `onError` (not through the logger, which would feed the
// sink that failed) and warn once, because a broken pipe is one incident, not one
// incident per batch.

export interface LogShipperOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  batchMs?: number;
  maxLines?: number;
  onError?: (message: string) => void;
}

export interface LogShipper {
  push(line: string): void;
  flush(): Promise<void>;
  stop(): void;
}

const DEFAULT_BATCH_MS = 2000;
const DEFAULT_MAX_LINES = 50;

export function createLogShipper(opts: LogShipperOptions): LogShipper {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const batchMs = opts.batchMs ?? DEFAULT_BATCH_MS;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const endpoint = `${opts.url.replace(/\/$/, "")}/log`;

  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let warned = false;
  let stopped = false;

  function schedule(): void {
    if (timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, batchMs);
    timer.unref?.();
  }

  async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const batch = pending;
    pending = [];
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ lines: batch }),
      });
      if (!res.ok && !warned) {
        warned = true;
        opts.onError?.(`POST /log answered ${res.status}; gateway lines stay on stdout only`);
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        opts.onError?.(`POST /log failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      flushing = false;
    }
  }

  return {
    push(line: string) {
      if (stopped) return;
      pending.push(line);
      if (pending.length >= maxLines) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void flush();
      } else {
        schedule();
      }
    },
    flush,
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
