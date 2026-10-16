# Readiness, database timeouts and shutdown

Run one application process as the only writer to its PostgreSQL namespace.
These operational controls do not add authentication or change the SDK wire format.

## HTTP probes

- `GET /health` reports that the HTTP process responds. It does not query PostgreSQL.
- `GET /ready` returns 200 with `{"ok":true}` when the shared storage check succeeds,
  or 503 with `{"ok":false,"code":"not_ready"}` when unavailable, saturated or stopping.

Concurrent readiness requests share one storage operation. Its success or failure
is cached briefly. Only a bounded number of HTTP callers wait for it; excess
callers receive 503 immediately. A deadline answers existing callers with 503.
The storage slot remains occupied until that actual operation settles, even after
the deadline or shutdown. A late success after a deadline is not accepted as a new
ready result: a fresh check is required. There is no background polling loop.

| Variable | Default | Allowed values |
| --- | --- | --- |
| `READINESS_TIMEOUT_MS` | 2000 | 100–30000 ms |
| `READINESS_CACHE_MS` | 1000 | 0–30000 ms; 0 disables caching |
| `READINESS_MAX_WAITERS` | 32 | 1–1000 |

A cached success can be up to `READINESS_CACHE_MS` old. It is a readiness hint,
not a guarantee that the next operation will succeed. `/ready` is not a login and
does not change Socket.IO subscriptions. `ulda:hello` keeps its existing meaning:
the router is accepting commands; it does not run this database probe.

Keep probes on an internal network or restrict them at the reverse proxy. This
limit bounds pending probe work, not all HTTP/TCP connections, body bytes or OS
buffers. Use proxy connection/rate/time limits as well. Container healthcheck
timeouts should exceed `READINESS_TIMEOUT_MS`; defaults use 3 seconds and 2 seconds.

## PostgreSQL policy

The built-in pool sets these PostgreSQL session parameters for both the runtime
and the migration CLI:

| Variable | Default | PostgreSQL parameter |
| --- | --- | --- |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 10000 | `statement_timeout` |
| `DATABASE_LOCK_TIMEOUT_MS` | 5000 | `lock_timeout` |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 10000 | `idle_in_transaction_session_timeout` |

Each value must be 100–3600000 ms. The existing
`DATABASE_CONNECTION_TIMEOUT_MS` (default 5000 ms) bounds connection establishment
and pool checkout. `DATABASE_IDLE_TIMEOUT_MS` controls unused pooled clients; it
does not cancel a SQL query or an open transaction.

SQL cancellation is performed by PostgreSQL. We do not set the driver's
client-side `query_timeout` or release mutation locks on a `Promise.race` deadline.
For PostgreSQL semantics, see [client connection defaults](https://www.postgresql.org/docs/18/runtime-config-client.html#RUNTIME-CONFIG-CLIENT-STATEMENT).
The corresponding driver options are documented in [node-postgres](https://node-postgres.com/apis/client).

Configure a lock timeout shorter than the statement timeout if lock waits need a
distinct, earlier limit. Statement timeout is per SQL statement, not per SDK batch.
A database/network partition may prevent the driver from receiving any result,
including a timeout response. Custom adapters must implement their own bounded
I/O and preserve the server's atomic completion contract.

Treat database connection strings and PostgreSQL session configuration as trusted
operator input. Driver-supported URL parameters can override pool options; do not
add conflicting timeout settings to `DATABASE_URL`. Verify the effective settings
with `SHOW` when deploying through custom connection URLs or proxies.

Migrations may need larger values than ordinary requests for a large existing
database. Set appropriate values on the migration job; do not disable safeguards
globally. The CLI handles pool/client error events, discards failed clients and
attempts pool cleanup even if client release fails. It reports ready only after
cleanup succeeds. Failure has exit code 1 with [safe diagnostics](LOGGING.md).
Some earlier migration files may already have committed; inspect the migration
ledger before proceeding. Failure is not a claim that every migration rolled back.

## Mutation results and shutdown

Before storage mutation, an unavailable database may return a fixed `storage_error`.
After mutation starts, an unexpected database exception closes the connection
without a negative ACK, because the commit result may be unknown. The SDK must not
automatically retry. This also applies when a server-side SQL timeout actually
rolled back the transaction: the transport deliberately uses the conservative
unknown-result contract. Read known resource IDs to reconcile.

Shutdown immediately rejects new admissions and makes readiness false. It drains
accepted pipelines before closing transport and storage. A readiness timeout never
cancels writes. The `GRACEFUL_SHUTDOWN_TIMEOUT_MS` deadline (default 10000 ms) reports
a failure and sets exit code 1, but continues waiting; it does not drop resource
locks, release mutation memory, or replay an operation.

Choose an external termination grace period appropriate to the maximum accepted
work. The local Compose example uses 30 seconds; it cannot guarantee draining
every batch or a blackholed connection. After a forced kill, clients must treat
unacknowledged writes as unknown. Startup fails if its initial storage check fails,
and owned storage is closed even when constructing the server throws.

The bundled [deployment configuration](DEPLOYMENT.md) separates database roles,
provides a TLS proxy override and documents backup/restore. Final image/load
acceptance and operator-specific capacity/recovery targets remain release work.
