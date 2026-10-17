import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], { encoding: 'utf8', windowsHide: true });
const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))];
const folders = new Set(['src', 'test', 'scripts', 'docs', 'deploy', 'migrations', '.github']);
const top = new Set(['.dockerignore', '.gitignore', '.gitattributes', '.env.example', 'compose.yaml',
  'Dockerfile', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
  'vitest.config.ts', 'vitest.postgres.config.ts', 'LICENSE.md', 'MANIFEST.md', 'README.md',
  'SECURITY.md', 'SERVER_SPEC.md', 'SERVER_WALKTHROUGH.md', 'THIRD_PARTY_NOTICES.md']);
const output = path.resolve('.local/publication-tree');
fs.mkdirSync(output, { recursive: true });
assert.equal(fs.realpathSync(output), output, 'Publication tree must not be a link');
let links = 0;
for (const file of files) {
  assert(top.has(file) || folders.has(file.split('/')[0]), `Unexpected publication path: ${file}`);
  assert(!/(?:^|\/)(?:node_modules|dist|secrets|backups|\.local|\.env|\.npmrc)(?:\/|$)|\.(?:pem|key|p12|pfx|dump|backup|zip|tgz|tar|exe|dll|db|log)$/i.test(file), `Private/binary path: ${file}`);
  const source = path.resolve(file);
  assert(source.startsWith(root + path.sep));
  assert(fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink(), `Non-regular publication file: ${file}`);
  const bytes = fs.readFileSync(source);
  assert(!bytes.includes(0), `Binary publication content: ${file}`);
  const text = bytes.toString('utf8');
  assert(!/[A-Z]:[\\/](?:Users|ulda-project|ObsidianVault)[\\/]/i.test(text), `Workstation path: ${file}`);
  if (file.endsWith('.md')) {
    for (const match of text.matchAll(/\]\((<?[^\n)]+>?)\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
      assert(fs.existsSync(path.resolve(path.dirname(source), decodeURIComponent(target))), `Broken relative link: ${file}`);
      links++;
    }
  }
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
// Reject local file/link dependency bindings; lockfile registry URLs must be public npm.
for (const file of ['package-lock.json', 'test/consumer/package-lock.json']) {
  for (const entry of Object.values(JSON.parse(fs.readFileSync(file)).packages)) {
    assert(!entry.link, 'Linked dependency in release');
    if (entry.resolved) assert(entry.resolved.startsWith('https://registry.npmjs.org/'), 'Non-registry dependency');
  }
}
console.log(`PASS publication paths, text files, dependency sources and ${links} relative links; ${files.length} files.`);
