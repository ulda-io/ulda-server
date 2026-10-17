import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deliverResult } from './result-delivery.mjs';

if (process.argv[2] === '--report-child') {
  const bins = Array.from({ length: 60_001 }, (_, i) => i);
  await deliverResult(process, { kind: 'result', latency: { bins }, ack: { bins } });
  process.disconnect();
} else {
  test('large worker report is received completely and worker stays alive until parent acknowledges', { timeout: 15_000 }, async t => {
    const child = fork(fileURLToPath(import.meta.url), ['--report-child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const closed = once(child, 'close');
    const [report] = await once(child, 'message');
    assert.equal(report.kind, 'result');
    for (const field of ['latency', 'ack']) {
      assert.equal(report[field].bins.length, 60_001);
      assert.equal(report[field].bins[60_000], 60_000);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null);
    child.send({ action: 'result-received' });
    assert.deepEqual(await closed, [0, null]);
  });

  test('missing parent confirmation or IPC disconnect fails closed and releases listeners', async () => {
    const channel = new EventEmitter(); channel.connected = true;
    channel.send = (_report, callback) => callback(null);
    await assert.rejects(deliverResult(channel, { kind: 'result' }, 10), { code: 'TIMEOUT' });
    assert.equal(channel.listenerCount('message'), 0); assert.equal(channel.listenerCount('disconnect'), 0);
    const pending = deliverResult(channel, { kind: 'result' }); channel.emit('disconnect');
    await assert.rejects(pending, { code: 'TIMEOUT' });
    assert.equal(channel.listenerCount('message'), 0); assert.equal(channel.listenerCount('disconnect'), 0);
  });
}
