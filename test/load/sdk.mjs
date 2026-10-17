// Capacity tests may use an explicitly installed local candidate. Ordinary
// integration tests continue to import the pinned published consumer directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let sdk;
if (process.env.ULDA_CAPACITY_SDK_ROOT) {
  const root = fs.realpathSync(process.env.ULDA_CAPACITY_SDK_ROOT);
  const packageRoot = fs.realpathSync(path.join(root, 'node_modules', 'ulda-auth'));
  assert.equal(packageRoot, path.join(root, 'node_modules', 'ulda-auth'));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
  assert.equal(manifest.name, 'ulda-auth');
  // This package exposes an ESM import condition, not a CommonJS require entry.
  const exported = manifest.exports['.'].import;
  assert(typeof exported === 'string' && exported.startsWith('./'));
  const entry = fs.realpathSync(path.join(packageRoot, exported));
  assert(entry.startsWith(packageRoot + path.sep));
  sdk = await import(pathToFileURL(entry).href);
} else sdk = await import('../consumer/index.mjs');
export const { Ulda, SocketIoTransport } = sdk;
