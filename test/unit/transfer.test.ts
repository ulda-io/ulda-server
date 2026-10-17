import { afterEach, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createUldaServer, type UldaServer } from '../../src/app/create-server.js';
import { loadConfig } from '../../src/config/config.js';
import { InMemoryResourceStorage } from '../../src/storage/in-memory-resource-storage.js';
import { sdkParser } from '../../src/transports/socketio/sdk-parser.js';
import type { AppConfig } from '../../src/config/config.js';

let server: UldaServer | undefined;
const sockets: Socket[] = [];
const storage = () => new InMemoryResourceStorage();
const witness = (n: number) => Uint8Array.of(n);
const ack = (socket: Socket, body: unknown) => socket.timeout(10000).emitWithAck('ulda:transfer', body);
async function setup(patch: Partial<AppConfig['limits']> = {}, count = 1) {
  const db = storage(), config = loadConfig({ LOG_LEVEL: 'error' });
  config.host = '127.0.0.1'; config.port = 0; Object.assign(config.limits, patch);
  const records = await db.createBatch(Array.from({ length: count }, () => ({ witness: witness(1), payload: Uint8Array.of(7) })));
  server = createUldaServer({ config, storage: db, ulda: { verify: async (a, b) => a[0]! + 1 === b[0] } });
  const address = await server.start();
  const connect = async (extended = true) => {
    const socket = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false,
      forceNew: true, parser: sdkParser, auth: extended ? { uldaTransfer: 1 } : {} });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  };
  return { db, records, connect, socket: await connect() };
}
async function stage(socket: Socket, items: unknown[], action = 'delete') {
  const begun = await ack(socket, { kind: 'begin', action, count: items.length });
  expect(begun.ok).toBe(true);
  for (let i = 0; i < items.length; i += 64) expect(await ack(socket, { kind: 'append', token: begun.token, items: items.slice(i, i + 64) })).toEqual({ ok: true });
  return begun.token as string;
}
afterEach(async () => { for (const socket of sockets.splice(0)) socket.disconnect(); await server?.close(); server = undefined; });

it('stages 10001 deletions without changing storage, then commits once and chunks Changed', async () => {
  const { db, records, socket, connect } = await setup({}, 10001);
  const peer = await connect(), seen: any[] = [], echoed: unknown[] = [];
  socket.on('ulda:changed.part', x => echoed.push(x));
  peer.on('ulda:changed.part', x => seen.push(x));
  for (let i = 0; i < records.length; i += 64) expect((await peer.timeout(10000).emitWithAck('ulda:read', records.slice(i, i + 64).map(x => String(x.id)))).ok).toBe(true);
  const items = records.map(x => ({ id: String(x.id), witness: witness(2) }));
  const token = await stage(socket, items);
  expect((await db.findManyByIds(records.map(x => x.id))).filter(Boolean)).toHaveLength(10001);
  expect(seen).toHaveLength(0);
  const ended = new Promise<void>(resolve => peer.on('ulda:changed.part', x => { if (x.kind === 'end') resolve(); }));
  expect(await ack(socket, { kind: 'commit', token })).toEqual({ ok: true }); await ended;
  expect((await db.findManyByIds(records.map(x => x.id))).filter(Boolean)).toHaveLength(0);
  expect(seen[0]).toEqual({ kind: 'begin', count: 10001 });
  expect(seen.filter(x => x.kind === 'append').every(x => x.items.length <= 64)).toBe(true);
  expect(seen.filter(x => x.kind === 'append').reduce((n, x) => n + x.items.length, 0)).toBe(10001);
  expect(echoed).toHaveLength(0);
  expect(server!.admission.snapshot().stagedBytes).toBe(0);
}, 30000);

it('a conflict in the final validation chunk leaves every record intact and frees staging', async () => {
  const { db, records, socket } = await setup({}, 130);
  const items = records.map((x, i) => ({ id: String(x.id), witness: witness(i === 129 ? 99 : 2) }));
  const token = await stage(socket, items);
  expect(await ack(socket, { kind: 'commit', token })).toEqual({ ok: false, error: 'conflict' });
  expect((await db.findManyByIds(records.map(x => x.id))).filter(Boolean)).toHaveLength(130);
  expect(server!.admission.snapshot().stagedBytes).toBe(0);
  expect(server!.admission.snapshot().readBytes).toBe(0);
});

it('large opaque resources are reconstructed before commit and read from a consistent bounded snapshot', async () => {
  const { db, records, socket } = await setup();
  const id = String(records[0]!.id), payload = new Uint8Array(2_100_000).fill(19);
  const begun = await ack(socket, { kind: 'begin', action: 'update', count: 1 });
  for (let offset = 0; offset < payload.length; offset += 1_048_576) {
    expect(await ack(socket, { kind: 'part', token: begun.token, resourceId: id, witness: witness(2),
      total: payload.length, offset, payload: payload.subarray(offset, offset + 1_048_576) })).toEqual({ ok: true });
    expect((await db.findById(BigInt(id)))!.payload).toEqual(Uint8Array.of(7));
  }
  expect(await ack(socket, { kind: 'commit', token: begun.token })).toEqual({ ok: true });
  const first = await ack(socket, { kind: 'read', resourceId: id, offset: 0 });
  expect(first.data.payload.length).toBe(1_048_576);
  // Simulate a later committed version after the first fragment was delivered.
  await db.applyBatch([{ id: BigInt(id), witness: witness(3), payload: Uint8Array.of(9) }]);
  const chunks = [first.data.payload];
  for (let offset = first.data.payload.length; offset < payload.length;) {
    const part = await ack(socket, { kind: 'read', resourceId: id, offset });
    expect(part.data.total).toBe(payload.length); expect([...part.data.witness]).toEqual([2]);
    chunks.push(part.data.payload); offset += part.data.payload.length;
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(payload));
  expect(server!.admission.snapshot().readBytes).toBe(0);
  expect(server!.admission.snapshot().stagedBytes).toBe(0);
});

it('rejects duplicates and out-of-order fragments without any write', async () => {
  const { socket, db } = await setup();
  let begun = await ack(socket, { kind: 'begin', action: 'delete', count: 2 });
  expect((await ack(socket, { kind: 'append', token: begun.token, items: [{ id: '1', witness: witness(2) }, { id: '1', witness: witness(2) }] })).ok).toBe(false);
  expect(server!.admission.snapshot().stagedBytes).toBe(0);
  begun = await ack(socket, { kind: 'begin', action: 'update', count: 1 });
  expect((await ack(socket, { kind: 'part', token: begun.token, resourceId: '1', witness: witness(2), total: 2000000, offset: 1, payload: Uint8Array.of(1) })).ok).toBe(false);
  expect(server!.admission.snapshot().stagedBytes).toBe(0);
  expect((await db.findById(1n))!.witness).toEqual(witness(1));
});

it('disconnect releases uncommitted staging; a different socket cannot commit its token', async () => {
  const { socket, connect, db } = await setup();
  const token = await stage(socket, [{ id: '1', witness: witness(2) }]);
  const peer = await connect();
  expect((await ack(peer, { kind: 'commit', token })).ok).toBe(false);
  const closed = new Promise<void>(resolve => server!.io.sockets.sockets.get(socket.id!)!.once('disconnect', () => resolve()));
  socket.disconnect(); await closed;
  expect(server!.admission.snapshot().stagedBytes).toBe(0);
  expect(await db.findById(1n)).not.toBeNull();
});

it('rejects staging over the shared byte budget and releases the reservation', async () => {
  const { socket } = await setup({ maxStagedBytes: 1024 });
  const begun = await ack(socket, { kind: 'begin', action: 'update', count: 1 });
  expect(await ack(socket, { kind: 'part', token: begun.token, resourceId: '1', witness: witness(2), total: 2000000, offset: 0, payload: Uint8Array.of(1) })).toEqual({ ok: false, error: 'too_large' });
  expect(server!.admission.snapshot().stagedBytes).toBe(0);
});

it('expires abandoned staging without writes and rejects a late commit', async () => {
  const { socket, db } = await setup({ transferTimeoutMs: 100 });
  const begun = await ack(socket, { kind: 'begin', action: 'delete', count: 1 });
  await vi.waitFor(() => expect(server!.admission.snapshot().stagedBytes).toBe(0));
  expect((await ack(socket, { kind: 'commit', token: begun.token })).ok).toBe(false);
  expect(await db.findById(1n)).not.toBeNull();
});

it('rejects an incomplete commit and releases staging without deleting any record', async () => {
  const { socket, db } = await setup({}, 2);
  const begun = await ack(socket, { kind: 'begin', action: 'delete', count: 2 });
  expect(await ack(socket, { kind: 'append', token: begun.token, items: [{ id: '1', witness: witness(2) }] })).toEqual({ ok: true });
  expect((await ack(socket, { kind: 'commit', token: begun.token })).ok).toBe(false);
  expect((await db.findManyByIds([1n, 2n])).filter(Boolean)).toHaveLength(2);
  expect(server!.admission.snapshot().stagedBytes).toBe(0);
});

it('checks staged candidates against current state at commit; a losing writer changes nothing', async () => {
  const { socket, connect, records, db } = await setup({}, 130), peer = await connect();
  const changes = records.map(x => ({ id: String(x.id), witness: witness(2), payload: Uint8Array.of(12) }));
  const first = await stage(socket, changes, 'update');
  const second = await stage(peer, changes.map(x => ({ ...x, payload: Uint8Array.of(13) })), 'update');
  expect(await ack(socket, { kind: 'commit', token: first })).toEqual({ ok: true });
  expect(await ack(peer, { kind: 'commit', token: second })).toEqual({ ok: false, error: 'conflict' });
  expect((await db.findManyByIds(records.map(x => x.id))).every(x => x?.payload[0] === 12)).toBe(true);
  expect(server!.admission.snapshot().stagedBytes).toBe(0);
});

it('closes an uncertain storage commit without claiming rollback and releases reservations', async () => {
  const { socket, db } = await setup();
  const apply = db.applyBatch.bind(db);
  db.applyBatch = async changes => { await apply(changes); throw new Error('synthetic storage completion failure'); };
  const token = await stage(socket, [{ id: '1', witness: witness(2) }]);
  const closed = new Promise<void>(resolve => socket.once('disconnect', () => resolve()));
  const reply = ack(socket, { kind: 'commit', token });
  await expect(reply).rejects.toThrow(); await closed;
  expect(await db.findById(1n)).toBeNull();
  await vi.waitFor(() => {
    const usage = server!.admission.snapshot();
    expect(usage.stagedBytes).toBe(0); expect(usage.readBytes).toBe(0); expect(usage.pending).toBe(0);
  });
});
