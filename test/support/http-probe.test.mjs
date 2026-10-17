import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { httpReady } from './http-probe.mjs';

test('readiness deadline keeps a child process alive until an otherwise unreferenced probe completes', () => {
  const source = `
    import { httpReady } from ${JSON.stringify(new URL('./http-probe.mjs', import.meta.url).href)};
    const request = () => new Promise(resolve => {
      setTimeout(() => resolve({status:200,arrayBuffer:async()=>new ArrayBuffer(0)}),50).unref();
    });
    if (!await httpReady('http://127.0.0.1', 5000, request)) process.exitCode=1;
    else process.stdout.write('finished');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'finished');
});
test('a stuck readiness probe is aborted and non-ready status is rejected', async () => {
  await assert.rejects(httpReady('http://127.0.0.1', 10, (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
  })));
  assert.equal(await httpReady('http://127.0.0.1', 1000, async () => ({ status: 503, arrayBuffer: async () => new ArrayBuffer(0) })), false);
});
