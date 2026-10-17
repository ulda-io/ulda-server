// Compare isolated candidate copies, never change production batch constants.
// Run after other load tests; the temporary Docker network/volume are owned here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runPostgresMigrations } from '../dist/storage/postgres/migrations.js';
import { httpReady } from '../test/support/http-probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)); process.chdir(root);
const diagnostic = process.argv[2] === '--diagnose-read-budget';
assert(process.argv.length === (diagnostic ? 3 : 2), 'Only --diagnose-read-budget is supported');
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
assert(fs.existsSync(npm), 'npm CLI is required to install the isolated archive.');
const image = process.env.ULDA_TEST_IMAGE, postgres = process.env.ULDA_TEST_POSTGRES_IMAGE;
assert(image && postgres && !image.startsWith('-') && !postgres.startsWith('-'));
const archive = fs.realpathSync(process.env.ULDA_TEST_SDK_TARBALL ?? '');
assert(archive.endsWith('.tgz') && fs.statSync(archive).isFile() && fs.statSync(archive).size < 10 * 1024 * 1024);
const id = randomUUID().replaceAll('-', ''), name = 'ulda-sizing-' + id.slice(0, 16), label = 'io.ulda.batch-sizing=' + id;
const folder = path.join(root, '.local', name); fs.mkdirSync(folder, { recursive: true });
const env = { ...process.env, POSTGRES_USER: 'ulda_test', POSTGRES_DB: 'ulda_test_' + id, POSTGRES_PASSWORD: randomUUID() };
for (const key of Object.keys(env)) if (/^(?:PG|DATABASE_|NODE_OPTIONS$)/.test(key)) delete env[key];
const result = { status: 'RUNNING', startedAt: new Date().toISOString(), sdkArchiveSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
  sizes: diagnostic ? [64] : [16, 32, 64, 100, 200], rounds: diagnostic ? 1 : 3, runs: [], profiles: [
    { name: 'single-small', clients: 1, contents: 1000, bytes: 1024 },
    { name: 'concurrent-small', clients: 100, contents: 200, bytes: 1024 },
    { name: 'concurrent-medium', clients: 100, contents: 200, bytes: 32768 },
  ], readBudgetBytes: diagnostic ? 4294967296 : 268435456,
  scope: diagnostic ? 'diagnostic only: isolated 4 GiB read reservation, unchanged 1 GiB container; not a production setting or sizing acceptance'
    : 'full SDK open/decrypt, disjoint encrypted IDs, default server admission; patched isolated copies only', phase: 'prepare' };
let pool, networkCreated = false, app, db, children = [];
async function run(file, args, options = {}) {
  try { return (await promisify(execFile)(file, args, { cwd: root, env, timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options })).stdout.trim(); }
  catch { throw new Error('Benchmark subprocess failed; private diagnostics suppressed'); }
}
const docker = (...args) => run('docker', args);
const until = async (fn, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('Benchmark deadline'); };
async function waitForWorkers(predicate, ms = 90000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    assert(!children.some(c => c.failed), 'Benchmark worker failed');
    assert(Date.now() < end, 'Benchmark worker deadline');
    await new Promise(r => setTimeout(r, 100));
  }
}
async function removeContainer(container) {
  if (!container) return;
  assert.equal(await docker('inspect', container, '--format', '{{index .Config.Labels "io.ulda.batch-sizing"}}'), id);
  await docker('rm', '-f', '-v', container);
}
function patchOne(file, before, after) {
  const text = fs.readFileSync(file, 'utf8'); assert.equal(text.split(before).length, 2);
  fs.writeFileSync(file, text.replace(before, after));
}
async function measure(profile, batch, round, entry, url) {
  children = [];
  const workerCount = Math.min(4, profile.clients);
  for (let i = 0; i < workerCount; i++) {
    const proc = fork('test/load/batch-client.mjs', [], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const child = { proc, ready: false, exited: false, failed: false, report: null }; children.push(child);
    proc.on('message', m => { if (m.kind === 'ready') child.ready = true; if (m.kind === 'result') child.report = m; if (m.kind === 'failed') child.failed = true; });
    proc.on('error', () => { child.failed = true; });
    proc.on('exit', code => { child.exited = true; if (code || !child.report) child.failed = true; });
    proc.send({ action: 'init', entry, url, password: profile.password, contents: profile.contents,
      masters: profile.masters.filter((_, n) => n % workerCount === i) });
  }
  await waitForWorkers(() => children.every(c => c.ready));
  const start = Date.now() + 250;
  for (const c of children) c.proc.send({ action: 'start', at: start });
  await waitForWorkers(() => children.every(c => c.exited), 180000);
  assert(!children.some(c => c.failed));
  const reports = children.map(c => c.report), samples = reports.flatMap(r => r.samples);
  assert(reports.reduce((n, r) => n + r.reads, 0) >= profile.clients, 'Missing transport read instrumentation');
  const limitsByRequestSize = {};
  for (const report of reports) for (const [size, count] of Object.entries(report.limitsByRequestSize))
    limitsByRequestSize[size] = (limitsByRequestSize[size] ?? 0) + count;
  const distribution = values => {
    values.sort((a, b) => a - b);
    return { count: values.length, p50: values[Math.ceil(values.length * .5) - 1], p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1) };
  };
  const summary = key => distribution(samples.filter(x => x[key] !== undefined).map(x => x[key]));
  const elapsedMs = Math.max(...reports.map(x => x.elapsedMs));
  const measured = { profile: profile.name, batch, round, clients: profile.clients, contents: profile.contents, jsonBytes: profile.bytes,
    errors: reports.reduce((n, x) => n + x.errors, 0), limitResponses: reports.reduce((n, x) => n + x.limits, 0), reads: reports.reduce((n, x) => n + x.reads, 0),
    asyncErrors: reports.reduce((n, x) => n + x.asyncErrors, 0),
    limitsByRequestSize, failedStages: samples.filter(x => x.code).map(x => x.stage),
    elapsedMs, open: summary('openMs'), content: summary('contentMs'),
    readAckMs: distribution(reports.flatMap(x => x.readAcks)),
    generatorCpuCores: reports.reduce((n, x) => n + x.cpuMicros, 0) / 1000 / elapsedMs,
    generatorEventLoopP99Ms: reports.map(x => x.loopP99Ms),
    generatorRssBytes: reports.reduce((n, x) => n + x.maxRssBytes, 0), codes: samples.filter(x => x.code).map(x => x.code) };
  const stats = JSON.parse(await docker('stats', '--no-stream', '--format', '{{json .}}', app));
  measured.serverMemory = stats.MemUsage;
  measured.serverPeakBytes = Number(await docker('exec', app, 'cat', '/sys/fs/cgroup/memory.peak'));
  result.runs.push(measured);
  console.log(JSON.stringify({ profile: profile.name, batch, round, errors: measured.errors, limits: measured.limitResponses, reads: measured.reads, elapsedMs: Math.round(measured.elapsedMs), p95ContentMs: Math.round(measured.content.p95 ?? 0) }));
  fs.writeFileSync(path.join(folder, 'progress.json'), JSON.stringify({ ...result, profiles: result.profiles.map(({ masters, password, ...p }) => p) }, null, 2));
}
try {
  const consumer = path.join(folder, 'consumer'); fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'synthetic-batch-consumer', private: true, type: 'module' }));
  await run(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', archive], { cwd: consumer });
  assert.equal(createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), result.sdkArchiveSha256);
  const sdkRoot = path.join(consumer, 'node_modules/ulda-auth');
  const manifest = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
  assert.equal(manifest.name, 'ulda-auth');
  const exported = manifest.exports['.'].import;
  assert(typeof exported === 'string' && exported.startsWith('./'));
  assert(fs.realpathSync(path.join(sdkRoot, exported)).startsWith(fs.realpathSync(sdkRoot) + path.sep));
  result.sdk = manifest.name + '@' + manifest.version;
  result.sdkSource = 'explicit local candidate archive; isolated constants changed only for sizing';
  result.consumerLockSha256 = createHash('sha256').update(fs.readFileSync(path.join(consumer, 'package-lock.json'))).digest('hex');
  const { seal, sealedWire, masterCredentials, contentCredentials, newContentSecret, newToken } = await import(pathToFileURL(path.join(sdkRoot, 'src/crypto.js')).href);
  const { newOrigin } = await import(pathToFileURL(path.join(sdkRoot, 'src/core.js')).href);
  result.imageId = await docker('image', 'inspect', image, '--format', '{{.Id}}');
  result.postgresImageId = await docker('image', 'inspect', postgres, '--format', '{{.Id}}');
  const serverSource = await docker('run', '--rm', '--entrypoint', 'node', result.imageId, '-e', "process.stdout.write(require('fs').readFileSync('/app/dist/protocol/sdk-commands.js','utf8'))");
  const variants = new Map();
  for (const size of result.sizes) {
    const dir = path.join(consumer, 'variants', String(size)); fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(sdkRoot, path.join(dir, 'sdk'), { recursive: true });
    patchOne(path.join(dir, 'sdk/src/values.js'), 'batch: 64,', 'batch: ' + size + ',');
    fs.writeFileSync(path.join(dir, 'sdk-commands.js'), serverSource);
    patchOne(path.join(dir, 'sdk-commands.js'), 'batch: 64,', 'batch: ' + size + ',');
    variants.set(size, { entry: path.join(dir, 'sdk', exported), server: path.join(dir, 'sdk-commands.js') });
  }
  await docker('network', 'create', '--label', label, name); networkCreated = true;
  db = name + '-db';
  await docker('run', '-d', '--name', db, '--label', label, '--network', name, '--network-alias', 'postgres', '--publish', '127.0.0.1::5432',
    '--memory', '1g', '--mount', 'type=volume,destination=/var/lib/postgresql', '-e', 'POSTGRES_USER', '-e', 'POSTGRES_DB', '-e', 'POSTGRES_PASSWORD', result.postgresImageId,
    'postgres', '-c', 'max_connections=40', '-c', 'shared_buffers=128MB');
  await until(async () => (await docker('exec', db, 'psql', '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-At', '-c', 'SELECT 1')) === '1');
  const port = JSON.parse(await docker('inspect', db, '--format', '{{json .NetworkSettings.Ports}}'))['5432/tcp'][0].HostPort;
  pool = new Pool({ host: '127.0.0.1', port: Number(port), user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: env.POSTGRES_DB });
  const client = await pool.connect(); try { await runPostgresMigrations(client, 'migrations/postgres'); } finally { client.release(); }
  result.phase = 'seed';
  for (const profile of result.profiles) {
    profile.password = randomUUID(); profile.masters = [];
    const key = newContentSecret(), token = newToken(), credentials = await contentCredentials(key), origin = newOrigin('X');
    const data = { marker: 'synthetic-read-sizing', text: 'x'.repeat(profile.bytes - 64) };
    profile.actualJsonBytes = Buffer.byteLength(JSON.stringify(data));
    let wire;
    try { wire = sealedWire(await seal(credentials, token, origin, data)); } finally { origin.fill(0); }
    profile.payloadBytes = wire.payload.byteLength;
    const masterKeys = await masterCredentials(profile.password);
    for (let c = 0; c < profile.clients; c++) {
      // Identical synthetic ciphertext isolates read-size effects. This fixture
      // is not an example of production per-content key generation.
      const rows = (await pool.query('INSERT INTO public.ulda_resources(witness,payload) SELECT $1,$2 FROM generate_series(1,$3::integer) RETURNING id', [wire.witness, wire.payload, profile.contents])).rows;
      const contents = rows.map((r, i) => ({ id: String(r.id), name: 'entry-' + i, key, token }));
      const masterOrigin = newOrigin('X'); let master;
      try { master = sealedWire(await seal(masterKeys, newToken(), masterOrigin, { contents }, true)); } finally { masterOrigin.fill(0); }
      const saved = await pool.query('INSERT INTO public.ulda_resources(witness,payload) VALUES ($1,$2) RETURNING id', [master.witness, master.payload]);
      profile.masters.push({ id: String(saved.rows[0].id) });
    }
  }
  result.phase = 'measure';
  env.PGHOST = 'postgres'; env.PGPORT = '5432'; env.PGUSER = env.POSTGRES_USER; env.PGDATABASE = env.POSTGRES_DB; env.PGPASSWORD = env.POSTGRES_PASSWORD;
  for (let round = 1; round <= result.rounds; round++) {
    // Rotated order reduces first/last candidate and database-cache bias.
    const offset = (round - 1) * 2, sizes = result.sizes.slice(offset).concat(result.sizes.slice(0, offset));
    for (const batch of sizes) {
      const variant = variants.get(batch); app = name + '-app';
      await docker('run', '-d', '--init', '--name', app, '--label', label, '--network', name, '--publish', '127.0.0.1::3000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '1g',
        '--mount', `type=bind,source=${variant.server},target=/app/dist/protocol/sdk-commands.js,readonly`,
        '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGDATABASE', '-e', 'PGPASSWORD', '-e', 'LOG_LEVEL=error', '-e', 'NODE_OPTIONS=--max-old-space-size=512',
        ...(diagnostic ? ['-e', 'MAX_ACTIVE_READ_BYTES=4294967296'] : []), result.imageId);
      const appPort = JSON.parse(await docker('inspect', app, '--format', '{{json .NetworkSettings.Ports}}'))['3000/tcp'][0].HostPort;
      const url = 'http://127.0.0.1:' + appPort; await until(() => httpReady(url));
      for (const profile of result.profiles) await measure(profile, batch, round, variant.entry, url);
      await removeContainer(app); app = undefined;
    }
  }
  result.status = 'MEASURED';
  result.hasClientErrors = result.runs.some(run => run.errors > 0 || run.asyncErrors > 0);
} catch { result.status = 'FAIL'; process.exitCode = 1; console.error('Batch sizing failed at ' + result.phase + '; private diagnostics suppressed.'); }
finally {
  for (const c of children) if (!c.exited) c.proc.kill();
  await pool?.end();
  try { await removeContainer(app); await removeContainer(db); if (networkCreated) { assert.equal(await docker('network', 'inspect', name, '--format', '{{index .Labels "io.ulda.batch-sizing"}}'), id); await docker('network', 'rm', name); } result.cleanup = 'PASS'; }
  catch { result.cleanup = 'FAIL'; result.status = 'FAIL'; process.exitCode = 1; }
  result.profiles = result.profiles.map(({ masters, password, ...p }) => p);
  result.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, runs: result.runs.length, report: path.relative(root, path.join(folder, 'result.json')) }));
}
