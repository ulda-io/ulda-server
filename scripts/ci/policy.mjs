import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { assessNonAffected } from './vulnerability-assessment.mjs';

export const names = ['server', 'postgres', 'proxy'];
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
  assert.equal(manifest.schema, 1);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.platform, 'linux/amd64');
  if (manifest.releaseAcceptance) assert.equal(manifest.sourceClean, true, 'Release source checkout was not clean');
  assert(versionPattern.test(manifest.version));
  assert.deepEqual(Object.keys(manifest.images).sort(), [...names].sort());
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
export function repositoryName(value) {
  assert(typeof value === 'string' && /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value), 'Set an explicit Docker Hub namespace/repository');
  return value;
}
