import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Download only pinned public release assets. No curl-to-shell or npm install hooks.
const pins = JSON.parse(await fs.readFile(new URL('./tools.json', import.meta.url)));
assert.equal(process.arch, 'x64');
const folder = path.resolve('.local/ci-tools');
await fs.mkdir(folder, { recursive: true });
for (const name of process.argv.slice(2)) {
  const tool = pins[name], asset = tool?.[process.platform];
  assert(asset, 'Unsupported tool/platform');
  const response = await fetch(`https://github.com/${tool.repository}/releases/download/v${tool.version}/${asset.asset}`, { signal: AbortSignal.timeout(180000) });
  assert(response.ok, 'Tool download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, 'Tool archive checksum mismatch');
  const archive = path.join(folder, asset.asset);
  await fs.writeFile(archive, bytes);
  execFileSync('tar', ['-xf', archive, '-C', folder, name + (process.platform === 'win32' ? '.exe' : '')], { windowsHide: true });
  await fs.unlink(archive);
  console.log(`Verified ${name} ${tool.version}`);
}
if (process.env.GITHUB_PATH) await fs.appendFile(process.env.GITHUB_PATH, folder + '\n');
