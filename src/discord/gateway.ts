import { createLogger, type Logger } from "../log";

const DEFAULT_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 30_000;
const IDENTIFY_PROPERTIES = { os: "linux", browser: "hucklenanny-gateway", device: "hucklenanny-gateway" };

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export type ReadyUser = { id: string; username: string };

export type GatewayPresence = {
  status?: "online" | "idle" | "dnd" | "invisible";
  activities?: { name: string; type: number }[];
};

export type GatewayOptions = {
  token: string;
  intents: number;
  /** WSS endpoint; tests point this at a local mock. */
  url?: string;
  backoffCapMs?: number;
  /** Initial presence advertised in IDENTIFY. Defaults to online with no activity. */
  presence?: GatewayPresence;
};

export type GatewayCallbacks = {
  /** `t` is the dispatch's event type; only MESSAGE_CREATE is a new message. */
  onMessage(d: unknown, t?: string): void | Promise<void>;
  onReady?(user: ReadyUser): void;
};

type GatewayFrame = { op: number; s?: number | null; t?: string; d?: unknown };

export class DiscordGateway {
  private readonly token: string;
  private readonly intents: number;
  private readonly url: string;
  private readonly backoffCapMs: number;
  private readonly presence: GatewayPresence | undefined;
  private readonly cb: GatewayCallbacks;
  private readonly log: Logger;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq: number | null = null;
  private reconnectAttempts = 0;
  private stopped = true;

  constructor(opts: GatewayOptions, cb: GatewayCallbacks) {
    this.token = opts.token;
    this.intents = opts.intents;
    this.url = opts.url ?? DEFAULT_URL;
    this.backoffCapMs = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.presence = opts.presence;
    this.cb = cb;
    this.log = createLogger("discord");
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.log.info("connecting to the discord gateway");
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.clearReconnect();
    this.ws?.close(1000, "gateway stopped");
    this.ws = null;
  }

  private openSocket(): void {
    this.lastSeq = null; // no RESUME: a new session restarts the sequence
    const ws = new WebSocket(this.url);
    this.ws = ws;
    // identity guards: a replaced or stopped socket must not act for the live one
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.handleFrame(ev.data);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.handleClose();
    };
    ws.onerror = () => this.log.debug("socket error; close will follow");
  }

  private handleFrame(raw: unknown): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(String(raw)) as GatewayFrame;
    } catch {
      this.log.warn("dropping a non-JSON gateway frame");
      return;
    }
    switch (frame.op) {
      case OP_HELLO:
        this.handleHello(frame.d);
        break;
      case OP_DISPATCH:
        this.handleDispatch(frame);
        break;
      case OP_HEARTBEAT_ACK:
        break;
      default:
        this.log.debug(`ignoring gateway op ${frame.op}`);
    }
  }

  private handleHello(d: unknown): void {
    const interval = (d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval;
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 1) {
      this.log.warn("HELLO carried an unusable heartbeat_interval; dropping the connection");
      this.ws?.close();
      return;
    }
    this.clearHeartbeat();
    this.sendHeartbeat(); // jitter-0 first beat: protocol-legal, and it lands before IDENTIFY
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval);
    this.sendIdentify();
  }

  private handleDispatch(frame: GatewayFrame): void {
    if (typeof frame.s === "number") this.lastSeq = frame.s;
    if (frame.t === "READY") this.handleReady(frame.d);
    this.emitMessage(frame.d, frame.t);
  }

  private handleReady(d: unknown): void {
    this.reconnectAttempts = 0;
    const user = (d as { user?: unknown } | null)?.user;
    if (!isReadyUser(user)) {
      this.log.warn("READY carried no well-formed user");
      return;
    }
    this.log.info(`ready as ${user.username}`);
    this.cb.onReady?.(user);
  }

  private emitMessage(d: unknown, t?: string): void {
    try {
      Promise.resolve(this.cb.onMessage(d, t)).catch((err) => this.log.error("onMessage handler failed", err));
    } catch (err) {
      this.log.error("onMessage handler failed", err);
    }
  }

  private handleClose(): void {
    this.clearHeartbeat();
    this.ws = null;
    if (this.stopped) return;
    const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** this.reconnectAttempts, this.backoffCapMs);
    this.reconnectAttempts += 1;
    this.log.info(`gateway closed; reconnecting in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delayMs);
  }

  private sendHeartbeat(): void {
    this.send({ op: OP_HEARTBEAT, d: this.lastSeq });
  }

  private sendIdentify(): void {
    const presence = this.presence ?? {};
    const d: Record<string, unknown> = { token: this.token, intents: this.intents, properties: IDENTIFY_PROPERTIES };
    if (presence.status || presence.activities) {
      d.presence = {
        status: presence.status ?? "online",
        since: null,
        afk: false,
        activities: presence.activities ?? [],
      };
    }
    this.send({ op: OP_IDENTIFY, d });
  }

  private send(frame: { op: number; d: unknown }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function isReadyUser(value: unknown): value is ReadyUser {
  if (typeof value !== "object" || value === null) return false;
  const { id, username } = value as Record<string, unknown>;
  return typeof id === "string" && typeof username === "string";
}
