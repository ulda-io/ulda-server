# Server diagnostics

The built-in logger writes one JSON object per line. `LOG_LEVEL` selects `debug`,
`info`, `warn`, or `error`. It changes verbosity, not the privacy policy.

Each record contains `time`, `level`, a stable `diagnostic` code, and a fixed
`message`. Optional context is restricted to validated public identifiers,
known event/error codes, durations, bind address/port, shutdown signal, disconnect
reason, and migration counts. Unknown fields and invalid values are omitted.
An unknown message becomes `server.diagnostic` / `Server diagnostic`.

Exceptions passed to the logger are never serialized or inspected. Their
messages, stacks, causes, custom properties, getters and string conversions are
not used. The record may contain `error: "details_suppressed"`. Passwords, database
connection strings, resource bytes, witnesses, origins and arbitrary objects must
not be passed as diagnostic context. The logger drops them if they are supplied
as extra fields. Context accessors, inherited properties and `toJSON` are ignored.

## Diagnostic codes

| Code | Meaning |
| --- | --- |
| `server.started`, `server.stopped` | Application lifecycle |
| `server.start_failed` | Configuration, storage setup or server startup failed |
| `server.shutdown_requested` | A supported termination signal was received |
| `server.shutdown_timeout` | Grace period elapsed; this does not cancel accepted writes |
| `server.shutdown_failed` | Shutdown rejected; exit code is set to 1 |
| `storage.cleanup_failed` | Storage cleanup after failed startup also failed |
| `storage.pool_error` | An idle PostgreSQL client reported an error |
| `migration.applied`, `migration.ready`, `migration.failed` | Migration progress or failure |
| `socket.outbound_limit` | A receiver exceeded its output allowance |
| `socket.changed_failed`, `socket.broadcast_failed` | Publication failed after a storage commit |
| `socket.mutation_uncertain` | Connection closed because the mutation result is uncertain |
| `socket.connected`, `socket.disconnected` | Legacy endpoint connection lifecycle |
| `socket.command_rejected`, `socket.command_failed` | Legacy endpoint command diagnostics |
| `server.diagnostic` | Unrecognized diagnostic label was suppressed |

The migration CLI uses the same logger. Completion reports the number of newly
applied and previously applied migrations, without reflecting filenames or raw
SQL exceptions. Automation should check the process exit code; a successful
migration has exit code 0 even when its informational logs are filtered out.

## Operating and extending the server

Use diagnostic codes to identify the failing stage, then reproduce it with
synthetic data and controlled configuration. Do not enable raw exception or
packet dumps in production. A `Changed` delivery failure does not undo a commit;
consult the [protocol](SDK_PROTOCOL.md) before retrying a client operation.

When adding a built-in diagnostic, register a fixed message/code pair and add
only narrowly validated context fields. Do not interpolate client data into
messages. Regression tests cover the logger and the startup, storage cleanup,
pool callback, shutdown and migration entrypoint paths.

This policy covers messages routed through the built-in logger and the handled
entrypoint failures. It is not a process-wide interceptor: custom loggers,
trusted adapters, dependencies, PostgreSQL, reverse proxies, the container host,
and uncaught failures outside these paths have their own logging behavior.
Review those separately. Even public IDs and connection metadata can disclose
activity patterns, so restrict log access and retention.
