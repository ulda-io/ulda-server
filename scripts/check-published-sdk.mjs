// Reproducible integration on task-owned Docker resources only. Never uses .env
// or the operator's database/server URL. Invoke through npm run test:integration.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const id = randomUUID().replaceAll("-", ""), label = `io.ulda.integration=${id}`;
const network = `ulda-test-${id}`, db = `${network}-db`, app = `${network}-server`;
const image = `ulda/server:sdk-check-${id}`, folder = path.join(root, ".local", `integration-${id}`);
fs.mkdirSync(folder, { recursive: true });
const env = { ...process.env, POSTGRES_USER: "ulda_test", POSTGRES_DB: `ulda_test_${id}`,
  POSTGRES_PASSWORD: randomUUID(), ULDA_TEST_ALLOW_RESET: "1", ULDA_TEST_RESULTS_DIR: folder };
delete env.DATABASE_URL; delete env.ULDA_TEST_DATABASE_URL; delete env.ULDA_SDK_CONSUMER;
const result = { status: "RUNNING", sdk: "ulda-auth@1.0.1", checks: [], image, platform: process.platform, node: process.version };
let phase = "prerequisites", networkCreated = false;
async function run(file, args, { timeout = 180000, safeOutput = false, includeStderr = false } = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(file, args, { cwd: root, env, timeout,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (safeOutput) process.stdout.write(stdout);
    return (includeStderr ? stdout + stderr : stdout).trim();
  } catch (error) {
    // Only our Node reporter's fixed output is safe. Never print Docker/SQL errors.
    if (safeOutput && typeof error.stdout === "string") process.stdout.write(error.stdout);
    throw new Error("Integration command failed; private diagnostics suppressed.");
  }
}
const docker = (...args) => run("docker", args);
const inspect = async (name, field) => JSON.parse(await docker("inspect", name, "--format", `{{json ${field}}}`));
const passed = message => { result.checks.push(message); console.log(`PASS ${message}`); };
async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  do { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
  throw new Error("Integration state deadline exceeded.");
}
async function appReady() {
  const ports = await inspect(app, ".NetworkSettings.Ports");
  env.ULDA_SERVER_URL = `http://127.0.0.1:${ports["3000/tcp"][0].HostPort}`;
  await until(async () => { const response = await fetch(env.ULDA_SERVER_URL + "/ready", { signal: AbortSignal.timeout(3000) }); await response.arrayBuffer(); return response.status === 200; });
}
async function main() {
  assert.ok(process.env.npm_execpath, "Invoke through npm run test:integration.");
  const consumer = await import("../test/consumer/index.mjs");
  assert.equal(consumer.sdkIdentity.version, "1.0.1");
  result.consumerLockSha256 = createHash("sha256").update(fs.readFileSync("test/consumer/package-lock.json")).digest("hex");
  result.sdkIntegrity = JSON.parse(fs.readFileSync("test/consumer/package-lock.json")).packages["node_modules/ulda-auth"].integrity;
  passed("isolated published SDK import");
  phase = "server-check";
  // build's clean is confined to this checkout, never a linked dist directory.
  if (fs.existsSync("dist")) assert.equal(fs.realpathSync("dist"), path.resolve("dist"));
  await run(process.execPath, [process.env.npm_execpath, "run", "check"]);
  await run(process.execPath, ["--test", "test/support/safety.test.mjs"]);
  passed("server typecheck/unit/build and test safety checks");
  phase = "image-build";
  await docker("build", "-t", image, ".");
  result.imageId = await docker("image", "inspect", image, "--format", "{{.Id}}");
  env.ULDA_TEST_IMAGE = image;
  await run(process.execPath, ["--test", "test/container/image.test.mjs", "test/container/context.test.mjs"]);
  passed("self-contained image build and container regressions");
  phase = "disposable-database";
  await docker("network", "create", "--label", label, network); networkCreated = true;
  await docker("run", "--detach", "--name", db, "--label", label, "--network", network, "--network-alias", "postgres",
    "--publish", "127.0.0.1::5432", "--mount", "type=volume,destination=/var/lib/postgresql", "-e", "POSTGRES_USER", "-e", "POSTGRES_DB", "-e", "POSTGRES_PASSWORD", "postgres:18.4-bookworm");
  await until(async () => (await docker("exec", db, "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-At", "-c", "SELECT 1")) === "1");
  const ports = await inspect(db, ".NetworkSettings.Ports");
  env.ULDA_TEST_DATABASE_URL = `postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@127.0.0.1:${ports["5432/tcp"][0].HostPort}/${env.POSTGRES_DB}`;
  phase = "postgres-faults";
  await run(process.execPath, [process.env.npm_execpath, "run", "test:postgres"]);
  passed("real PostgreSQL atomicity and fault suite");
  phase = "sdk-lifecycle-and-faults";
  await run(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=./test/support/safe-reporter.mjs",
    "test/e2e/sdk.test.mjs", "test/e2e/release-faults.test.mjs"], { safeOutput: true });
  assert.equal(await docker("exec", db, "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-At", "-c", "SELECT count(*) FROM public.ulda_resources"), "0");
  passed("published SDK lifecycle/fault suites and test row cleanup");
  env.PGHOST = "postgres"; env.PGPORT = "5432"; env.PGUSER = env.POSTGRES_USER;
  env.PGDATABASE = env.POSTGRES_DB; env.PGPASSWORD = env.POSTGRES_PASSWORD;
  const appFlags = ["--label", label, "--network", network, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128",
    "-e", "PGHOST", "-e", "PGPORT", "-e", "PGUSER", "-e", "PGDATABASE", "-e", "PGPASSWORD"];
  phase = "container-migration";
  await docker("run", "--rm", ...appFlags, image, "node", "dist/cli/migrate-postgres.js");
  phase = "container-start";
  await docker("run", "--detach", "--init", "--name", app, ...appFlags, "--publish", "127.0.0.1::3000", image);
  await appReady(); env.ULDA_SMOKE_STATE_FILE = path.join(folder, "smoke-state.json");
  phase = "container-prepare";
  await run(process.execPath, ["scripts/container-sdk-smoke.mjs", "prepare"], { safeOutput: true });
  phase = "container-stop";
  await docker("stop", "--timeout", "20", app);
  assert.equal(await inspect(app, ".State.ExitCode"), 0);
  phase = "container-restart";
  await docker("start", app); await appReady();
  phase = "container-read";
  await run(process.execPath, ["scripts/container-sdk-smoke.mjs", "check"], { safeOutput: true });
  phase = "database-restart";
  await docker("restart", "--timeout", "20", db);
  await until(async () => (await docker("exec", db, "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-At", "-c", "SELECT 1")) === "1");
  await appReady();
  phase = "container-cleanup";
  await run(process.execPath, ["scripts/container-sdk-smoke.mjs", "cleanup"], { safeOutput: true });
  assert.equal(await docker("exec", db, "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-At", "-c", "SELECT count(*) FROM public.ulda_resources"), "0");
  phase = "container-canaries";
  const logs = await run("docker", ["logs", app], { includeStderr: true });
  for (const marker of [env.POSTGRES_PASSWORD, "synthetic-container-smoke-passphrase", "synthetic container integration", "container-check"]) assert.equal(logs.includes(marker), false);
  passed("container X/S, two clients, server/DB restart, ciphertext persistence and cleanup");
  result.status = "PASS";
}
try { await main(); }
catch { result.status = "FAIL"; result.failedPhase = phase; process.exitCode = 1; console.error(`FAIL ${phase}; private diagnostics suppressed.`); }
finally {
  try {
    const owned = (await docker("ps", "--all", "--quiet", "--filter", `label=${label}`)).split(/\s+/).filter(Boolean);
    for (const container of owned) {
      assert.equal((await inspect(container, ".Config.Labels"))["io.ulda.integration"], id);
      await docker("rm", "--force", "--volumes", container);
    }
    if (networkCreated) {
      const networks = JSON.parse(await docker("network", "inspect", network));
      assert.equal(networks[0].Labels["io.ulda.integration"], id); await docker("network", "rm", network);
    }
    result.cleanup = "PASS";
  } catch { result.cleanup = "FAIL"; result.status = "FAIL"; process.exitCode = 1; console.error("FAIL test resource cleanup; inspect the run label."); }
  fs.writeFileSync(path.join(folder, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`Integration ${result.status}; report: ${path.relative(root, path.join(folder, "result.json"))}`);
}
