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
npm run test:ci
npm run audit:source
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
specified database/CPU/memory/TLS configuration. The release workflow uses 100
connections and independent resources with about 1 KiB of JSON for 30 minutes,
without a target update rate. It requires no unexpected or uncertain writes and
checks all final states. Inspect the latency and resource results before approval;
shared CI runner throughput is not a production capacity guarantee.

Historical benchmark applications and machine-specific results are not included
in this source distribution. The [capacity runner](CAPACITY_TESTING.md) uses a
disposable stack. A separate fixed-arrival-rate experiment is needed to establish
an SLA such as 200 updates/s with p95 at most one second; closed-loop saturation
does not prove it. See the [release procedure](RELEASING.md).
