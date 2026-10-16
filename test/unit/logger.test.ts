import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, type LogContext } from "../../src/observability/logger.js";

afterEach(() => vi.restoreAllMocks());

function capture() {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation(value => { lines.push(String(value)); });
  return { lines, records: () => lines.map(line => JSON.parse(line)) };
}

describe("bounded server diagnostics", () => {
  it("never serializes exception messages, stacks, causes or custom properties", () => {
    const out = capture();
    const marker = "synthetic-private-diagnostic";
    const failure = Object.assign(new Error(marker, { cause: new Error(marker) }), {
      name: marker, detail: marker, connectionString: marker, payload: marker,
    });
    createLogger("debug").error("ULDA server failed to start", failure);
    expect(out.lines.join("").includes(marker)).toBe(false);
    expect(out.records()[0]).toMatchObject({ level: "error", diagnostic: "server.start_failed" });
  });

  it("does not inspect hostile thrown values", () => {
    const out = capture();
    const touched = vi.fn(() => { throw new Error("synthetic-getter"); });
    const failure = new Proxy({}, { get: touched, getPrototypeOf: touched, ownKeys: touched });
    expect(() => createLogger("error").error("PostgreSQL pool reported an idle-client error", failure)).not.toThrow();
    expect(touched).not.toHaveBeenCalled();
    expect(out.records()[0].diagnostic).toBe("storage.pool_error");
  });

  it("drops private context and cannot override the log envelope", () => {
    const out = capture();
    const context = {
      password: "synthetic-private", origin: "synthetic-private", payload: "synthetic-private",
      witness: "synthetic-private", connectionString: "synthetic-private", error: "synthetic-private",
      time: "synthetic-private", level: "synthetic-private", message: "synthetic-private",
      diagnostic: "synthetic-private", code: "not_found", event: "ulda:read", resourceId: "42",
    } as unknown as LogContext;
    createLogger("warn").warn("Socket command rejected", context);
    const record = out.records()[0];
    expect(out.lines.join("").includes("synthetic-private")).toBe(false);
    expect(record).toMatchObject({ level: "warn", diagnostic: "socket.command_rejected",
      code: "not_found", event: "ulda:read", resourceId: "42" });
    expect(Number.isNaN(Date.parse(record.time))).toBe(false);
  });

  it("ignores inherited fields and accessors without invoking them", () => {
    const out = capture();
    const getter = vi.fn(() => "synthetic-private");
    const context = Object.create({ code: "not_found" });
    Object.defineProperty(context, "event", { enumerable: true, get: getter });
    Object.defineProperty(context, "toJSON", { value: getter });
    context.port = 3000;
    createLogger("info").info("ULDA server started", context);
    expect(getter).not.toHaveBeenCalled();
    expect(out.records()[0].code).toBeUndefined();
    expect(out.records()[0].event).toBeUndefined();
    expect(out.records()[0].port).toBe(3000);
  });

  it("survives revoked contexts without exposing diagnostics", () => {
    const out = capture();
    const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
    expect(() => createLogger("info").info("ULDA server started", proxy)).not.toThrow();
    expect(out.records()[0].diagnostic).toBe("server.started");
  });

  it("accepts only known labels and bounded metadata values", () => {
    const out = capture();
    const logger = createLogger("info");
    for (const label of ["synthetic-private-label", "__proto__", "constructor"])
      logger.info(label, { event: "synthetic-private", code: "constructor",
        host: "synthetic-private", port: Infinity, resourceId: "0", durationMs: -1 });
    for (const record of out.records()) {
      expect(Object.keys(record).sort()).toEqual(["diagnostic", "level", "message", "time"]);
      expect(record.diagnostic).toBe("server.diagnostic");
    }
    expect(out.lines.join("").includes("synthetic-private")).toBe(false);
  });

  it("keeps useful server-generated metadata and log levels", () => {
    const out = capture();
    const logger = createLogger("warn");
    logger.info("ULDA server started", { port: 3000 });
    logger.debug("Socket connected");
    logger.warn("Socket command rejected", { requestId: "123e4567-e89b-42d3-a456-426614174000",
      socketId: "abcdefghijklmnopqrst", resourceId: "9223372036854775807",
      event: "resource:update", code: "stale_state", durationMs: 12 });
    expect(out.lines).toHaveLength(1);
    expect(out.records()[0]).toMatchObject({ code: "stale_state", durationMs: 12,
      resourceId: "9223372036854775807", socketId: "abcdefghijklmnopqrst" });
  });
});
