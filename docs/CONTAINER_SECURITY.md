# Container runtime policy

The default stack contains one application server, PostgreSQL on a private
network, and a one-shot migration job. Applications install `ulda-auth` on the
client and connect to the server URL. The server uses `ulda-core` verification;
it does not need client passwords, origins, decryptors or a catalog hierarchy.

## Local setup and network boundary

For a new volume, follow [deployment setup](DEPLOYMENT.md): create mounted password
files, build, start PostgreSQL, explicitly initialize roles, then start the stack.
PostgreSQL has no published port. Data lives in
the PostgreSQL volume; the server container does not need writable data storage.
Do not use `docker compose down -v` for data you need to keep.

`ULDA_PUBLISH_ADDRESS` defaults to `127.0.0.1`; `ULDA_SERVER_PORT` defaults to
`3000`. These configure host publication. Inside Compose, the application listens
on `0.0.0.0:3000` so Docker networking can reach it. A standalone image honors
`SERVER_PORT`, including its built-in readiness healthcheck.

For remote clients, configure a TLS reverse proxy and appropriate network and
abuse controls. A proxy in another container reaches the server through a shared
Docker network, not through that proxy container's loopback. Explicitly publishing
on `0.0.0.0` exposes a plaintext service unless the surrounding deployment protects
it. CORS is not authorization. A [TLS proxy override](DEPLOYMENT.md#httpswss-proxy)
removes that direct port and supplies configurable upstream limits.

## Application container restrictions

The image uses the official Node 24 Alpine variant, pinned by image digest, and
runs as `node`, with root-owned application code and dependencies. It removes
setuid/setgid permissions from system executables; the service does not need
privileged user or mount utilities. The standard Compose server and migrator
both use:

- `read_only: true`;
- `cap_drop: [ALL]`;
- `security_opt: [no-new-privileges:true]`;
- `pids_limit: 128`.

These Compose settings are not implicit properties of an arbitrary `docker run`.
The PID limit counts runtime threads as well as processes; it is not a memory
limit. Read-only storage does not constrain in-memory data or network access.
These controls reduce privileges; they do not isolate application secrets from
a compromised host or replace the server's request budgets.

The build context permits only package/TypeScript build files, TypeScript source
and PostgreSQL SQL migrations, plus LICENSE.md and THIRD_PARTY_NOTICES.md.
Dependency license/notice files remain in node_modules; the runtime includes the
server license and dependency index under /app. Other files, including local configuration, tests,
reports and Git history, stay outside it. This is not a secret scanner: a secret
written into an allowed source file would still be included.

The build applies available Alpine updates with `apk upgrade --no-cache`.
The APK package database is retained for component identification and scanning.
Production dependencies install with
`npm ci --omit=dev --ignore-scripts`. The runtime removes the bundled npm, npx,
Yarn and Corepack tools; use `node dist/main.js` and
`node dist/cli/migrate-postgres.js`, not `npm start` inside the container. Build
tools and the client SDK are not application runtime dependencies.

Alpine uses musl rather than glibc. The supplied JavaScript/PostgreSQL adapter is
tested with this runtime. Custom native extensions must support this libc and
the chosen architecture; do not copy glibc-built native modules into the image.
Only tested architectures should be advertised for a release. Updating the base
digest or OS packages requires a fresh build, full scan and integration checks.

## Database privileges and remaining release gates

`POSTGRES_USER` is the bootstrap administrator. The server uses `ulda_runtime`
with resource CRUD and sequence usage only; `ulda_migrator` owns the ULDA schema
objects. Separate secret files are mounted only into the services that need them.
Setup/adoption is explicit and never automatic on an existing volume. See the
[role, backup and restore procedures](DEPLOYMENT.md).

The deployment drill covers a small backup/restore and local TLS configuration.
Production resource sizing, recovery objectives, certificate operations and final
immutable image acceptance remain release work. A single application writer is
mandatory. Review the complete vulnerability report for the exact image being
deployed; passing application tests is not a clean vulnerability scan.

## Reproduce container checks

From the repository root, with Docker available:

```powershell
docker build --pull --no-cache -t ulda/server:security-check .
$env:ULDA_TEST_IMAGE='ulda/server:security-check'
node --test test/container/image.test.mjs test/container/context.test.mjs
```

The tests use synthetic canaries and temporary containers. The context test
creates and removes only its own temporary files. Use a fresh tag to avoid
replacing a working image. An uncached build refreshes Alpine package indexes;
`--pull` alone does not invalidate a previously cached update layer.

Docker Scout requires Docker authentication and can send component metadata to
Docker's service. Where authorized, run the full report first:

```powershell
docker scout cves local://ulda/server:security-check
docker scout cves local://ulda/server:security-check --only-fixed --only-severity critical,high --exit-code
```

The second command is only a fixable-high/critical check. It can pass while the
full report still contains unfixed findings. Review the exact image digest and
all applicable findings before release; rebuild, rescan and retest new images.

To test the same local artifact rather than rebuilding it, set `ULDA_TEST_IMAGE`
before `npm run test:integration` or `npm run test:deployment`. Both resolve the
reference to a local image ID before use. A clean scan applies to that artifact
and the scanner database at that time, not to every future build or the separate
PostgreSQL/Nginx images. Do not suppress findings by deleting package metadata.

The [auxiliary image policy](AUXILIARY_IMAGES.md) describes the separate
PostgreSQL and Nginx builds, remaining package-level exposure and checks for
updating an existing PostgreSQL 18 volume.
