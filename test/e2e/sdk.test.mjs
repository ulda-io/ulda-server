import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Pool } from "pg";
import { Ulda, SocketIoTransport } from "../consumer/index.mjs";
import { requireTestDatabase } from "../support/test-database.mjs";
import { createUldaServer } from "../../dist/app/create-server.js";
import { loadConfig } from "../../dist/config/config.js";
import { PostgresResourceStorage } from "../../dist/storage/postgres/postgres-resource-storage.js";
import { runPostgresMigrations } from "../../dist/storage/postgres/migrations.js";

const connectionString = requireTestDatabase();
const pool = new Pool({ connectionString });
const password = "synthetic-sdk-integration-passphrase";
const privateName = "private-content-name-never-on-wire";
const privateText = "synthetic-plaintext-never-on-server";

test('published SDK treats read admission not_ready as a fixed error without replay or local data loss', async t => {
  const { server, client } = await setup(t), a = client();
  await a.sdk.register(password); await a.sdk.add('checked-content', { n: 1 });
  const before = a.sdk.snapshot(); a.trace.length = 0;
  server.admission.reads.stop();
  await assert.rejects(a.sdk.refresh(), { code: 'SERVER_ERROR' });
  assert.deepEqual(a.sdk.snapshot(), before);
  assert.deepEqual(a.trace.filter(x => x.phase === 'send').map(x => x.event), ['ulda:read']);
});
const dbOptions = { connectionString, maxConnections: 4, connectionTimeoutMs: 5000, idleTimeoutMs: 5000 };
before(async () => {
  const connection = await pool.connect();
  try {
    await runPostgresMigrations(connection, resolve("migrations/postgres"));
    await runPostgresMigrations(connection, resolve("migrations/postgres")); // repeat no-op
  } finally { connection.release(); }
});
beforeEach(() => pool.query("TRUNCATE public.ulda_resources RESTART IDENTITY"));
afterEach(() => pool.query("TRUNCATE public.ulda_resources"));
after(() => pool.end());

async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Expected client state was not reached");
}
async function runtime(overrides = {}) {
  const config = loadConfig({ LOG_LEVEL: "error", ...overrides }); config.host = "127.0.0.1"; config.port = 0;
  const server = createUldaServer({ config, storage: new PostgresResourceStorage(dbOptions) });
  const { port } = await server.start();
  return { server, url: "http://127.0.0.1:" + port };
}
async function setup(t, overrides = {}) {
  const { server, url } = await runtime(overrides), clients = [];
  function client(timeout = 5000) {
    const transport = new SocketIoTransport(url, { timeout, allowInsecureLocalhost: true });
    const sdk = new Ulda(url, { transport, reconnect: false }), trace = [];
    transport.on("trace", event => trace.push(event));
    sdk.on("trace", event => trace.push(event));
    clients.push(sdk); return { sdk, transport, trace };
  }
  t.after(async () => { for (const sdk of clients) await sdk.close(); await server.close(); assert.equal(server.router.subscriptionTotal, 0); assert.equal(server.admission.input.used, 0); assert.equal(server.admission.reads.used, 0); });
  return { server, url, client };
}

for (const mode of ["X", "S"]) test("actual SDK + PostgreSQL lifecycle, fanout, recovery and deletion / " + mode, async t => {
  const { server, client } = await setup(t), a = client(), b = client();
  const id = await a.sdk.register(password);
  assert.equal(server.router.subscriptionTotal, 1);
  assert.equal(a.trace.some(event => event.phase === "send" && event.event === "ulda:read"), false);
  await a.sdk.add(privateName, { text: privateText, n: 1 }, mode);
  assert.equal(server.router.subscriptionTotal, 2);
  await b.sdk.connect(id, password);
  assert.equal(server.router.subscriptionTotal, 4);
  assert.equal(b.sdk.value(privateName).text, privateText);
  const offset = a.trace.length;
  await a.sdk.update(privateName, { text: privateText, n: 2 });
  await until(() => b.sdk.value(privateName).n === 2);
  assert.equal(a.trace.slice(offset).some(event => event.phase === "push"), false);
  const repaired = await a.sdk.recoverContent(privateName);
  await until(() => b.trace.some(event => event.step === "changed.memory" && event.ids.includes(repaired.id)));
  assert.notEqual(repaired.id, repaired.previousId);
  assert.ok(await server.storage.findById(BigInt(repaired.previousId)));
  assert.deepEqual(Object.keys(b.sdk.snapshot()), [privateName]);
  const rows = await pool.query("SELECT id,witness,payload FROM public.ulda_resources WHERE id = ANY($1::bigint[])", [[id, repaired.id, repaired.previousId]]);
  assert.equal(rows.rows.length, 3);
  for (const row of rows.rows) {
    assert.deepEqual(Object.keys(row).sort(), ["id", "payload", "witness"]);
    for (const secret of [password, privateName, privateText]) assert.equal(row.payload.includes(Buffer.from(secret)), false);
  }
  const traces = JSON.stringify([...a.trace, ...b.trace]);
  for (const secret of [password, privateName, privateText]) assert.equal(traces.includes(secret), false);
  await a.sdk.delete(privateName);
  await until(() => !Object.hasOwn(b.sdk.snapshot(), privateName));
  assert.equal(await server.storage.findById(BigInt(repaired.id)), null);
  assert.ok(await server.storage.findById(BigInt(repaired.previousId)), "Recovery did not delete an old shared resource");
  await a.sdk.superDelete();
  assert.equal(await server.storage.findById(BigInt(id)), null);
});

test("corrupt ciphertext is rejected; explicit recovery copies only last verified client state", async t => {
  const { server, client } = await setup(t), a = client();
  await a.sdk.register(password);
  const result = await a.sdk.add(privateName, { text: privateText, n: 1 });
  const contentId = a.trace.findLast(event => event.phase === "ack" && event.event === "ulda:create").ids[0];
  const record = await server.storage.findById(BigInt(contentId));
  const bad = record.payload.slice(); bad[bad.length - 1] ^= 1;
  await pool.query("UPDATE public.ulda_resources SET payload=$2 WHERE id=$1", [contentId, Buffer.from(bad)]);
  await assert.rejects(a.sdk.refresh(), { code: "CRYPTO_FAILED" });
  assert.equal(a.sdk.value(privateName).n, 1);
  const repaired = await a.sdk.recoverContent(privateName);
  assert.equal(repaired.previousId, contentId);
  assert.notEqual(repaired.id, contentId);
  assert.deepEqual((await server.storage.findById(BigInt(contentId))).payload, bad);
  assert.equal(a.sdk.value(privateName).text, privateText);
});

test("lost create ACK produces UNKNOWN_OUTCOME and does not allocate a second resource", async t => {
  const { server, client } = await setup(t);
  let created = 0, committed = 0;
  const create = server.storage.createBatch.bind(server.storage);
  server.storage.createBatch = async items => {
    const rows = await create(items); committed += rows.length;
    for (const row of rows) assert.ok(await server.storage.findById(row.id));
    return rows;
  };
  server.io.on("connection", socket => socket.use((args, next) => {
    if (args[0] === "ulda:create") { created++; args[2] = () => {}; }
    next();
  }));
  const a = client(500);
  await assert.rejects(a.sdk.register(password), { code: "UNKNOWN_OUTCOME" });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(created, 1);
  assert.equal(committed, 1, "Lost ACK must not silently drop the accepted Create");
});

test("lost update ACK preserves last checked copy; explicit reconnect/read finds the committed state without replay", async t => {
  const { server, client } = await setup(t), a = client();
  await a.sdk.register(password); await a.sdk.add(privateName, { n: 1 });
  let writes = 0;
  const socket = [...server.io.sockets.sockets.values()][0];
  socket.use((args, next) => {
    if (args[0] === "ulda:update") { writes++; args[2] = () => {}; }
    next();
  });
  await assert.rejects(a.sdk.update(privateName, { n: 2 }), { code: "UNKNOWN_OUTCOME" });
  assert.equal(a.sdk.value(privateName).n, 1);
  await a.sdk.reconnect();
  assert.equal(a.sdk.value(privateName).n, 2);
  assert.equal(writes, 1);
});

test("a fresh server instance reads exact encrypted records persisted by the previous instance", async t => {
  const first = await runtime();
  const a = new Ulda(first.url, { allowInsecureLocalhost: true, reconnect: false });
  let id;
  try { id = await a.register(password); await a.add(privateName, { text: privateText }); }
  finally { await a.close(); await first.server.close(); }
  const before = await pool.query("SELECT witness,payload FROM public.ulda_resources WHERE id=$1", [id]);
  const second = await runtime();
  const b = new Ulda(second.url, { allowInsecureLocalhost: true, reconnect: false });
  try {
    await b.connect(id, password);
    assert.equal(b.value(privateName).text, privateText);
    const after = await pool.query("SELECT witness,payload FROM public.ulda_resources WHERE id=$1", [id]);
    assert.deepEqual(after.rows, before.rows);
    await b.superDelete();
  } finally { await b.close(); await second.server.close(); }
});

// Inject a lost COMMIT response after the actual PostgreSQL transaction succeeds.
test("actual PostgreSQL commit ambiguity never produces a negative ACK or replay", async t => {
  const { server, client } = await setup(t), a = client();
  await a.sdk.register(password); await a.sdk.add(privateName, { n: 1 });
  const apply = server.storage.applyBatch.bind(server.storage);
  let writes = 0;
  server.storage.applyBatch = async changes => {
    writes++; await apply(changes); throw new Error("Synthetic lost COMMIT response");
  };
  await assert.rejects(a.sdk.update(privateName, { n: 2 }), { code: "UNKNOWN_OUTCOME" });
  await a.sdk.reconnect();
  assert.equal(a.sdk.value(privateName).n, 2);
  assert.equal(writes, 1);
});


test("published SDK cannot bypass subscription refusal through a transfer and reconnects without replay", async t => {
  const { server, client } = await setup(t, { MAX_SUBSCRIPTIONS_PER_SOCKET: "1" }), a = client();
  await a.sdk.register(password);
  const before = await pool.query("SELECT id,witness,payload FROM public.ulda_resources ORDER BY id");
  const local = a.sdk.snapshot();
  let creates = 0;
  const create = server.storage.createBatch.bind(server.storage);
  server.storage.createBatch = async items => { creates++; return create(items); };
  a.trace.length = 0;
  await assert.rejects(a.sdk.add(privateName, { n: 1 }), { code: "LIMIT" });
  assert.deepEqual((await pool.query("SELECT id,witness,payload FROM public.ulda_resources ORDER BY id")).rows, before.rows);
  assert.deepEqual(a.sdk.snapshot(), local);
  assert.equal(creates, 0);
  // A confirmed too_large rejection permits one staged fallback in SDK 1.1.0.
  // Rejection of its commit closes the transport to discard uncommitted staging.
  const sent = () => a.trace.filter(e => e.phase === "send").map(e => e.event + (e.step ? ":" + e.step : ""));
  assert.deepEqual(sent(), ["ulda:create", "ulda:transfer:begin", "ulda:transfer:append", "ulda:transfer:commit"]);
  assert.equal(a.transport.connected, false);
  await until(() => server.router.subscriptionTotal === 0 && server.admission.staging.used === 0 && server.admission.input.used === 0);
  await a.sdk.reconnect();
  assert.deepEqual(a.sdk.snapshot(), local);
  assert.deepEqual(sent().slice(4), ["ulda:hello", "ulda:read"]);
  assert.equal(creates, 0);
  assert.deepEqual((await pool.query("SELECT id,witness,payload FROM public.ulda_resources ORDER BY id")).rows, before.rows);
  assert.equal(server.router.subscriptionTotal, 1);
});

test("ingress overflow returns unknown outcome without writing or replaying", async t => {
  const { server, client } = await setup(t, { MAX_INFLIGHT_BYTES: "16000" }), a = client();
  await a.sdk.register(password); await a.sdk.add(privateName, { n: 1 });
  const before = await pool.query("SELECT id,witness,payload FROM public.ulda_resources ORDER BY id");
  await assert.rejects(a.sdk.update(privateName, { text: "x".repeat(20000) }), { code: "UNKNOWN_OUTCOME" });
  assert.deepEqual((await pool.query("SELECT id,witness,payload FROM public.ulda_resources ORDER BY id")).rows, before.rows);
  // Reading the old version cannot prove that an unknown write will never finish.
  // The client must keep the ambiguity instead of reporting a resolved session.
  await assert.rejects(a.sdk.reconnect(), { code: "NEEDS_RESYNC" });
  assert.equal(a.sdk.value(privateName).n, 1);
  assert.equal(a.trace.filter(e => e.phase === "send" && e.event === "ulda:update").length, 2);
  assert.ok(server.admission.input.used <= 16000);
});

test("malformed last member of an SDK batch is rejected before any PostgreSQL mutation", async t => {
  const { server, client } = await setup(t), a = client();
  await a.sdk.register(password);
  let before;
  const create = server.storage.createBatch.bind(server.storage);
  server.storage.createBatch = async items => { const rows = await create(items); before = await pool.query("SELECT id,witness,payload FROM public.ulda_resources ORDER BY id"); return rows; };
  const socket = [...server.io.sockets.sockets.values()][0];
  socket.use((args, next) => { if (args[0] === "ulda:update") args[1].at(-1).privateName = "synthetic-forbidden-field"; next(); });
  await assert.rejects(a.sdk.add(privateName, { n: 1 }), { code: "SERVER_ERROR" });
  assert.deepEqual((await pool.query("SELECT id,witness,payload FROM public.ulda_resources ORDER BY id")).rows, before.rows);
});
