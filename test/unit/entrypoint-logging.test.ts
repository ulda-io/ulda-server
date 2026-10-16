import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  config: vi.fn(), makeServer: vi.fn(), loadStorage: vi.fn(), start: vi.fn(), close: vi.fn(),
  storageClose: vi.fn(), connect: vi.fn(), release: vi.fn(), end: vi.fn(),
  migrate: vi.fn(), onPoolError: undefined as ((error: unknown) => void) | undefined,
}));

vi.mock("../../src/config/config.js", () => ({ loadConfig: fakes.config }));
vi.mock("../../src/storage/load-storage-adapter.js", () => ({ loadStorageAdapter: fakes.loadStorage }));
vi.mock("../../src/app/create-server.js", () => ({
  createUldaServer: fakes.makeServer,
}));
vi.mock("../../src/storage/postgres/postgres-resource-storage.js", () => ({
  PostgresResourceStorage: class {
    constructor(_config: unknown, onError: (error: unknown) => void) { fakes.onPoolError = onError; }
    close = fakes.storageClose;
  },
}));
vi.mock("../../src/storage/postgres/postgres-pool.js", () => ({
  createPostgresPool: () => pool,
}));
vi.mock("../../src/storage/postgres/migrations.js", () => ({ runPostgresMigrations: fakes.migrate }));

const marker = "synthetic-private-entrypoint";
let pool: EventEmitter & { connect: typeof fakes.connect; end: typeof fakes.end };
let client: EventEmitter & { release: typeof fakes.release };
const failure = () => new Error(marker, { cause: new Error(marker) });
let lines: string[];
let previousExitCode: typeof process.exitCode;
let previousSignals: Map<"SIGINT" | "SIGTERM", Set<(...args: any[]) => void>>;
const records = () => lines.map(line => JSON.parse(line));
const diagnostic = (code: string) => records().find(record => record.diagnostic === code);
const newSignalListeners = (signal: "SIGINT" | "SIGTERM") =>
  process.listeners(signal).filter(listener => !previousSignals.get(signal)?.has(listener));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  lines = [];
  previousExitCode = process.exitCode;
  previousSignals = new Map((["SIGINT", "SIGTERM"] as const).map(signal =>
    [signal, new Set(process.listeners(signal))]));
  for (const method of ["log", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation(value => { lines.push(String(value)); });
  fakes.config.mockReturnValue({ logLevel: "debug", database: {}, gracefulShutdownTimeoutMs: 1000 });
  fakes.makeServer.mockReturnValue({ start: fakes.start, close: fakes.close });
  fakes.loadStorage.mockResolvedValue({ close: fakes.storageClose });
  fakes.start.mockResolvedValue(undefined);
  fakes.close.mockResolvedValue(undefined);
  fakes.storageClose.mockResolvedValue(undefined);
  fakes.onPoolError = undefined;
  pool = Object.assign(new EventEmitter(), { connect: fakes.connect, end: fakes.end });
  client = Object.assign(new EventEmitter(), { release: fakes.release });
  fakes.connect.mockResolvedValue(client);
  fakes.end.mockResolvedValue(undefined);
  fakes.migrate.mockResolvedValue({ applied: [], alreadyApplied: [] });
});

afterEach(() => {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    for (const listener of newSignalListeners(signal)) process.removeListener(signal, listener);
  process.exitCode = previousExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Applies to every path, including migrations and shutdown, with the real logger.
  expect(lines.join("").includes(marker)).toBe(false);
});

describe("entrypoint diagnostics", () => {
  it("closes storage if constructing the server throws before start", async () => {
    fakes.makeServer.mockImplementation(() => { throw failure(); });
    await import("../../src/main.js");
    await vi.waitFor(() => expect(diagnostic("server.start_failed")).toBeDefined());
    expect(fakes.storageClose).toHaveBeenCalledOnce();
    expect(fakes.start).not.toHaveBeenCalled();
  });

  it("a shutdown deadline reports failure without cancelling or replaying accepted work", async () => {
    vi.useFakeTimers();
    let finish!: () => void, completed = false;
    fakes.close.mockImplementation(async () => { await new Promise<void>(r => { finish = r; }); completed = true; });
    await import("../../src/main.js");
    await vi.waitFor(() => expect(newSignalListeners("SIGTERM")).toHaveLength(1));
    newSignalListeners("SIGTERM")[0]!("SIGTERM");
    await vi.advanceTimersByTimeAsync(1001);
    expect(diagnostic("server.shutdown_timeout")).toBeDefined();
    expect(completed).toBe(false);
    expect(fakes.storageClose).not.toHaveBeenCalled();
    expect(fakes.close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes a checked-out migration client error and discards the broken client", async () => {
    fakes.migrate.mockImplementation(async () => {
      client.emit("error", failure());
      return { applied: [], alreadyApplied: [] };
    });
    await import("../../src/cli/migrate-postgres.js");
    await vi.waitFor(() => expect(diagnostic("migration.failed")).toBeDefined());
    expect(fakes.release).toHaveBeenCalledWith(true);
    expect(fakes.end).toHaveBeenCalledOnce();
    expect(client.listenerCount("error")).toBe(0);
    expect(diagnostic("migration.ready")).toBeUndefined();
  });

  it("consumes an idle migration pool error during cleanup without claiming ready", async () => {
    fakes.end.mockImplementation(async () => { pool.emit("error", failure()); });
    await import("../../src/cli/migrate-postgres.js");
    await vi.waitFor(() => expect(diagnostic("migration.failed")).toBeDefined());
    expect(diagnostic("storage.pool_error")).toBeDefined();
    expect(diagnostic("migration.ready")).toBeUndefined();
  });

  it("still ends the migration pool if releasing the client throws", async () => {
    fakes.release.mockImplementation(() => { throw failure(); });
    await import("../../src/cli/migrate-postgres.js");
    await vi.waitFor(() => expect(diagnostic("migration.failed")).toBeDefined());
    expect(fakes.end).toHaveBeenCalledOnce();
    expect(client.listenerCount("error")).toBe(0);
    expect(diagnostic("migration.ready")).toBeUndefined();
  });

  it("reports migration cleanup rejection without a premature ready message", async () => {
    fakes.end.mockRejectedValue(failure());
    await import("../../src/cli/migrate-postgres.js");
    await vi.waitFor(() => expect(diagnostic("migration.failed")).toBeDefined());
    expect(diagnostic("migration.ready")).toBeUndefined();
    expect(client.listenerCount("error")).toBe(0);
  });
  it("suppresses configuration failures before a configured logger exists", async () => {
    fakes.config.mockImplementation(() => { throw failure(); });
    await import("../../src/main.js");
    await vi.waitFor(() => expect(diagnostic("server.start_failed")).toBeDefined());
    expect(process.exitCode).toBe(1);
    expect(fakes.start).not.toHaveBeenCalled();
  });

  it("suppresses custom adapter startup failures", async () => {
    fakes.config.mockReturnValue({ logLevel: "debug", storageAdapterModule: "test-only-adapter" });
    fakes.loadStorage.mockRejectedValue(failure());
    await import("../../src/main.js");
    await vi.waitFor(() => expect(diagnostic("server.start_failed")).toBeDefined());
    expect(process.exitCode).toBe(1);
    expect(fakes.start).not.toHaveBeenCalled();
  });

  it("reports both startup and cleanup failures without either raw exception", async () => {
    fakes.start.mockRejectedValue(failure());
    fakes.storageClose.mockRejectedValue(failure());
    await import("../../src/main.js");
    await vi.waitFor(() => expect(diagnostic("server.start_failed")).toBeDefined());
    expect(diagnostic("storage.cleanup_failed")).toBeDefined();
    expect(fakes.storageClose).toHaveBeenCalledOnce();
    expect(newSignalListeners("SIGTERM")).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it("handles idle PostgreSQL errors with safe diagnostics", async () => {
    await import("../../src/main.js");
    await vi.waitFor(() => expect(fakes.onPoolError).toBeDefined());
    fakes.onPoolError!(failure());
    expect(diagnostic("storage.pool_error")).toBeDefined();
  });

  it("consumes a shutdown rejection and does not repeat shutdown for a second signal", async () => {
    fakes.close.mockRejectedValue(failure());
    await import("../../src/main.js");
    await vi.waitFor(() => expect(newSignalListeners("SIGTERM")).toHaveLength(1));
    // Call only the new handlers; never send a real OS signal to the test runner.
    newSignalListeners("SIGTERM")[0]!("SIGTERM");
    newSignalListeners("SIGINT")[0]!("SIGINT");
    await vi.waitFor(() => expect(diagnostic("server.shutdown_failed")).toBeDefined());
    expect(diagnostic("server.shutdown_requested").signal).toBe("SIGTERM");
    expect(fakes.close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("closes the migration pool and suppresses connection failures", async () => {
    fakes.connect.mockRejectedValue(failure());
    await import("../../src/cli/migrate-postgres.js");
    await vi.waitFor(() => expect(diagnostic("migration.failed")).toBeDefined());
    expect(fakes.release).not.toHaveBeenCalled();
    expect(fakes.end).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("releases the client on migration failure without printing SQL diagnostics", async () => {
    fakes.migrate.mockRejectedValue(failure());
    await import("../../src/cli/migrate-postgres.js");
    await vi.waitFor(() => expect(diagnostic("migration.failed")).toBeDefined());
    expect(fakes.release).toHaveBeenCalledOnce();
    expect(fakes.end).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("reports migration counts instead of reflecting migration filenames", async () => {
    fakes.migrate.mockImplementation(async (_client, _directory, onApplied) => {
      onApplied(marker);
      return { applied: [marker], alreadyApplied: [marker, marker] };
    });
    await import("../../src/cli/migrate-postgres.js");
    await vi.waitFor(() => expect(diagnostic("migration.ready")).toBeDefined());
    expect(diagnostic("migration.applied")).toBeDefined();
    expect(diagnostic("migration.ready")).toMatchObject({ applied: 1, alreadyApplied: 2 });
    expect(fakes.release).toHaveBeenCalledOnce();
    expect(fakes.end).toHaveBeenCalledOnce();
  });
});
