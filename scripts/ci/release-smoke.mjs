import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { externalPostgresImage, imageContentIdentity, validateManifest } from './policy.mjs';

// A disposable operator-owned database lives outside the application Compose
// project. No registry credentials or production volumes are used here.
const mode = process.argv[2];
assert(process.argv.length === 2 || (process.argv.length === 3 && ['--local', '--candidate'].includes(mode)));
const local = !!mode, candidate = mode === '--candidate';
const receiptFile = candidate ? '.local/ci-smoke-candidate.json' : local ? '.local/ci-smoke-local.json' : '.local/ci-published.json';
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${process.cwd().replaceAll('\\', '/')}`, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const commit = git('rev-parse', 'HEAD');
let receipt;
if (local) {
  const build = JSON.parse(fs.readFileSync(candidate ? '.local/ci-build.json' : '.local/ci-images/manifest.json'));
  assert.equal(build.commit, commit);
  if (!candidate) validateManifest(build, commit);
  receipt = { schema: 2, localRehearsal: true, commit, version: build.version,
    images: { server: { reference: build.images.server.id, contentIdentity: build.images.server.contentIdentity } },
    externalDatabase: build.externalDatabase };
} else {
  receipt = JSON.parse(fs.readFileSync(receiptFile));
  assert.equal(receipt.commit, commit);
}
assert.deepEqual(Object.keys(receipt.images), ['server']);
assert.equal(receipt.externalDatabase.reference, externalPostgresImage);
assert.match(receipt.externalDatabase.contentIdentity, /^[a-f0-9]{64}$/);
const id = randomUUID().replaceAll('-', ''), network = `ulda-release-${id}`, project = `${network}-app`;
const db = `${network}-db`, label = `io.ulda.release-smoke=${id}`;
const folder = path.resolve('.local', network), secretDir = path.join(folder, 'secrets');
fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') assert.equal(fs.statSync(secretDir).mode & 0o777, 0o700);
const passwords = Object.fromEntries(['admin', 'migration', 'runtime'].map(role => [role, randomUUID()]));
const secretPaths = Object.keys(passwords).map(role => path.join(secretDir, `postgres_${role}_password`));
// Disposable file secrets must be readable by the non-root container user.
for (const [i, role] of Object.keys(passwords).entries()) fs.writeFileSync(secretPaths[i], passwords[role], { flag: 'wx', mode: 0o644 });
const env = { ...process.env, POSTGRES_USER: 'ulda_test', POSTGRES_DB: 'ulda_test', POSTGRES_PASSWORD: passwords.admin,
  PGHOST: 'postgres', PGPORT: '5432', PGDATABASE: 'ulda_test', ULDA_DB_ADMIN_USER: 'ulda_test',
  ULDA_DATABASE_NETWORK: network, ULDA_SECRETS_DIR: secretDir, ULDA_SERVER_IMAGE: receipt.images.server.reference,
  ULDA_PUBLISH_ADDRESS: '127.0.0.1', ULDA_SERVER_PORT: '0', CORS_ORIGINS: 'http://localhost:3000',
  ULDA_TEST_ALLOW_RESET: '1', ULDA_SMOKE_STATE_FILE: path.join(folder, 'state.json') };
for (const key of ['DOCKERHUB_TOKEN', 'DATABASE_URL', 'PGPASSWORD', 'PGPASSWORD_FILE', 'PGSERVICE', 'ULDA_SDK_CONSUMER']) delete env[key];
const run = (file, args) => execFileSync(file, args, { env, encoding: 'utf8', timeout: 180000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const docker = (...args) => run('docker', args);
const emptyEnv = path.join(folder, 'empty.env'); fs.writeFileSync(emptyEnv, '', { flag: 'wx' });
const compose = (...args) => docker('compose', '--env-file', emptyEnv, '-p', project, '-f', 'deploy/compose.external-db.yaml', ...args);
const until = async fn => {
  const end = Date.now() + 60000;
  do { try { if (await fn()) return; } catch {} await new Promise(r => setTimeout(r, 500)); } while (Date.now() < end);
  throw new Error('Smoke readiness deadline');
};
let created = false, composeStarted = false, phase = 'prepare';
try {
  assert.match(receipt.images.server.reference, local ? /^sha256:[a-f0-9]{64}$/ : /@sha256:[a-f0-9]{64}$/);
  const appIdentity = imageContentIdentity(JSON.parse(docker('image', 'inspect', receipt.images.server.reference))[0]);
  if (candidate) receipt.images.server.contentIdentity = appIdentity;
  else assert.equal(appIdentity, receipt.images.server.contentIdentity);
  if (!local) docker('pull', '--platform', 'linux/amd64', externalPostgresImage);
  assert.equal(imageContentIdentity(JSON.parse(docker('image', 'inspect', externalPostgresImage))[0]), receipt.externalDatabase.contentIdentity);
  phase = 'compose-config';
  const resolved = JSON.parse(compose('--profile', 'admin', 'config', '--format', 'json'));
  assert.deepEqual(Object.keys(resolved.services).sort(), ['db-setup', 'migrate', 'server']);
  for (const service of Object.values(resolved.services)) {
    assert.equal(service.image, receipt.images.server.reference);
    assert.equal(service.build, undefined);
  }
  phase = 'external-startup';
  docker('network', 'create', '--label', label, network); created = true;
  docker('run', '-d', '--name', db, '--label', label, '--network', network, '--network-alias', 'postgres',
    '--mount', 'type=volume,destination=/var/lib/postgresql', '--security-opt', 'no-new-privileges:true',
    '-e', 'POSTGRES_USER', '-e', 'POSTGRES_DB', '-e', 'POSTGRES_PASSWORD', externalPostgresImage);
  await until(() => docker('exec', db, 'psql', '-U', 'ulda_test', '-d', 'ulda_test', '-At', '-c', 'SELECT 1') === '1');
  phase = 'roles-and-migrations'; composeStarted = true;
  compose('run', '--rm', '--no-deps', '-e', 'ULDA_DB_SETUP=1', 'db-setup');
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '90');
  const app = compose('ps', '-q', 'server');
  const ports = JSON.parse(docker('inspect', app, '--format', '{{json .NetworkSettings.Ports}}'));
  env.ULDA_SERVER_URL = `http://127.0.0.1:${ports['3000/tcp'][0].HostPort}`;
  await until(async () => { const r = await fetch(env.ULDA_SERVER_URL + '/ready', { signal: AbortSignal.timeout(3000) }); await r.arrayBuffer(); return r.ok; });
  assert.equal(docker('exec', db, 'psql', '-U', 'ulda_test', '-d', 'ulda_test', '-At', '-c', "SELECT rolsuper FROM pg_roles WHERE rolname='ulda_runtime'"), 'f');
  const runtimeSecrets = JSON.parse(docker('inspect', app))[0].Mounts.map(m => m.Destination);
  assert.deepEqual(runtimeSecrets, ['/run/secrets/db_password']);
  phase = 'published-sdk';
  for (const action of ['prepare', 'check', 'cleanup']) run(process.execPath, ['scripts/container-sdk-smoke.mjs', action]);
  assert.equal(docker('exec', db, 'psql', '-U', 'ulda_test', '-d', 'ulda_test', '-At', '-c', 'SELECT count(*) FROM public.ulda_resources'), '0');
  receipt.smoke = 'PASS';
  console.log('PASS application-only Compose, external PostgreSQL, restricted runtime role and published SDK.');
} catch {
  receipt.smoke = 'FAIL'; process.exitCode = 1;
  console.error(`FAIL external database smoke ${phase}; private diagnostics suppressed.${local ? '' : ' Server may already be public; do not overwrite the version.'}`);
} finally {
  try {
    if (composeStarted) compose('down', '--remove-orphans', '--timeout', '15');
    if (created) {
      const containers = docker('ps', '-aq', '--filter', `label=${label}`).split(/\s+/).filter(Boolean);
      for (const container of containers) {
        assert.equal(docker('inspect', container, '--format', '{{index .Config.Labels "io.ulda.release-smoke"}}'), id);
        docker('rm', '-f', '-v', container);
      }
      assert.equal(JSON.parse(docker('network', 'inspect', network))[0].Labels['io.ulda.release-smoke'], id);
      docker('network', 'rm', network);
    }
    for (const file of [...secretPaths, env.ULDA_SMOKE_STATE_FILE]) {
      assert(path.resolve(file).startsWith(folder + path.sep));
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    receipt.cleanup = 'PASS';
  } catch { receipt.cleanup = 'FAIL'; receipt.smoke = 'FAIL'; process.exitCode = 1; console.error('FAIL external database smoke cleanup'); }
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
}
