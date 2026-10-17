// Candidate npm archive + real application container + disposable PostgreSQL.
// Fixture creation uses installed SDK internals only to avoid O(n^2) catalog
// rewrites during seeding. All measured lifecycle operations use public exports.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { auxiliaryImages } from '../test/support/auxiliary-images.mjs';
import { sha256, validateLargeCatalog } from './ci/policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const suffix = randomUUID().replaceAll('-', ''), label = `io.ulda.large-test=${suffix}`;
const network = `ulda-large-${suffix}`, db = `${network}-db`, app = `${network}-server`;
const folder = path.join(root, '.local', `large-catalog-${suffix}`);
const consumer = path.join(folder, 'consumer');
fs.mkdirSync(consumer, { recursive: true });
const expected = JSON.parse(fs.readFileSync('test/consumer-candidate.json'));
const result = { status: 'RUNNING', count: 10000, checks: [], timingsMs: {}, sdk: expected };
const env = { ...process.env, POSTGRES_USER: 'ulda_test', POSTGRES_DB: `ulda_test_${suffix}`, POSTGRES_PASSWORD: randomUUID() };
for (const key of ['DATABASE_URL', 'PGPASSWORD', 'PGPASSWORD_FILE', 'NODE_OPTIONS', 'NODE_PATH', 'DEBUG']) delete env[key];
let phase = 'candidate-install', networkCreated = false, pool;
const clients = [], privateMarkers = [env.POSTGRES_PASSWORD];
async function run(file, args, timeout = 180000) {
  // Capture subprocess diagnostics: commands may contain synthetic secrets.
  const { stdout } = await promisify(execFile)(file, args, { cwd: root, env, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
const docker = (...args) => run('docker', args);
const inspect = async (name, field) => JSON.parse(await docker('inspect', name, '--format', `{{json ${field}}}`));
async function until(check, ms = 60000) {
  const end = Date.now() + ms;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < end);
  throw new Error('State deadline exceeded');
}
async function step(name, work) {
  phase = name;
  console.log(`START ${name}`);
  const begin = performance.now();
  await work();
  result.timingsMs[name] = Math.round(performance.now() - begin);
  result.checks.push(name);
  console.log(`PASS ${name}`);
}
try {
  assert(process.env.npm_execpath, 'Use npm run test:large-catalog');
  const archive = fs.realpathSync(process.env.ULDA_TEST_SDK_TARBALL);
  assert(archive.endsWith('.tgz') && fs.statSync(archive).size <= 10 * 1024 * 1024);
  assert.equal(await sha256(archive), expected.sha256);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'ulda-large-consumer', version: '0.0.0', private: true, type: 'module' }));
  await run(process.execPath, [process.env.npm_execpath, 'install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', archive]);
  assert.equal(await sha256(archive), expected.sha256);
  result.consumerLockSha256 = await sha256(path.join(consumer, 'package-lock.json'));
  const packageRoot = fs.realpathSync(path.join(consumer, 'node_modules', 'ulda-auth'));
  assert.equal(packageRoot, path.join(consumer, 'node_modules', 'ulda-auth'));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
  assert.equal(manifest.name, expected.name); assert.equal(manifest.version, expected.version);
  fs.writeFileSync(path.join(consumer, 'index.mjs'), "export { Ulda } from 'ulda-auth';\n");
  const { Ulda } = await import(pathToFileURL(path.join(consumer, 'index.mjs')).href);
  const { newOrigin } = await import(pathToFileURL(path.join(packageRoot, 'src/core.js')).href);
  const { newContentSecret, newToken, contentCredentials, masterCredentials, seal, sealedWire } = await import(pathToFileURL(path.join(packageRoot, 'src/crypto.js')).href);
  const image = process.env.ULDA_TEST_IMAGE;
  assert(image && !image.startsWith('-'), 'Explicit application test image required');
  result.imageId = await docker('image', 'inspect', image, '--format', '{{.Id}}');
  assert.match(result.imageId, /^sha256:[a-f0-9]{64}$/);
  await step('container-start', async () => {
    result.auxiliaryImages = await auxiliaryImages(docker, suffix);
    await docker('network', 'create', '--label', label, network); networkCreated = true;
    await docker('run', '-d', '--name', db, '--label', label, '--network', network, '--network-alias', 'postgres',
      '--publish', '127.0.0.1::5432', '--mount', 'type=volume,destination=/var/lib/postgresql',
      '-e', 'POSTGRES_USER', '-e', 'POSTGRES_DB', '-e', 'POSTGRES_PASSWORD', result.auxiliaryImages.postgres.id);
    await until(async () => { try { return (await docker('exec', db, 'psql', '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-At', '-c', 'SELECT 1')) === '1'; } catch { return false; } });
    const port = (await inspect(db, '.NetworkSettings.Ports'))['5432/tcp'][0].HostPort;
    pool = new Pool({ host: '127.0.0.1', port: Number(port), user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: env.POSTGRES_DB,
      max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    pool.on('error', () => { result.databaseError = true; });
    Object.assign(env, { PGHOST: 'postgres', PGPORT: '5432', PGUSER: env.POSTGRES_USER, PGDATABASE: env.POSTGRES_DB, PGPASSWORD: env.POSTGRES_PASSWORD });
    const flags = ['--label', label, '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128',
      '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGDATABASE', '-e', 'PGPASSWORD'];
    await docker('run', '--rm', ...flags, result.imageId, 'node', 'dist/cli/migrate-postgres.js');
    await docker('run', '-d', '--init', '--name', app, ...flags, '--publish', '127.0.0.1::3000', result.imageId);
  });
  const port = (await inspect(app, '.NetworkSettings.Ports'))['3000/tcp'][0].HostPort;
  const endpoint = `http://127.0.0.1:${port}`;
  await until(async () => { try { const res = await fetch(endpoint + '/ready', { signal: AbortSignal.timeout(3000) }); await res.arrayBuffer(); return res.status === 200; } catch { return false; } });
  let errors = 0;
  const client = () => { const value = new Ulda(endpoint, { allowInsecureLocalhost: true, timeout: 60000 }); value.on('error', () => { errors++; }); clients.push(value); return value; };
  await step('public-create-65', async () => {
    const a = client(), password = randomUUID(); privateMarkers.push(password);
    const id = await a.register(password);
    for (let i = 0; i < 65; i++) await a.add(`small-${i}`, { number: i });
    assert.equal(Object.keys(a.snapshot()).length, 65);
    const b = client(); await b.connect(id, password); assert.equal(Object.keys(b.snapshot()).length, 65);
    await a.superDelete(); await until(() => b.status === 'closed');
    await a.close(); await b.close();
    assert.equal((await pool.query('SELECT count(*) AS n FROM public.ulda_resources')).rows[0].n, '0');
  });
  const contents = [];
  await step('seed-10000', async () => {
    // Test-only encrypted fixture generation; not a benchmark of 10,000 add() calls.
    for (let base = 0; base < result.count; base += 64) {
      for (let i = base; i < Math.min(result.count, base + 64); i++) {
        const key = newContentSecret(), token = newToken(), credentials = await contentCredentials(key), origin = newOrigin('X');
        try {
          const wire = sealedWire(await seal(credentials, token, origin, { number: i }));
          const saved = await pool.query('INSERT INTO public.ulda_resources(witness,payload) VALUES($1,$2) RETURNING id', [Buffer.from(wire.witness), Buffer.from(wire.payload)]);
          contents.push({ id: saved.rows[0].id, name: `entry-${i}`, key, token });
        } finally { origin.fill(0); }
      }
    }
  });
  const password = randomUUID(), token = newToken(), credentials = await masterCredentials(password), origin = newOrigin('X');
  privateMarkers.push(password, contents[0].key, contents[0].token);
  let master;
  try {
    const wire = sealedWire(await seal(credentials, token, origin, { contents }, true));
    result.catalogBytes = wire.payload.length; assert(result.catalogBytes > 1100000);
    master = (await pool.query('INSERT INTO public.ulda_resources(witness,payload) VALUES($1,$2) RETURNING id', [Buffer.from(wire.witness), Buffer.from(wire.payload)])).rows[0].id;
  } finally { origin.fill(0); }
  const a = client(), b = client();
  await step('connect-10000', async () => { await a.connect(master, password); assert.equal(Object.keys(a.snapshot()).length, result.count); });
  await step('peer-connect-10000', async () => { await b.connect(master, password); assert.equal(Object.keys(b.snapshot()).length, result.count); assert.equal(b.value('entry-9999').number, 9999); });
  await step('add-and-changed', async () => { await a.add('new-content', { number: result.count }); await until(() => Object.hasOwn(b.snapshot(), 'new-content')); assert.equal(b.value('new-content').number, result.count); });
  await step('update-and-changed', async () => { await a.set('entry-0', ['number'], -1); await until(() => b.value('entry-0').number === -1); });
  await step('refresh-10001', async () => { await a.refresh(); assert.equal(Object.keys(a.snapshot()).length, result.count + 1); assert.equal(a.value('entry-0').number, -1); });
  await step('delete-and-changed', async () => { await a.delete('entry-9999'); await until(() => !Object.hasOwn(b.snapshot(), 'entry-9999')); });
  await step('super-delete-and-changed', async () => { await a.superDelete(); await until(() => b.status === 'closed'); });
  result.remainingRows = Number((await pool.query('SELECT count(*) AS n FROM public.ulda_resources')).rows[0].n);
  assert.equal(result.remainingRows, 0); assert.equal(errors, 0); assert(!result.databaseError);
  result.asyncErrors = errors;
  phase = 'private-log-canaries';
  const { stdout, stderr } = await promisify(execFile)('docker', ['logs', app], { env, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  for (const marker of privateMarkers) assert(!`${stdout}${stderr}`.includes(marker));
  result.status = 'PASS';
} catch {
  result.status = 'FAIL'; result.failedPhase = phase; process.exitCode = 1;
  console.error(`FAIL ${phase}; private diagnostics suppressed.`);
} finally {
  try {
    for (const client of clients) await client.close();
    await pool?.end();
    const owned = (await docker('ps', '-aq', '--filter', `label=${label}`)).split(/\s+/).filter(Boolean);
    for (const container of owned) {
      assert.equal((await inspect(container, '.Config.Labels'))['io.ulda.large-test'], suffix);
      await docker('rm', '-f', '-v', container);
    }
    if (networkCreated) { assert.equal((JSON.parse(await docker('network', 'inspect', network)))[0].Labels['io.ulda.large-test'], suffix); await docker('network', 'rm', network); }
    result.cleanup = 'PASS';
  } catch { result.cleanup = 'FAIL'; result.status = 'FAIL'; process.exitCode = 1; console.error('FAIL owned-resource cleanup.'); }
  if (result.status === 'PASS') {
    try { validateLargeCatalog(result, expected, result.imageId); }
    catch { result.status = 'FAIL'; process.exitCode = 1; console.error('FAIL acceptance receipt.'); }
  }
  fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Large catalog ${result.status}; report: ${path.relative(root, path.join(folder, 'result.json'))}`);
}
