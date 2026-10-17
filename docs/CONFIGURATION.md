# Configuration reference

Configuration is read at startup. Restart after changing it.
[.env.example](../.env.example) supplies Compose defaults; a standalone Node
process does not automatically load that file. Never commit real credentials.

## Compose and TLS

The table below describes the root **local test** Compose stack. The
[application-only recipe](EXTERNAL_DATABASE.md) instead requires
`ULDA_SERVER_IMAGE`, `ULDA_DATABASE_NETWORK`, `PGHOST`, `ULDA_DB_ADMIN_USER` and
an absolute `ULDA_SECRETS_DIR`. It never builds or starts a database/proxy.

| Variable | Default | Purpose |
| --- | --- | --- |
| POSTGRES_DB | ulda | Dedicated database name |
| POSTGRES_USER | ulda | Bootstrap administrator, not the application account |
| ULDA_SECRETS_DIR | ./secrets | Directory containing the three password files |
| ULDA_SERVER_IMAGE | ulda/server:local | Image used by setup, migrations and runtime |
| ULDA_POSTGRES_IMAGE | ulda/postgres:local | Locally built PostgreSQL test fixture; not a release artifact |
| ULDA_PROXY_IMAGE | ulda/proxy:local | Local slim Nginx test fixture, used with the TLS overlay |
| ULDA_PUBLISH_ADDRESS | 127.0.0.1 | Host address publishing the application's local HTTP port |
| ULDA_SERVER_PORT | 3000 | Host HTTP port; container port remains 3000 |
| ULDA_TLS_CERT_FILE | required with TLS overlay | Certificate chain path on host |
| ULDA_TLS_KEY_FILE | required with TLS overlay | Private-key path on host |
| ULDA_TLS_PUBLISH_ADDRESS | 127.0.0.1 | Host address publishing HTTPS |
| ULDA_TLS_PORT | 443 | HTTPS host port |

New installations need the explicit role setup in [deployment](DEPLOYMENT.md).
The password filenames are `postgres_admin_password`, `postgres_migration_password`
and `postgres_runtime_password`. Compose mounts only the needed secret into each
service. It uses `ulda_migrator` and `ulda_runtime` for migration/application access.

`ULDA_DB_SETUP=1` explicitly authorizes setup; `ULDA_DB_ADOPT_EXISTING=1` is also
required to adopt existing ULDA tables. These are setup-job switches, not normal
server options. `ULDA_MANAGED_ROLES=1` makes the migration job apply the managed
runtime grants. Do not enable them against an unrelated/shared database.

`MIGRATIONS_DIR` selects the migration directory; Compose sets
`/app/migrations/postgres`. Setup reads `ULDA_MIGRATION_PASSWORD_FILE` and
`ULDA_RUNTIME_PASSWORD_FILE` from its service environment. The supplied Compose
file points these to its mounted secrets; the server does not need those files.

## Standalone application

| Variable | Default | Values / behavior |
| --- | --- | --- |
| NODE_ENV | development | development, test, production; Compose sets production |
| SERVER_HOST | 0.0.0.0 | Application bind address |
| SERVER_PORT | 3000 | 1–65535; also honored by the image healthcheck |
| LOG_LEVEL | info | debug, info, warn, error; all use safe diagnostics |
| CORS_ORIGINS | http://localhost:3000 | Comma-separated browser origins; not authentication |
| STORAGE_ADAPTER_MODULE | unset | Trusted ESM adapter replacing PostgreSQL |
| GRACEFUL_SHUTDOWN_TIMEOUT_MS | 10000 | 100–300000; reporting deadline, not SQL cancellation |

The standard image runs `node dist/main.js`. It does not start migrations itself.
Custom adapters own their backend setup and must honor the
[storage contract](../MANIFEST.md#trust-and-deployment); there is no RAM fallback.

## Database connection

Use either a protected `DATABASE_URL`, or the standard PG environment:
`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` and `PGPASSWORD` or
`PGPASSWORD_FILE`. Compose supplies host `postgres`, port 5432 and the appropriate
role. Standalone processes must supply their own deployment values.

`PGPASSWORD_FILE` accepts a nonempty file up to 4096 bytes, strips one trailing
newline and rejects embedded newline/NUL. It cannot be combined with
`PGPASSWORD`, `DATABASE_URL` or `PGSERVICE`. Rotate database passwords and mounted
files together, then restart readers. File secrets are not an encrypted vault.

| Variable | Default | Range / effect |
| --- | ---: | --- |
| DATABASE_POOL_MAX | 10 | 1–100; Compose migration pool uses 2 |
| DATABASE_CONNECTION_TIMEOUT_MS | 5000 | 100–300000; connection establishment/pool checkout |
| DATABASE_IDLE_TIMEOUT_MS | 30000 | 1000–3600000; idle pooled clients |
| DATABASE_STATEMENT_TIMEOUT_MS | 10000 | 100–3600000; PostgreSQL statement timeout |
| DATABASE_LOCK_TIMEOUT_MS | 5000 | 100–3600000; PostgreSQL lock wait |
| DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS | 10000 | 100–3600000; PostgreSQL idle transaction |

URL/session options are trusted operator configuration and may override driver
settings. Avoid conflicting timeout options and verify effective PostgreSQL
values. SQL limits are per statement, not a whole-batch deadline or proof of
rollback after a lost COMMIT response. [Timeout semantics](OPERATIONS.md).

## Readiness

| Variable | Default | Range |
| --- | ---: | --- |
| READINESS_TIMEOUT_MS | 2000 | 100–30000 ms |
| READINESS_CACHE_MS | 1000 | 0–30000 ms; 0 disables caching |
| READINESS_MAX_WAITERS | 32 | 1–1000 |

Readiness shares one actual storage probe and bounds HTTP waiters. A deadline
answers callers without releasing the still-running storage probe.
[Full readiness behavior](OPERATIONS.md#http-probes).

## ULDA profile

| Variable | Default | Meaning |
| --- | --- | --- |
| ULDA_PROTOCOL_VERSION | 1.0 | Only 1.0 accepted |
| ULDA_CORE_VERSION | 1.0.1 | Configuration metadata; does not install a different core |
| ULDA_PACK | compactV1 | Only Compact V1 accepted |
| ULDA_N | 5 | 2–255 in configuration; keep 5 for the documented SDK profile |
| ULDA_MODE | S | S or X profile metadata; SDK can use X/S resources |
| ULDA_HASH | SHA-256 | Only SHA-256 accepted |
| ULDA_ORIGIN_SIZE | 256 | 8–65536; needed by Compact V1 verification; keep 256 for this SDK |
| ULDA_AGE_BYTES | 4 | Only 4 accepted |

These options are not negotiated by the SDK Hello response. Create does not
verify the initial generation profile or ownership. The runtime uses the exact
core dependency pinned in package/lock files. Changing metadata cannot substitute
another algorithm implementation.

## Message and admission bounds

`MAX_WITNESS_BYTES` defaults to 16384 (configurable 1–1048576), but the SDK
endpoint caps a witness at the smaller of that value and **167 bytes**.
`MAX_SOCKET_MESSAGE_BYTES` defaults to 67108864 (1024–134217728), but the SDK
Engine.IO frame cap is the smaller of that value and **1100000 bytes**.
The larger configuration defaults also serve explicit historical legacy tools;
they do not expand SDK wire limits.

All remaining `MAX_*`, command-rate, burst and reconstruction-timeout settings
are listed in [admission limits](ADMISSION_LIMITS.md#settings).
Invalid unsigned-decimal values fail startup. No automatic retries are introduced
by raising a budget.

The supplied Compose file interpolates the newer connection/input/read/output,
rate/pending/assembly budgets. It does not forward `MAX_WITNESS_BYTES`,
`MAX_SOCKET_MESSAGE_BYTES`, `MAX_QUEUED_TOTAL`, `MAX_QUEUED_PER_RESOURCE` or
`MAX_SUBSCRIPTIONS_PER_SOCKET` from `.env`. Add those to the server service's
`environment` in a Compose override to change them. Likewise, standalone bind,
profile, pool and log settings are not automatically forwarded unless explicitly
interpolated in compose.yaml. A line in `.env` alone does not set a container
environment variable.

Compose also fixes server/PostgreSQL CPU, RAM and PID budgets, heap size and
database connection limits. Review [deployment sizing](DEPLOYMENT.md#resource-budgets-readiness-and-monitoring)
before changing them. Application accounting budgets are not exact RSS limits.
