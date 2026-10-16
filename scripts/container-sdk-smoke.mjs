import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { Ulda, SocketIoTransport } from "../test/consumer/index.mjs";
import { readRecords } from "../test/support/read-records.mjs";

const url = process.env.ULDA_SERVER_URL, stateFile = process.env.ULDA_SMOKE_STATE_FILE;
const phase = process.argv[2], clients = [];
const password = "synthetic-container-smoke-passphrase";
const fingerprint = records => createHash("sha256").update(Buffer.concat(records.flatMap(r => [Buffer.from(r.witness), Buffer.from(r.payload)]))).digest("hex");
async function until(check) { const end = Date.now() + 10000; do { if (check()) return; await new Promise(r => setTimeout(r, 10)); } while (Date.now() < end); assert.fail("Expected peer state was not reached"); }
function client() { const transport = new SocketIoTransport(url, { allowInsecureLocalhost: true }), ulda = new Ulda(url, { transport, reconnect: false }); clients.push(ulda); return { ulda, transport }; }
async function main() {
  assert.ok(url && stateFile && process.env.ULDA_TEST_ALLOW_RESET === "1" && ["prepare", "check", "cleanup"].includes(phase), "Set explicit disposable smoke configuration.");
  const { ulda, transport } = client();
  if (phase === "prepare") {
    const ids = [], trace = []; transport.on("trace", event => { trace.push(event); if (event.phase === "ack" && event.event === "ulda:create") ids.push(...event.ids); });
    const id = await ulda.register(password);
    await ulda.add("container-check-X", { n: 1, text: "synthetic container integration" }, "X");
    await ulda.add("container-check-S", { n: 1, text: "synthetic container integration" }, "S");
    const peer = client().ulda; await peer.connect(id, password);
    const offset = trace.length;
    for (const mode of ["X", "S"]) { await ulda.update("container-check-" + mode, { n: 42, text: "synthetic container integration" }); await until(() => peer.value("container-check-" + mode).n === 42); }
    assert.equal(trace.slice(offset).some(event => event.phase === "push"), false);
    const read = await readRecords(url, ids); assert.equal(read.ok, true);
    await writeFile(stateFile, JSON.stringify({ id, ids, fingerprint: fingerprint(read.data) }), { flag: "wx" });
  } else {
    const saved = JSON.parse(await readFile(stateFile, "utf8")); await ulda.connect(saved.id, password);
    for (const mode of ["X", "S"]) assert.equal(ulda.value("container-check-" + mode).n, 42);
    const read = await readRecords(url, saved.ids); assert.equal(read.ok, true);
    assert.equal(fingerprint(read.data), saved.fingerprint);
    if (phase === "cleanup") { await ulda.superDelete(); assert.deepEqual(await readRecords(url, saved.ids), { ok: false, error: "not_found" }); await unlink(stateFile); }
  }
  console.log("PASS: published SDK container smoke / " + phase);
}
try { await main(); }
catch { process.exitCode = 1; console.error("Container SDK smoke failed; private diagnostics suppressed."); }
finally { for (const ulda of clients) await ulda.close(); }
