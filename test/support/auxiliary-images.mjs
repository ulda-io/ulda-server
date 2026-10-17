import assert from "node:assert/strict";

// Test overrides are explicit. Never reuse an operator's Compose image setting.
export async function auxiliaryImages(docker, suffix, withProxy = false) {
  const images = {};
  for (const name of withProxy ? ["postgres", "proxy"] : ["postgres"]) {
    const requested = process.env[`ULDA_TEST_${name.toUpperCase()}_IMAGE`];
    assert.ok(!requested || !requested.startsWith("-"), "Invalid test image reference.");
    const reference = requested || `ulda/${name}:test-${suffix}`;
    if (!requested) await docker("build", "-t", reference, name === 'proxy' ? 'test/fixtures/tls/proxy' : `deploy/${name}`);
    const id = await docker("image", "inspect", reference, "--format", "{{.Id}}");
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    images[name] = { reference, id };
  }
  return images;
}
