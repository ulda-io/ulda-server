import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { names, fixtureNames, buildNames, externalPostgresImage, sha256, validateManifest, evaluateVulnerabilities, validateCapacity, imageContentIdentity } from './policy.mjs';

const root = process.cwd(), output = path.resolve('.local/ci-images');
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit', windowsHide: true, timeout: 1200000 });
const capture = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 1200000 }).trim();
const git = (...args) => capture('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args]);
const commit = git('rev-parse', 'HEAD');
const manifestFile = path.join(output, 'manifest.json');
const action = process.argv[2];
fs.mkdirSync(output, { recursive: true });
if (action === 'build') {
  const sourceClean = git('status', '--porcelain') === '';
  if (process.env.CI) assert(sourceClean, 'Dirty source checkout');
  const build = { commit, sourceClean, version: JSON.parse(fs.readFileSync('package.json')).version, platform: 'linux/amd64', startedAt: new Date().toISOString(), images: {} };
  for (const name of buildNames) {
    const tag = `ulda-ci/${name}:candidate`;
    run('docker', ['build', '--pull', '--no-cache', '--platform', 'linux/amd64', '-t', tag, name === 'server' ? '.' : `deploy/${name}`]);
    build.images[name] = { tag, id: capture('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']) };
  }
  run('docker', ['pull', '--platform', 'linux/amd64', externalPostgresImage]);
  const external = JSON.parse(capture('docker', ['image', 'inspect', externalPostgresImage]))[0];
  build.externalDatabase = { reference: externalPostgresImage, contentIdentity: imageContentIdentity(external) };
  fs.writeFileSync('.local/ci-build.json', JSON.stringify(build, null, 2) + '\n');
} else if (action === 'export') {
  const build = JSON.parse(fs.readFileSync('.local/ci-build.json'));
  assert.equal(build.commit, commit);
  const find = prefix => {
    const matches = fs.readdirSync('.local').filter(n => n.startsWith(prefix)).map(n => path.join('.local', n, 'result.json'))
      .filter(f => fs.existsSync(f) && fs.statSync(f).mtimeMs >= Date.parse(build.startedAt));
    assert(matches.length > 0, `Missing current ${prefix} report`);
    matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return JSON.parse(fs.readFileSync(matches[0]));
  };
  const reports = { integration: find('integration-'), deployment: find('deployment-'), capacity: find('ulda-capacity-') };
  for (const report of Object.values(reports)) {
    assert.equal(report.status, 'PASS');
    assert.equal(report.cleanup, 'PASS');
    assert.equal(report.imageId, build.images.server.id);
    assert.equal(report.auxiliaryImages.postgres.id, build.images.postgres.id);
  }
  assert.equal(reports.deployment.auxiliaryImages.proxy.id, build.images.proxy.id);
  const long = process.env.ULDA_CI_RELEASE === 'true';
  const measured = validateCapacity(reports.capacity, long ? 1800 : 30);
  const externalReceiptFile = '.local/ci-smoke-candidate.json';
  assert(fs.statSync(externalReceiptFile).mtimeMs >= Date.parse(build.startedAt));
  const externalReceipt = JSON.parse(fs.readFileSync(externalReceiptFile));
  assert.equal(externalReceipt.smoke, 'PASS');
  assert.equal(externalReceipt.cleanup, 'PASS');
  assert.equal(externalReceipt.commit, commit);
  assert.equal(externalReceipt.images.server.reference, build.images.server.id);
  assert.deepEqual(externalReceipt.externalDatabase, build.externalDatabase);
  const manifest = { schema: 2, commit, sourceClean: build.sourceClean === true, version: build.version, platform: build.platform,
    releaseAcceptance: long, images: {}, testFixtures: Object.fromEntries(fixtureNames.map(name => [name, build.images[name]])),
    externalDatabase: build.externalDatabase, checks: ['integration', 'deployment', 'capacity', 'external-postgres'],
    capacity: { clients: 100, seconds: reports.capacity.options.seconds, confirmed: measured.confirmed } };
  for (const name of names) {
    const { tag, id } = build.images[name];
    assert.equal(capture('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']), id, 'Image changed after tests');
    const archive = `${name}.tar`;
    run('docker', ['save', '--output', path.join(output, archive), tag]);
    const archiveFile = path.join(output, archive);
    const entries = JSON.parse(capture('tar', ['-xOf', archiveFile, 'manifest.json']));
    assert.equal(entries.length, 1, 'Expected one image per archive');
    assert.match(entries[0].Config, /^(?:blobs\/sha256\/)?[a-f0-9]{64}(?:\.json)?$/);
    const config = execFileSync('tar', ['-xOf', archiveFile, entries[0].Config]);
    const configId = 'sha256:' + createHash('sha256').update(config).digest('hex');
    const inspect = JSON.parse(capture('docker', ['image', 'inspect', tag]))[0];
    manifest.images[name] = { tag, id, configId, contentIdentity: imageContentIdentity(inspect), archive, sha256: await sha256(archiveFile) };
  }
  validateManifest(manifest, commit);
  // Never upload stale auxiliary archives from an earlier three-image release rehearsal.
  for (const file of fs.readdirSync(output)) assert(['server.tar', 'manifest.json'].includes(file), 'Unexpected publication artifact');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const hash = await sha256(manifestFile);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `manifest_sha256=${hash}\n`);
  console.log(`PASS tested image export; manifest SHA-256 ${hash}`);
} else if (action === 'scan') {
  assert.equal(await sha256(manifestFile), process.env.ULDA_MANIFEST_SHA256, 'Manifest checksum mismatch');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  validateManifest(manifest, commit);
  fs.mkdirSync('.local/ci-reports', { recursive: true });
  const results = {};
  const scanner = process.platform === 'win32' ? '.local/ci-tools/trivy.exe' : '.local/ci-tools/trivy';
  for (const name of names) {
    const item = manifest.images[name], archive = path.join(output, item.archive);
    assert.equal(await sha256(archive), item.sha256, 'Image archive checksum mismatch');
    const report = `.local/ci-reports/${name}.json`;
    run(scanner, ['image', '--input', archive, '--scanners', 'vuln', '--list-all-pkgs', '--format', 'json', '--output', report, '--timeout', '10m', '--ignorefile', '.github/empty.trivyignore']);
    results[name] = evaluateVulnerabilities(JSON.parse(fs.readFileSync(report)), [item.id, item.configId], { imageName: name });
    run(scanner, ['image', '--input', archive, '--format', 'cyclonedx', '--output', `.local/ci-reports/${name}.cdx.json`, '--timeout', '10m']);
    console.log(`${name}: ${JSON.stringify(results[name].counts)}; blocking findings ${results[name].blocked.length}; vendor-confirmed non-affected ${results[name].notAffected.length}`);
  }
  fs.writeFileSync('.local/ci-reports/gate.json', JSON.stringify({ commit, results }, null, 2) + '\n');
  assert(Object.values(results).every(r => r.passed), 'Image security gate blocked; review reports. Unfixed findings are included.');
} else if (action === 'scan-fixtures') {
  const build = JSON.parse(fs.readFileSync('.local/ci-build.json'));
  assert.equal(build.commit, commit);
  const reports = '.local/ci-fixture-reports';
  fs.mkdirSync(reports, { recursive: true });
  const scanner = process.platform === 'win32' ? '.local/ci-tools/trivy.exe' : '.local/ci-tools/trivy';
  const results = {};
  const fixtures = { ...Object.fromEntries(fixtureNames.map(name => [name, build.images[name].id])),
    'external-postgres': externalPostgresImage };
  for (const [name, reference] of Object.entries(fixtures)) {
    const inspect = JSON.parse(capture('docker', ['image', 'inspect', reference]))[0];
    if (name === 'external-postgres') assert.equal(imageContentIdentity(inspect), build.externalDatabase.contentIdentity);
    const report = `${reports}/${name}.json`;
    run(scanner, ['image', '--image-src', 'docker', '--scanners', 'vuln', '--list-all-pkgs', '--format', 'json', '--output', report,
      '--timeout', '10m', '--ignorefile', '.github/empty.trivyignore', reference]);
    // These are raw advisory reports, not a release security pass for the database/proxy.
    const raw = JSON.parse(fs.readFileSync(report));
    assert.equal(raw.SchemaVersion, 2);
    assert(raw.Metadata?.OS && raw.Results?.some(r => r.Packages?.length), 'Missing fixture inventory');
    const counts = {};
    for (const result of raw.Results) for (const v of result.Vulnerabilities ?? []) counts[v.Severity] = (counts[v.Severity] ?? 0) + 1;
    results[name] = { reference, id: inspect.Id, counts, advisoryOnly: true, published: false };
    console.log(`ADVISORY ${name}: ${JSON.stringify(counts)}; test infrastructure, not published by this workflow.`);
  }
  fs.writeFileSync(`${reports}/summary.json`, JSON.stringify({ commit, results }, null, 2) + '\n');
} else {
  throw new Error('Expected build, export, scan or scan-fixtures');
}
