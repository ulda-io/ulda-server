import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { names, externalPostgresImage, evaluateVulnerabilities, validateCapacity, validateIdentity, validateManifest, repositoryName, imageContentIdentity } from '../../scripts/ci/policy.mjs';

const image = 'sha256:' + 'a'.repeat(64), commit = 'b'.repeat(40);
const report = vulnerabilities => ({ SchemaVersion: 2, Metadata: { ImageID: image, OS: { Family: 'alpine', Name: '3.24' } }, Results: [{ Packages: [{ Name: 'synthetic', Version: '1' }], Vulnerabilities: vulnerabilities }] });
test('unfixed High, Critical and unknown findings block release; no blanket exception', () => {
  for (const severity of ['HIGH', 'CRITICAL', 'UNKNOWN']) {
    const result = evaluateVulnerabilities(report([{ Severity: severity, VulnerabilityID: 'CVE-2099-0001', PkgName: 'synthetic', InstalledVersion: '1' }]), image);
    assert.equal(result.passed, false);
    assert.equal(result.blocked.length, 1);
  }
  assert.equal(evaluateVulnerabilities(report([{ Severity: 'LOW' }]), image).counts.LOW, 1);
  assert.equal(evaluateVulnerabilities(report([]), image).passed, true);
});
test('missing inventory, foreign image and malformed security report fail closed', () => {
  assert.throws(() => evaluateVulnerabilities({}, image));
  assert.throws(() => evaluateVulnerabilities(report([]), 'sha256:' + 'c'.repeat(64)));
  const empty = report([]); empty.Results = []; assert.throws(() => evaluateVulnerabilities(empty, image));
  const old = report([]); old.Metadata.OS.EOSL = true; assert.throws(() => evaluateVulnerabilities(old, image));
  const inventory = report([]); delete inventory.Results[0].Packages; assert.throws(() => evaluateVulnerabilities(inventory, image));
});
test('release identity rejects branch push, version mismatch and unsafe names', () => {
  const pkg = { name: '@ulda/server', version: '1.0.0' }, lock = { version: '1.0.0', packages: { '': { version: '1.0.0' } } };
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.0.0' };
  assert.equal(validateIdentity(pkg, lock, env), '1.0.0');
  for (const bad of [{ ...env, GITHUB_REF_TYPE: 'branch' }, { ...env, GITHUB_REF_NAME: 'v1.0.1' }]) assert.throws(() => validateIdentity(pkg, lock, bad));
  for (const bad of ['', '-bad/name', 'host.example/org/repo', 'org/name:latest', 'org/../name']) assert.throws(() => repositoryName(bad));
  assert.equal(repositoryName('example/server'), 'example/server');
});
test('manifest admits only the application archive and binds independent database acceptance', () => {
  assert.deepEqual(names, ['server']);
  const manifest = { schema: 2, commit, platform: 'linux/amd64', version: '1.0.0',
    images: { server: { tag: 'ulda-ci/server:candidate', id: image, configId: image, contentIdentity: 'c'.repeat(64), archive: 'server.tar', sha256: 'c'.repeat(64) } },
    testFixtures: Object.fromEntries(['postgres', 'proxy'].map(name => [name, { tag: `ulda-ci/${name}:candidate`, id: image }])),
    externalDatabase: { reference: externalPostgresImage, contentIdentity: 'd'.repeat(64) }, checks: ['integration', 'deployment', 'capacity', 'external-postgres'] };
  validateManifest(manifest, commit);
  assert.throws(() => validateManifest(manifest, 'd'.repeat(40)));
  for (const mutate of [m => m.images.server.archive = '../private', m => delete m.images.server,
    m => m.images.postgres = { ...m.images.server, archive: 'postgres.tar' },
    m => m.images.proxy = { ...m.images.server, archive: 'proxy.tar' }, m => m.schema = 1,
    m => delete m.testFixtures.postgres, m => m.testFixtures.postgres.archive = 'postgres.tar',
    m => m.externalDatabase.reference = 'postgres:latest', m => m.externalDatabase.contentIdentity = 'wrong',
    m => m.checks = ['integration', 'deployment', 'capacity'], m => m.checks = 'external-postgres',
    m => m.checks = ['external-postgres']]) {
    const bad = structuredClone(manifest); mutate(bad); assert.throws(() => validateManifest(bad, commit));
  }
  assert.throws(() => validateManifest({ ...manifest, sourceClean: false, releaseAcceptance: true }, commit));
});
test('portable image identity binds layers and runtime config, independent of Docker local ID', () => {
  const original = { Os: 'linux', Architecture: 'amd64', RootFS: { Layers: [image] }, Config: { User: 'node', Cmd: ['node', 'dist/main.js'] } };
  const same = { ...original, Id: 'different local store ID', Config: { Cmd: ['node', 'dist/main.js'], User: 'node' } };
  assert.equal(imageContentIdentity(original), imageContentIdentity(same));
  assert.notEqual(imageContentIdentity(original), imageContentIdentity({ ...original, Config: { ...original.Config, User: 'root' } }));
  assert.notEqual(imageContentIdentity(original), imageContentIdentity({ ...original, RootFS: { Layers: ['sha256:' + 'd'.repeat(64)] } }));
});
test('short load, unknown writes, cleanup failure and missing client verification cannot certify release', () => {
  const result = { status: 'PASS', cleanup: 'PASS', options: { clients: 100, seconds: 1800 }, measurement: { confirmed: 10, attempted: 10, failed: 0, asyncErrors: 0, authorEchoes: 0, verifiedClients: 100 } };
  validateCapacity(result, 1800);
  for (const mutate of [r => r.options.seconds = 30, r => r.measurement.attempted++, r => r.measurement.asyncErrors++, r => r.measurement.verifiedClients--, r => r.cleanup = 'FAIL']) {
    const bad = structuredClone(result); mutate(bad); assert.throws(() => validateCapacity(bad, 1800));
  }
});
test('workflow publication depends on required checks and never runs in manual rehearsal', () => {
  const publish = fs.readFileSync('.github/workflows/publish.yml', 'utf8');
  assert.match(publish, /publish:\s+needs: checks/);
  assert.match(publish, /github.event_name == 'push' && github.ref_type == 'tag'/);
  assert.match(publish, /environment: dockerhub/);
  assert(!publish.includes('continue-on-error'));
  assert(!publish.includes('ULDA_DOCKER_POSTGRES'));
  assert(!publish.includes('ULDA_DOCKER_PROXY'));
  const checks = fs.readFileSync('.github/workflows/checks.yml', 'utf8');
  assert.match(checks, /needs: \[source, unit, images, image-security\]/);
  assert.match(checks, /test "\$SECURITY" = success/);
  assert(!checks.includes('secrets.'));
  const securityJob = checks.split('  image-security:')[1].split('  required:')[0];
  assert(!securityJob.includes('continue-on-error'));
  assert.match(checks, /release-smoke\.mjs --candidate/);
});
