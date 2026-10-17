import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { imageContentIdentity } from './policy.mjs';

// A new DB and SDK state, after all registry credentials have been removed.
const local = process.argv[2] === '--local';
assert(process.argv.length === 2 || local, 'Unknown smoke option');
const receiptFile = local ? '.local/ci-smoke-local.json' : '.local/ci-published.json';
const manifest = local ? JSON.parse(fs.readFileSync('.local/ci-images/manifest.json')) : undefined;
const receipt = local ? { localRehearsal: true, version: manifest.version,
  images: Object.fromEntries(Object.entries(manifest.images).map(([name, item]) => [name, { reference: item.id, contentIdentity: item.contentIdentity }])) }
  : JSON.parse(fs.readFileSync(receiptFile));
const id = randomUUID().replaceAll('-', ''), network = `ulda-release-${id}`;
const db = `${network}-db`, app = `${network}-app`, label = `io.ulda.release-smoke=${id}`;
const folder = path.resolve('.local', network);
fs.mkdirSync(folder, { recursive: true });
const env = { ...process.env, POSTGRES_USER: 'ulda_test', POSTGRES_DB: 'ulda_test', POSTGRES_PASSWORD: randomUUID(),
  PGHOST: 'postgres', PGPORT: '5432', PGUSER: 'ulda_test', PGDATABASE: 'ulda_test', ULDA_TEST_ALLOW_RESET: '1', ULDA_SMOKE_STATE_FILE: path.join(folder, 'state.json') };
env.PGPASSWORD = env.POSTGRES_PASSWORD;
delete env.DOCKERHUB_TOKEN; delete env.DATABASE_URL; delete env.PGPASSWORD_FILE; delete env.ULDA_SDK_CONSUMER;
const run = (file, args) => execFileSync(file, args, { env, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const docker = (...args) => run('docker', args);
const until = async fn => {
  const end = Date.now() + 60000;
  do { try { if (await fn()) return; } catch {} await new Promise(r => setTimeout(r, 500)); } while (Date.now() < end);
  throw new Error('Smoke readiness deadline');
};
let created = false, phase = 'prepare';
try {
  for (const name of ['server', 'postgres', 'proxy']) {
    assert.match(receipt.images[name].reference, local ? /^sha256:[a-f0-9]{64}$/ : /@sha256:[a-f0-9]{64}$/);
    assert.equal(imageContentIdentity(JSON.parse(docker('image', 'inspect', receipt.images[name].reference))[0]), receipt.images[name].contentIdentity);
  }
  docker('network', 'create', '--label', label, network); created = true;
  docker('run', '-d', '--name', db, '--label', label, '--network', network, '--network-alias', 'postgres',
    '--mount', 'type=volume,destination=/var/lib/postgresql', '--security-opt', 'no-new-privileges:true',
    '-e', 'POSTGRES_USER', '-e', 'POSTGRES_DB', '-e', 'POSTGRES_PASSWORD', receipt.images.postgres.reference);
  await until(() => docker('exec', db, 'psql', '-U', 'ulda_test', '-d', 'ulda_test', '-At', '-c', 'SELECT 1') === '1');
  phase = 'migrate';
  const flags = ['--label', label, '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGDATABASE', '-e', 'PGPASSWORD'];
  docker('run', '--rm', ...flags, receipt.images.server.reference, 'node', 'dist/cli/migrate-postgres.js');
  docker('run', '-d', '--init', '--name', app, ...flags, '-p', '127.0.0.1::3000', receipt.images.server.reference);
  const ports = JSON.parse(docker('inspect', app, '--format', '{{json .NetworkSettings.Ports}}'));
  env.ULDA_SERVER_URL = `http://127.0.0.1:${ports['3000/tcp'][0].HostPort}`;
  await until(async () => { const r = await fetch(env.ULDA_SERVER_URL + '/ready', { signal: AbortSignal.timeout(3000) }); await r.arrayBuffer(); return r.ok; });
  phase = 'sdk';
  for (const action of ['prepare', 'check', 'cleanup']) run(process.execPath, ['scripts/container-sdk-smoke.mjs', action]);
  assert.equal(docker('exec', db, 'psql', '-U', 'ulda_test', '-d', 'ulda_test', '-At', '-c', 'SELECT count(*) FROM public.ulda_resources'), '0');
  receipt.smoke = 'PASS';
  console.log(local ? 'PASS local release-smoke rehearsal with published SDK.' : 'PASS freshly pulled server and PostgreSQL with published SDK.');
} catch {
  receipt.smoke = 'FAIL'; process.exitCode = 1;
  console.error(`FAIL release smoke ${phase}; images may already be public. Do not overwrite the version.`);
} finally {
  try {
    if (created) {
      const containers = docker('ps', '-aq', '--filter', `label=${label}`).split(/\s+/).filter(Boolean);
      for (const container of containers) {
        assert.equal(docker('inspect', container, '--format', '{{index .Config.Labels "io.ulda.release-smoke"}}'), id);
        docker('rm', '-f', '-v', container);
      }
      assert.equal(JSON.parse(docker('network', 'inspect', network))[0].Labels['io.ulda.release-smoke'], id);
      docker('network', 'rm', network);
    }
    const state = env.ULDA_SMOKE_STATE_FILE;
    assert(path.resolve(state).startsWith(folder + path.sep));
    if (fs.existsSync(state)) fs.unlinkSync(state);
  } catch { receipt.smoke = 'FAIL'; process.exitCode = 1; console.error('FAIL release smoke cleanup'); }
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
}
