import { afterEach, expect, it } from "vitest";
import { createUldaServer, type UldaServer } from "../../src/app/create-server.js";
import { loadConfig } from "../../src/config/config.js";
import { InMemoryResourceStorage } from "../../src/storage/in-memory-resource-storage.js";

let server: UldaServer | undefined;
const releases: Array<() => void> = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; }); releases.push(resolve);
  return { promise, resolve };
}
afterEach(async () => { releases.splice(0).forEach(release => release()); await server?.close(); server = undefined; });

it("bounds concurrent HTTP readiness waiters and shares one actual storage ping", async () => {
  const entered = gate(), release = gate();
  let checks = 0;
  const storage = new InMemoryResourceStorage();
  const config = loadConfig({ LOG_LEVEL: "error", READINESS_MAX_WAITERS: "2" });
  config.host = "127.0.0.1"; config.port = 0;
  server = createUldaServer({ config, storage });
  const url = "http://127.0.0.1:" + (await server.start()).port;
  storage.ping = async () => { checks++; entered.resolve(); await release.promise; };
  const statuses: number[] = [];
  const requests = Array.from({ length: 20 }, () => fetch(url + "/ready").then(async response => {
    statuses.push(response.status);
    expect(await response.json()).toEqual(response.ok ? { ok: true } : { ok: false, code: "not_ready" });
    return response.status;
  }));
  await entered.promise;
  await expect.poll(() => statuses.length).toBe(18);
  expect(statuses.every(status => status === 503)).toBe(true);
  expect(checks).toBe(1);
  expect((await fetch(url + "/health")).status).toBe(200);
  release.resolve();
  expect((await Promise.all(requests)).filter(status => status === 200)).toHaveLength(2);
  expect((await fetch(url + "/ready")).status).toBe(200);
  expect(checks).toBe(1);
});

it("responds to a stuck probe with fixed 503 and suppresses a late private failure", async () => {
  const release = gate(); let calls = 0;
  const storage = new InMemoryResourceStorage();
  const config = loadConfig({ LOG_LEVEL: "error", READINESS_TIMEOUT_MS: "100", READINESS_CACHE_MS: "0" });
  config.host = "127.0.0.1"; config.port = 0;
  server = createUldaServer({ config, storage });
  const url = "http://127.0.0.1:" + (await server.start()).port;
  storage.ping = async () => { calls++; await release.promise; throw new Error("synthetic-private-readiness"); };
  for (let i = 0; i < 5; i++) {
    const response = await fetch(url + "/ready");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"ok":false,"code":"not_ready"}');
  }
  expect(calls).toBe(1);
  release.resolve();
});

it.each([
  ["READINESS_MAX_WAITERS", "0"], ["READINESS_TIMEOUT_MS", "0"], ["READINESS_CACHE_MS", "-1"],
  ["DATABASE_STATEMENT_TIMEOUT_MS", "0"], ["DATABASE_LOCK_TIMEOUT_MS", "-1"],
  ["DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", "Infinity"],
])("rejects unsafe %s=%s configuration", (name, value) => {
  expect(() => loadConfig({ [name]: value })).toThrow();
});
