import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { names, sha256, validateIdentity, validateManifest, repositoryName, imageContentIdentity } from './policy.mjs';

const root = process.cwd();
const capture = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
const git = (...args) => capture('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args]);
const version = validateIdentity(JSON.parse(fs.readFileSync('package.json')), JSON.parse(fs.readFileSync('package-lock.json')), process.env);
const commit = git('rev-parse', 'HEAD');
git('merge-base', '--is-ancestor', 'HEAD', 'origin/main');
if (process.argv[2] === 'identity') {
  console.log(`PASS release identity ${version}; source commit belongs to main.`);
} else if (process.argv[2] === 'publish') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publishing is restricted to the reviewed GitHub job');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  assert.equal(process.env.GITHUB_REF_TYPE, 'tag');
  const manifestFile = '.local/ci-images/manifest.json';
  assert.equal(await sha256(manifestFile), process.env.ULDA_MANIFEST_SHA256, 'Manifest checksum mismatch');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  validateManifest(manifest, commit);
  assert.equal(manifest.version, version);
  assert.equal(manifest.releaseAcceptance, true, 'Release acceptance was not performed');
  assert(manifest.capacity.seconds >= 1800 && manifest.capacity.clients === 100);
  const repos = Object.fromEntries(names.map(name => [name, repositoryName(process.env[`ULDA_DOCKER_${name.toUpperCase()}`])]));
  assert.equal(new Set(Object.values(repos)).size, 3, 'Use separate repositories for the three images');
  const request = async url => fetch(url, { signal: AbortSignal.timeout(30000) });
  async function registryManifest(repository, tag) {
    const tokenResponse = await request('https://auth.docker.io/token?service=registry.docker.io&scope=' + encodeURIComponent(`repository:${repository}:pull`));
    assert(tokenResponse.ok, 'Registry authentication service unavailable');
    const { token } = await tokenResponse.json();
    assert(typeof token === 'string' && token.length > 0);
    return fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
      signal: AbortSignal.timeout(30000),
    });
  }
  // Check every archive and every remote version before the first write.
  for (const name of names) {
    assert.equal(await sha256(`.local/ci-images/${manifest.images[name].archive}`), manifest.images[name].sha256);
    const existing = await registryManifest(repos[name], version);
    assert.equal(existing.status, 404, 'Version exists, repository is private, or registry preflight failed; do not overwrite/retry blindly');
    const body = await existing.json();
    assert(body.errors?.some(e => ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'].includes(e.code)), 'Unexpected registry response');
  }
  const receipt = { schema: 1, commit, version, platform: manifest.platform, images: {}, smoke: 'PENDING' };
  const config = path.resolve(process.env.DOCKER_CONFIG ?? '');
  assert.equal(config, path.resolve(process.env.RUNNER_TEMP, 'ulda-registry-auth'));
  assert(!fs.existsSync(config), 'Registry credential directory must be fresh');
  fs.mkdirSync(config, { recursive: true });
  let phase = 'login';
  try {
    assert(process.env.DOCKERHUB_USERNAME && process.env.DOCKERHUB_TOKEN, 'Missing Docker Hub credentials');
    capture('docker', ['login', 'docker.io', '--username', process.env.DOCKERHUB_USERNAME, '--password-stdin'], { input: process.env.DOCKERHUB_TOKEN + '\n' });
    delete process.env.DOCKERHUB_TOKEN;
    for (const name of names) {
      phase = `publish-${name}`;
      const item = manifest.images[name], target = `${repos[name]}:${version}`;
      capture('docker', ['load', '--input', `.local/ci-images/${item.archive}`]);
      assert.equal(imageContentIdentity(JSON.parse(capture('docker', ['image', 'inspect', item.tag]))[0]), item.contentIdentity);
      capture('docker', ['tag', item.tag, target]);
      capture('docker', ['push', target]);
      const response = await registryManifest(repos[name], version);
      assert(response.ok, 'Pushed manifest could not be read');
      const digest = response.headers.get('docker-content-digest');
      assert.match(digest, /^sha256:[a-f0-9]{64}$/);
      let remote = await response.json();
      if (remote.manifests) {
        const platforms = remote.manifests.filter(m => m.platform?.os !== 'unknown');
        assert.equal(platforms.length, 1, 'Unexpected published platform');
        assert.equal(platforms[0].platform.os, 'linux'); assert.equal(platforms[0].platform.architecture, 'amd64');
        assert.match(platforms[0].digest, /^sha256:[a-f0-9]{64}$/);
        const platformResponse = await registryManifest(repos[name], platforms[0].digest);
        assert(platformResponse.ok); remote = await platformResponse.json();
      }
      assert.equal(remote.config.digest, item.configId, 'Registry image differs from checked image');
      const reference = `${repos[name]}@${digest}`;
      capture('docker', ['pull', '--platform', 'linux/amd64', reference]);
      assert.equal(imageContentIdentity(JSON.parse(capture('docker', ['image', 'inspect', reference]))[0]), item.contentIdentity);
      receipt.images[name] = { reference, configId: item.configId, contentIdentity: item.contentIdentity };
      fs.writeFileSync('.local/ci-published.json', JSON.stringify(receipt, null, 2) + '\n');
      console.log(`PASS ${name}: registry digest and pulled image match checked artifact.`);
    }
  } catch {
    console.error(`FAIL ${phase}; check registry state before retrying. A partial release is possible; existing versions will not be overwritten.`);
    process.exitCode = 1;
  } finally {
    delete process.env.DOCKERHUB_TOKEN;
    try { capture('docker', ['logout', 'docker.io']); } catch { /* Remove our isolated credential directory regardless. */ }
    assert.equal(fs.realpathSync(config), config);
    fs.rmSync(config, { recursive: true });
  }
} else {
  throw new Error('Expected identity or publish');
}
