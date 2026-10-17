import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256, validateSdkIdentity } from './policy.mjs';

// No network publication. The workflow checks out this exact public SDK commit.
let phase = 'identity';
try {
  const expected = JSON.parse(fs.readFileSync('test/consumer-candidate.json'));
  validateSdkIdentity(expected);
  if (process.argv[2] === 'identity') {
    assert(process.env.GITHUB_OUTPUT);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `commit=${expected.commit}\n`);
  } else {
    assert.equal(process.argv.length, 2);
    // npm supplies the active CLI path on every platform. A path guessed from
    // process.execPath works on Windows but points into bin/node_modules on Linux.
    const npm = process.env.npm_execpath;
    assert(npm && fs.existsSync(npm), 'Invoke through npm run ci:sdk-candidate');
    const root = path.resolve('.local/sdk-source');
    const run = (file, args) => execFileSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert.equal(run('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'rev-parse', 'HEAD']), expected.commit);
    assert.equal(run('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'status', '--porcelain']), '');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    assert.equal(pkg.name, expected.name); assert.equal(pkg.version, expected.version);
    phase = 'dependency-install';
    run(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-fund']);
    phase = 'bundle-build';
    run(process.execPath, [npm, 'run', 'build']);
    const out = path.resolve('.local/sdk-candidate'); fs.mkdirSync(out, { recursive: true });
    phase = 'archive-create';
    const packed = JSON.parse(run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', out]));
    assert.equal(packed.length, 1);
    const filename = `${expected.name}-${expected.version}.tgz`; assert.equal(packed[0].filename, filename);
    const archive = path.join(out, filename);
    phase = 'archive-verify';
    assert.equal(await sha256(archive), expected.sha256, 'Candidate archive differs from reviewed package');
    assert(process.env.GITHUB_ENV);
    fs.appendFileSync(process.env.GITHUB_ENV, `ULDA_TEST_SDK_TARBALL=${archive}\n`);
    console.log(`PASS candidate ${expected.name}@${expected.version}; SHA-256 ${expected.sha256}`);
  }
} catch { console.error(`SDK candidate failed at ${phase}; private diagnostics suppressed.`); process.exitCode = 1; }
