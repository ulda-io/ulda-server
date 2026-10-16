// Destructive suites must opt in and use an explicitly named disposable DB.
export function requireTestDatabase(env = process.env) {
  let url;
  try { url = new URL(env.ULDA_TEST_DATABASE_URL); } catch { /* fixed error below */ }
  if (env.ULDA_TEST_ALLOW_RESET !== "1" || !url ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]", "postgres"].includes(url.hostname) ||
      !/^\/ulda_test_[a-z0-9_]{1,48}$/.test(url.pathname)) {
    throw new Error("Set ULDA_TEST_DATABASE_URL to a disposable database named ulda_test_* and ULDA_TEST_ALLOW_RESET=1.");
  }
  return env.ULDA_TEST_DATABASE_URL;
}
