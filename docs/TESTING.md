# Testing

Use Node.js 22 or later. Install both lockfiles from the repository root:

```powershell
npm ci --ignore-scripts
npm ci --prefix test/consumer --ignore-scripts
```

The server and the SDK consumer have separate dependencies. The consumer pins
ulda-auth@1.0.1 from npm and imports its public exports; no adjacent checkout or
private SDK implementation is required. The SDK is not a server runtime dependency.

## Local checks

```powershell
npm run check
npm run test:tools
```

The first command runs TypeScript checks, unit/Socket.IO tests and the production
build. These tests use controlled fakes or explicitly selected in-memory storage;
they do not establish PostgreSQL persistence or production performance. The second
command verifies safeguards around disposable databases and private test diagnostics.

## PostgreSQL, SDK and container integration

With a running Linux Docker engine:

```powershell
npm run test:integration
```

This command builds a test image, creates an isolated network and disposable
PostgreSQL database with a generated password, runs the database and published
SDK suites, verifies container restrictions, and tests server/database restarts.
See [integration details](PUBLISHED_SDK_TESTS.md). It does not use an application
.env file or existing database. Cleanup checks ownership labels before removing
its containers, anonymous volumes and network. The test image is retained locally.

## Deployment and recovery

```powershell
npm run test:deployment
```

The [deployment drill](DEPLOYMENT.md#reproduce-the-local-deployment-drill) uses
separate temporary Compose projects to verify database privileges, HTTPS/WSS,
limits, backup/restore, outage handling and SDK access after recovery. It uses a
local test certificate, not an operator's certificate or database. Summary files
remain under ignored .local directories. Review a failed run before removing its
retained diagnostic material.

## Image review

Run the [container checks and full vulnerability scan](CONTAINER_SECURITY.md#reproduce-container-checks)
against the exact image intended for deployment. Unit tests do not inspect OS
vulnerabilities, certify dependency security or validate a different image digest.
Do not put real passwords, private keys, connection strings, payloads or origins
in test fixtures, reports or public logs.

## Performance and release acceptance

The unit and integration suites are correctness checks, not throughput benchmarks.
Release acceptance also requires sustained load against the final image and a
specified database/CPU/memory/TLS configuration. The target baseline is 100
connections, 200 updates per second on independent resources with about 1 KiB of
JSON, for 30 minutes, with p95 at most one second and no unexpected errors.
Count scheduled work, confirmed operations and generator drops separately; also
observe memory, queues, slow receivers and recovery after overload.

This target is an acceptance criterion, not a published measurement or a universal
capacity guarantee. Historical benchmark applications and machine-specific results
are not included in this source distribution. A reproducible load campaign for the
final release image is separate work; do not substitute a unit-test result for it.
