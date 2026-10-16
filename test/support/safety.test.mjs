import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { requireTestDatabase } from "./test-database.mjs";
import report from "./safe-reporter.mjs";

test("destructive tests require both explicit reset consent and a disposable database name", () => {
  const env = { ULDA_TEST_DATABASE_URL: "postgres://user:synthetic@127.0.0.1:5432/ulda_test_checks", ULDA_TEST_ALLOW_RESET: "1" };
  assert.equal(requireTestDatabase(env), env.ULDA_TEST_DATABASE_URL);
  for (const bad of [{ ...env, ULDA_TEST_ALLOW_RESET: "0" }, { ...env, ULDA_TEST_DATABASE_URL: env.ULDA_TEST_DATABASE_URL.replace("ulda_test_checks", "application") },
    { ...env, ULDA_TEST_DATABASE_URL: env.ULDA_TEST_DATABASE_URL.replace("127.0.0.1", "example.com") }, { ...env, ULDA_TEST_DATABASE_URL: "synthetic-secret-invalid-url" }]) {
    assert.throws(() => requireTestDatabase(bad), error => !error.message.includes("synthetic") && !error.message.includes("postgres://"));
  }
});

test("test reporter suppresses names, errors, raw output and assertion values", async () => {
  const secret = "synthetic-private-marker";
  const events = [
    { type: "test:stdout", data: { message: secret } }, { type: "test:stderr", data: { message: secret } },
    { type: "test:diagnostic", data: { message: secret } },
    { type: "test:fail", data: { file: resolve("test/e2e/sdk.test.mjs"), line: 50, name: secret, details: { error: new Error(secret), actual: secret } } },
    { type: "test:summary", data: { counts: { tests: 1, failed: 1 } } },
  ];
  let output = ""; for await (const chunk of report(events)) output += chunk;
  assert.equal(output.includes(secret), false);
  assert.ok(output.includes("FAIL test/e2e/sdk.test.mjs:50"));
  assert.ok(output.includes("failed: 1"));
});
