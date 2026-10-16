import assert from "node:assert/strict";
import { io } from "socket.io-client";
import UldaSign from "ulda-core";
import { sdkParser } from "../dist/transports/socketio/sdk-parser.js";

const socket = io(process.env.ULDA_SERVER_URL ?? "http://127.0.0.1:3000",
  { transports: ["websocket"], reconnection: false, parser: sdkParser });
const core = new UldaSign({ fmt: { export: "bytes" }, sign: { mode: "X", N: 5, originSize: 256 } });
const command = (action, body) => socket.timeout(5000).emitWithAck("ulda:" + action, body);
try {
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  assert.deepEqual(await command("hello", {}), { ok: true });
  let origin = core.New();
  const initial = await core.sign(origin);
  const created = await command("create", [{ witness: initial, payload: Uint8Array.of(1) }]);
  assert.equal(created.ok, true);
  const [id] = created.data;
  origin = core.stepUp(origin);
  const witness = await core.sign(origin);
  assert.deepEqual(await command("update", [{ id, witness, payload: Uint8Array.of(2) }]), { ok: true });
  const read = await command("read", [id]);
  assert.equal(read.ok, true);
  assert.deepEqual([...read.data[0].witness], [...witness]);
  assert.deepEqual([...read.data[0].payload], [2]);
  assert.deepEqual(await command("delete", [{ id, witness: await core.sign(core.stepUp(origin)) }]), { ok: true });
  assert.deepEqual(await command("read", [id]), { ok: false, error: "not_found" });
  console.log("PASS: binary hello/create/update/read/delete with directed real core.");
} finally { socket.close(); }
