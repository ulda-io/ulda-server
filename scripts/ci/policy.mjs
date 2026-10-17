import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { assessNonAffected } from './vulnerability-assessment.mjs';

// Only application images may cross the registry publication boundary.
export const names = ['server'];
export const fixtureNames = ['postgres', 'proxy'];
export const buildNames = [...names, ...fixtureNames];
// Upstream PostgreSQL is an independently operated integration fixture, never a release artifact.
export const externalPostgresImage = 'postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c';
export const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export function imageContentIdentity(inspect) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  assert.equal(inspect.Os, 'linux');
  assert.equal(inspect.Architecture, 'amd64');
  assert(Array.isArray(inspect.RootFS?.Layers) && inspect.RootFS.Layers.length > 0);
  return createHash('sha256').update(JSON.stringify(canonical({ os: inspect.Os, architecture: inspect.Architecture,
    layers: inspect.RootFS.Layers, config: inspect.Config }))).digest('hex');
}
export function validateIdentity(pkg, lock, env) {
  assert.equal(pkg.name, '@ulda/server');
  assert(versionPattern.test(pkg.version), 'Release version must be a stable numeric version');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  if (env.GITHUB_EVENT_NAME === 'push') {
    assert.equal(env.GITHUB_REF_TYPE, 'tag');
    assert.equal(env.GITHUB_REF_NAME, `v${pkg.version}`);
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(env.GITHUB_REF, 'refs/heads/main');
  }
  return pkg.version;
}
export function validateManifest(manifest, commit) {
  assert.equal(manifest.schema, 3);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.platform, 'linux/amd64');
  if (manifest.releaseAcceptance) assert.equal(manifest.sourceClean, true, 'Release source checkout was not clean');
  assert(versionPattern.test(manifest.version));
  assert.deepEqual(Object.keys(manifest.images).sort(), [...names].sort());
  assert.deepEqual(Object.keys(manifest.testFixtures).sort(), [...fixtureNames].sort());
  for (const name of fixtureNames) {
    const item = manifest.testFixtures[name];
    assert.deepEqual(Object.keys(item).sort(), ['id', 'tag']);
    assert.equal(item.tag, `ulda-ci/${name}:candidate`);
    assert.match(item.id, /^sha256:[a-f0-9]{64}$/);
  }
  assert.deepEqual(Object.keys(manifest.externalDatabase).sort(), ['contentIdentity', 'reference']);
  assert.equal(manifest.externalDatabase.reference, externalPostgresImage);
  assert.match(manifest.externalDatabase.contentIdentity, /^[a-f0-9]{64}$/);
  assert.deepEqual([...manifest.checks].sort(), ['capacity', 'deployment', 'external-postgres', 'integration', 'large-catalog'], 'Missing required acceptance');
  validateSdkIdentity(manifest.sdkCandidate);
  assert.equal(manifest.largeCatalog.count, 10000);
  assert.match(manifest.largeCatalog.reportSha256, /^[a-f0-9]{64}$/);
  for (const name of names) {
    const item = manifest.images[name];
    assert.equal(item.archive, `${name}.tar`);
    assert.equal(item.tag, `ulda-ci/${name}:candidate`);
    assert.match(item.id, /^sha256:[a-f0-9]{64}$/);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.match(item.configId, /^sha256:[a-f0-9]{64}$/);
    assert.match(item.contentIdentity, /^[a-f0-9]{64}$/);
  }
}
export function evaluateVulnerabilities(report, expectedImageId, context = {}) {
  assert.equal(report.SchemaVersion, 2, 'Unknown scanner report format');
  assert([expectedImageId].flat().includes(report.Metadata?.ImageID), 'Scanner report/image mismatch');
  assert(report.Metadata?.OS?.Family && report.Metadata.OS.Name, 'Missing OS inventory');
  assert.equal(report.Metadata.OS.EOSL ?? false, false, 'Unsupported OS distribution');
  assert(Array.isArray(report.Results) && report.Results.length > 0, 'Empty scanner results');
  assert(report.Results.some(result => Array.isArray(result.Packages) && result.Packages.length > 0), 'Missing package inventory');
  const counts = {}, blocked = [], notAffected = [];
  for (const result of report.Results) {
    for (const item of result.Vulnerabilities ?? []) {
      assert(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(item.Severity), 'Unknown severity');
      counts[item.Severity] = (counts[item.Severity] ?? 0) + 1;
      if (['HIGH', 'CRITICAL', 'UNKNOWN'].includes(item.Severity)) {
        const finding = { id: item.VulnerabilityID, package: item.PkgName, version: item.InstalledVersion, severity: item.Severity };
        const assessment = assessNonAffected(report, result, item, context);
        if (assessment) notAffected.push({ ...finding, ...assessment });
        else blocked.push(finding);
      }
    }
  }
  return { counts, blocked, notAffected, passed: blocked.length === 0 };
}
export function validateCapacity(result, seconds) {
  assert.equal(result.status, 'PASS');
  assert.equal(result.cleanup, 'PASS');
  assert.equal(result.options.clients, 100);
  assert(result.options.seconds >= seconds);
  const m = result.measurement;
  assert(m.confirmed > 0);
  assert.equal(m.attempted, m.confirmed);
  assert.equal(m.failed, 0);
  assert.equal(m.asyncErrors, 0);
  assert.equal(m.authorEchoes, 0);
  assert.equal(m.verifiedClients, 100);
  return m;
}
export function validateSdkIdentity(value) {
  assert.equal(value.name, 'ulda-auth');
  assert.equal(value.version, '1.1.0');
  assert.match(value.commit, /^[a-f0-9]{40}$/);
  assert.match(value.sha256, /^[a-f0-9]{64}$/);
}
export function validateLargeCatalog(result, expected, imageId) {
  validateSdkIdentity(expected);
  assert.equal(result.status, 'PASS');
  assert.equal(result.cleanup, 'PASS');
  assert.equal(result.imageId, imageId);
  assert.deepEqual(result.sdk, expected);
  assert.match(result.consumerLockSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.count, 10000);
  assert(result.catalogBytes > 1100000, 'Catalog must exercise fragmented resource transfer');
  assert.equal(result.remainingRows, 0);
  assert.equal(result.asyncErrors, 0);
  assert(!result.databaseError);
  assert.deepEqual(result.checks, ['container-start', 'public-create-65', 'seed-10000', 'connect-10000',
    'peer-connect-10000', 'add-and-changed', 'update-and-changed', 'refresh-10001', 'delete-and-changed', 'super-delete-and-changed']);
}
export function repositoryName(value) {
  assert(typeof value === 'string' && /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value), 'Set an explicit Docker Hub namespace/repository');
  return value;
}
