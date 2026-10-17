# Storage adapters

An adapter translates the server's storage operations into one database's
queries and transactions. The PostgreSQL adapter runs **inside the server
process**; PostgreSQL itself runs as a separate service/container. Neither the
SDK nor the Socket.IO client connects directly to SQL.

The existing built-in adapter is
[`PostgresResourceStorage`](../src/storage/postgres/postgres-resource-storage.ts).
The contract is [`ResourceStorage`](../src/domain/ports.ts). The default adapter
is selected when `STORAGE_ADAPTER_MODULE` is unset. No other persistent engine
is supplied or advertised as compatible.

## Required behavior

| Methods | Contract |
| --- | --- |
| `ping`, `close` | Probe actual storage; release backend resources after server work drains |
| `create`, `createBatch` | Store opaque witness/payload, allocate positive unique IDs; batch commits entirely or not at all, results match input order |
| `findById`, `findManyByIds` | Return current records or null; batch slots match requested IDs, including missing records |
| `applyBatch` | Atomically update/delete all entries; missing or duplicate IDs reject the entire batch |
| `update`, `delete` | Preserve the single-resource return semantics defined by the interface |

Use lossless IDs compatible with the protocol's positive BIGINT range. Preserve
all witness/payload bytes and return defensive copies. When read bounds are
provided, reject oversized records before transferring or copying their blobs
into the server process. Honor optional `maxTotalBytes` across witness/payload
bytes of every requested result slot, including duplicate IDs. Check lengths and
fetch payloads from the same read snapshot. Do not implement bounded reads by fetching unbounded
payloads first. Use parameterized queries and keep backend error details out of
public responses and logs.

Return success only after the backend reports commit, with the documented
durability setting. Read-after-write must see that committed state; a lagging
replica is not a substitute. Failure during commit may have an unknown outcome:
do not automatically retry mutations or claim rollback because a timeout fired.

The router verifies witness transitions while holding in-process resource locks,
then calls storage. The adapter stores the verified bytes; it does not generate
private origins or decrypt client payloads. Transactions alone do not make
multiple server processes safe: use exactly one writer, with no external writes
to the same resources.

## Load an extension

`STORAGE_ADAPTER_MODULE` accepts an ESM package specifier or module path. Export
either a `createStorage()` factory (possibly asynchronous), a default factory, or
a default storage object implementing every method. A relative path resolves
from the server's working directory (`/app` in the standard image).

Package the module and its dependencies into an operator-maintained derived
image, or mount a reviewed self-contained module read-only. Set an absolute path
such as `/app/adapters/custom-storage.mjs`. The standard runtime intentionally
has no npm installer. Native dependencies must match its OS/libc/architecture.
This is executable trusted code, not a sandboxed configuration file.

The loader checks method presence only; it cannot prove transaction semantics.
The adapter owns its backend configuration, schema, migrations and credentials.
Do not run PostgreSQL setup/migrations for a different backend. Test at least:
batch rollback on a late failure; concurrent conflicts under the router;
aligned/missing/oversized reads; byte preservation; outage and uncertain commit;
restart durability; and the published SDK's complete workflows. A module loading
successfully is not acceptance of a new database implementation.

## Future adapters and language ports

A MySQL or other SQL adapter can be another module inside the existing server.
This does not require an additional container between ULDA and the database.
An adapter in a separate service would need a new internal network protocol,
authentication, bounded queues, failure handling and commit-outcome semantics.
It is a possible later architecture, not an existing deployment mode.

This server's source already uses TypeScript and compiles to JavaScript for
Node.js. A Python or Rust server is a separate implementation: it must preserve
the wire protocol, exact cryptographic representation, storage atomicity and
failure semantics and pass shared compatibility tests. Language ports and new
database adapters are independent projects; neither is required for this release.
