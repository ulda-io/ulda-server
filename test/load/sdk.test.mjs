import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const escaped of [false, true]) test(`capacity candidate ESM export ${escaped ? 'rejects escape' : 'supports import-only packages'}`, () => {
  const local = path.join(root, '.local'); fs.mkdirSync(local, { recursive: true });
  const folder = fs.mkdtempSync(path.join(local, 'candidate-loader-'));
  const pkg = path.join(folder, 'node_modules/ulda-auth'); fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ulda-auth', type: 'module', exports: { '.': { import: escaped ? './../outside.mjs' : './src/index.js' } } }));
  fs.writeFileSync(path.join(pkg, 'src/index.js'), 'export class Ulda {}\nexport class SocketIoTransport {}\n');
  fs.writeFileSync(path.join(pkg, '../outside.mjs'), "import fs from 'node:fs';fs.writeFileSync(new URL('./unexpected-entry-ran',import.meta.url),'ran');export class Ulda {} export class SocketIoTransport {}\n");
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "const m=await import('./test/load/sdk.mjs');if(typeof m.Ulda!=='function'||typeof m.SocketIoTransport!=='function')process.exit(2)"],
      { cwd: root, env: { ...process.env, ULDA_CAPACITY_SDK_ROOT: folder }, encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: 'pipe' });
    assert.equal(result.status, escaped ? 1 : 0);
    assert.equal(fs.existsSync(path.join(pkg, '../unexpected-entry-ran')), false);
  } finally {
    const resolved = fs.realpathSync(folder);
    assert.equal(path.dirname(resolved), fs.realpathSync(local));
    assert(path.basename(resolved).startsWith('candidate-loader-'));
    fs.rmSync(resolved, { recursive: true });
  }
});
