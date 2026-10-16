import { isIP } from "node:net";

export interface LogContext {
  requestId?: string;
  socketId?: string;
  event?: string;
  resourceId?: string;
  code?: string;
  durationMs?: number;
  host?: string;
  port?: number;
  signal?: string;
  reason?: string;
  applied?: number;
  alreadyApplied?: number;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: unknown, context?: LogContext): void;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type LogLevel = keyof typeof LEVELS;

// This is a server diagnostic boundary, not a general-purpose object logger.
// Unknown labels and exception objects are never reflected, even at debug level.
const MESSAGES = new Map<string, string>([
  ["ULDA server started", "server.started"],
  ["ULDA server stopped", "server.stopped"],
  ["ULDA server failed to start", "server.start_failed"],
  ["Shutdown requested", "server.shutdown_requested"],
  ["Graceful shutdown timed out", "server.shutdown_timeout"],
  ["Graceful shutdown failed", "server.shutdown_failed"],
  ["Storage cleanup failed after startup error", "storage.cleanup_failed"],
  ["PostgreSQL pool reported an idle-client error", "storage.pool_error"],
  ["PostgreSQL migration applied", "migration.applied"],
  ["PostgreSQL migrations ready", "migration.ready"],
  ["PostgreSQL migration failed", "migration.failed"],
  ["Realtime broadcast failed after storage update", "socket.broadcast_failed"],
  ["Receiver disconnected: outbound capacity", "socket.outbound_limit"],
  ["Changed delivery failed after commit", "socket.changed_failed"],
  ["Mutation outcome uncertain; connection closed", "socket.mutation_uncertain"],
  ["Socket connected", "socket.connected"],
  ["Socket disconnected", "socket.disconnected"],
  ["Socket command rejected", "socket.command_rejected"],
  ["Socket command failed", "socket.command_failed"],
]);
const EVENTS = new Set([
  ...["hello", "read", "create", "update", "delete", "session.close", "changed"].map(x => "ulda:" + x),
  ...["create", "read", "read-many", "update", "delete", "subscribe", "subscribe-many", "unsubscribe",
    "created", "updated", "deleted"].map(x => "resource:" + x),
  "server:config",
]);
const CODES = new Set([
  "invalid_request", "invalid_witness", "invalid_proof", "not_found", "stale_state",
  "witness_reuse_conflict", "unsupported_protocol_feature", "invalid_transition",
  "rate_limited", "internal_error", "not_ready", "too_large", "conflict", "storage_error",
]);
const REASONS = new Set([
  "server namespace disconnect", "client namespace disconnect", "server shutting down",
  "ping timeout", "transport close", "transport error", "parse error", "forced close", "forced server close",
]);
type Predicate = (value: unknown) => boolean;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const count: Predicate = value => Number.isSafeInteger(value) && (value as number) >= 0;
const FIELDS: ReadonlyArray<readonly [keyof LogContext, Predicate]> = [
  ["requestId", v => text(v, 36) && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(v)],
  ["socketId", v => text(v, 20) && /^[A-Za-z0-9_-]{20}$/u.test(v)],
  ["resourceId", v => text(v, 19) && /^[1-9][0-9]*$/u.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n],
  ["event", v => typeof v === "string" && EVENTS.has(v)],
  ["code", v => typeof v === "string" && CODES.has(v)],
  ["durationMs", v => typeof v === "number" && Number.isFinite(v) && v >= 0],
  ["host", v => text(v, 45) && (v === "localhost" || isIP(v) !== 0)],
  ["port", v => count(v) && (v as number) >= 1 && (v as number) <= 65_535],
  ["signal", v => v === "SIGINT" || v === "SIGTERM"],
  ["reason", v => typeof v === "string" && REASONS.has(v)],
  ["applied", count],
  ["alreadyApplied", count],
];

function safeContext(context: unknown): Record<string, string | number> {
  const result: Record<string, string | number> = Object.create(null);
  if (typeof context !== "object" || context === null) return result;
  for (const [field, accepts] of FIELDS) {
    try {
      // Do not enumerate arbitrary keys, invoke accessors/toJSON or copy prototypes.
      const descriptor = Object.getOwnPropertyDescriptor(context, field);
      if (descriptor && Object.hasOwn(descriptor, "value") && accepts(descriptor.value))
        result[field] = descriptor.value as string | number;
    } catch { /* A diagnostic must not expose or throw an unexpected context error. */ }
  }
  return result;
}

export function createLogger(minimumLevel: LogLevel): Logger {
  const minimum = LEVELS[minimumLevel];

  const write = (
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: unknown,
  ): void => {
    if (LEVELS[level] < minimum) return;
    const diagnostic = MESSAGES.get(message);
    const record = {
      time: new Date().toISOString(),
      level,
      diagnostic: diagnostic ?? "server.diagnostic",
      message: diagnostic === undefined ? "Server diagnostic" : message,
      ...safeContext(context),
      // Never inspect a thrown value: even name/message/stack can be private or getters.
      ...(error === undefined ? {} : { error: "details_suppressed" }),
    };
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, error, context) => write("error", message, context, error),
  };
}
