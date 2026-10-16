# Integration with the published SDK

The current integration entrypoint is `npm run test:integration`. It works from
this repository alone and requires Node.js 22+, npm and a running Docker engine.
It does not read the operator's `.env` or use an existing application database.

```powershell
npm ci --ignore-scripts
npm ci --prefix test/consumer --ignore-scripts
npm run test:integration
```

`test/consumer/package.json` pins `ulda-auth@1.0.1`; its separate lockfile pins
transitive dependencies and npm archive integrity. Only this test consumer
installs the client SDK. The server's production dependencies, crypto boundary
and runtime image do not gain SDK code. A missing consumer fails explicitly;
there is no adjacent checkout fallback in these tests. `ULDA_SDK_CONSUMER` does
not override this release integration path.

The command runs server typecheck/unit/build, test-safety checks, a self-contained
Docker build and five container regressions. It creates a unique Docker network
and PostgreSQL database, runs real database faults and SDK tests, then checks the
built container with two SDK clients, X/S content and server/database restarts.
The server runs as non-root with the same filesystem/capability restrictions as
the standard Compose configuration. Test-only raw reads use the documented
Socket.IO protocol to compare ciphertext fingerprints; no private SDK imports.

The temporary database has a random password and a loopback-only host port for
native tests. Its data is disposable. Cleanup verifies a unique Docker label
before removing test containers/anonymous volumes and the test network. The local
test image is retained for inspection; it is never published or deployed over the
operator's image. Summary JSON files are written under `.local/integration-*`.
Set `ULDA_TEST_IMAGE` to a previously reviewed local image to skip rebuilding;
the suite resolves and uses its immutable local image ID. The deployment drill
accepts the same option, so its tests can validate the exact scanned artifact.
`ULDA_TEST_POSTGRES_IMAGE` selects the reviewed database image; the deployment
drill also accepts `ULDA_TEST_PROXY_IMAGE`. Otherwise each runner builds its own
uniquely named auxiliary images from `deploy/`. References resolve to immutable
local IDs recorded in the report. Tests do not inherit the operator's Compose
image variables. See [auxiliary image checks](AUXILIARY_IMAGES.md).
Do not run multiple writers against the same database outside these sequential
test phases.

## Run suites against an explicitly provided test database

The automated entrypoint above handles provisioning. For manual CI provisioning,
use a dedicated database whose name begins with `ulda_test_` and explicitly set
`ULDA_TEST_ALLOW_RESET=1`. Supported test hosts are loopback and the Docker service
name `postgres`. These safeguards prevent common mistakes, not a malicious test
operator. The tests truncate their table and inject failures.

```powershell
$env:ULDA_TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:PORT/ulda_test_checks'
$env:ULDA_TEST_ALLOW_RESET='1'
npm run test:postgres
npm run test:sdk
```

Never supply an application database. Both suites apply migrations; repeat
migration is checked. SDK files run sequentially because they share one test
namespace. Optional `ULDA_TEST_RESULTS_DIR` stores numeric fan-out/crash results;
it is not used for payloads, passwords, witnesses or origins.

## Coverage and safe diagnostics

- Public import, ready/hello, registration and opening existing data; X/S
  lifecycle, direct updates, mixed deletion, superDelete and explicit recovery.
- Two clients, no author echo, conflict with controlled barriers, unrelated
  writes progressing, no partial publication of bad Read/Changed arrays.
- Late invalid members, subscription and input limits before mutation, cleanup
  of connection/subscription/reservation state.
- Lost Create/Update/recovery ACK, uncertain COMMIT, bounded reconnect without
  mutation replay and a real process exit after COMMIT before ACK/Changed.
- PostgreSQL rollback/connection/timeout tests; identical persisted encrypted
  records after fresh server creation and container restarts.

The Node test reporter emits pass/fail source locations and counts. It suppresses
test stdout/stderr, names, raw assertions, stacks and error objects. The Docker
runner also suppresses child-process diagnostics and records the failed phase.
Investigate a failure locally with synthetic data; do not enable raw CI output
for real credentials or private application state.

The process-exit helper is explicitly test-only. This suite does not measure
sustained throughput or browser behavior. Backup/restore has a separate deployment
drill. See [Testing](TESTING.md) for commands and the limits of each suite.
