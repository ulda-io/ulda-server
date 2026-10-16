# ULDA Server Manifest

This document describes the single-process server and its guarantees.
The exact wire contract is in [SDK_PROTOCOL.md](docs/SDK_PROTOCOL.md).

## Purpose and data boundary

The server persists opaque resources, checks directed ULDA witness transitions,
orders concurrent access and notifies connected subscribers.

A resource has exactly three stored fields:

| Field | Meaning |
| --- | --- |
| `id` | Server-assigned positive PostgreSQL BIGINT, represented on the wire as a decimal string |
| `witness` | Public bytes used to verify a directed transition from the stored state |
| `payload` | Opaque bytes prepared by the client |

The migration ledger is database bookkeeping, not resource metadata.
There is no resource type, parent, owner, catalog, filename, password or private
origin in the resource schema. Links between resources exist only inside
client-encrypted payloads. The server necessarily observes requested IDs, byte
lengths, request timing and connection/subscription relationships.

The client SDK generates private chain state, encrypts payloads, decrypts received
data and interprets catalogs. The server uses only the public
`ulda-core.verify(currentWitness, candidateWitness)` operation. It never creates
origins, signs witnesses, advances private chains or imports the SDK decryptor.

## Execution model

Exactly one Node.js application process and one RequestRouter write a dedicated
database namespace. There are no application workers, cluster processes or
replicas. Native runtime, database and operating-system threads are outside this
application-level constraint.

Read, Update and Delete acquire all affected resource keys in canonical numeric
order. They retain those keys through asynchronous validation, storage,
publication and the ACK attempt. Overlapping operations are ordered; disjoint
resources can progress independently. Create has its own queue until IDs exist.

Current records are read before the mutation transaction under these in-process
locks. This requires a single writer and read-after-write storage. Transactions
alone do not make multiple server instances or external SQL writers safe.

## Command pipelines

Every command requires its body and a Socket.IO ACK callback. Incoming packets
and copies must obtain admission capacity before allocating protected resources.

1. **Read:** validate the complete ID array; acquire keys; reserve read and
   subscription capacity; fetch all records; check completeness and response
   size; subscribe the live connection; return the ordered records.
2. **Create:** validate every entry; reserve subscription capacity; insert the
   entire batch in one transaction; subscribe the live connection; return the
   generated IDs in input order. The first witness is accepted as bounded opaque
   bytes, without establishing ownership or checking a prior transition.
3. **Update:** validate the complete array; acquire all keys; reserve capacity;
   read current records; verify every stored-to-candidate transition and invoke
   the proof stage; atomically store the entire batch; subscribe updated IDs;
   publish Changed to other affected subscribers; acknowledge the writer.
4. **Delete:** perform the same validation and directed verification for every
   entry. Entries without payload are deleted; entries with payload are updated
   in that same transaction. Publish the committed changes, clear subscriptions
   to deleted IDs and acknowledge the writer.
5. **Hello:** confirm that the router accepts work. It is not authentication or
   a database readiness probe.
6. **Session close:** remove the connection's subscriptions and end its logical
   session. Already accepted writes continue. Further work requires a new
   connection.

A late invalid member rejects the entire command before mutation. PostgreSQL
uses one checked-out connection for BEGIN, all batch mutations and COMMIT.
There is no fallback to separately committed per-resource writes.

Creating a content resource and updating an encrypted catalog are separate
client commands. The server neither combines them into a transaction nor repairs
an interrupted client workflow.

## Subscriptions and replies

Two indexes connect resource IDs to sockets and sockets to resource IDs.
Duplicate subscriptions are not added. Successful Create, Read and Update
subscribe automatically; mixed Delete subscribes its updated IDs. Capacity is
reserved before asynchronous work. Failed commands add no new subscriptions.

After a successful mutation, each other affected subscriber receives one
`ulda:changed` packet containing only its subscribed updated/deleted IDs.
The writer's socket receives no echo; another device or tab is another socket.

The server attempts Changed before the writer's ACK while holding the keys.
Delivery order across different connections is not guaranteed. Event delivery
is best-effort, with no acknowledgement, history or replay. Read after reconnect
restores current state. Deletion is a hard delete, without a persistent tombstone
or cryptographic deletion proof.

Disconnect and session close remove both index directions. A later completion
cannot subscribe an ended session again. Deleted IDs are removed from all
subscriber indexes. Application resource rooms are not used.

## Failure and overload semantics

Definite rejection before mutation returns a fixed error code without raw
exception details. If an unexpected error occurs after storage mutation starts,
the connection closes without a negative ACK: COMMIT may have succeeded.
No automatic mutation replay or rollback claim follows from a timeout.

An ACK confirms the result reported by storage; it does not guarantee that the
client received it or strengthen database durability. Failed notification delivery
does not undo a committed write. A lost Create ACK can leave an unknown generated
ID; this protocol has no recovery receipt or idempotency key.

Connection slots, pending commands, input/copy bytes, reads, subscriptions and
outbound buffers are bounded. Accepted work retains its reservations until it
actually finishes, even after disconnect. Accounting budgets do not bound every
driver, runtime, kernel or database allocation.

Shutdown rejects new work and drains accepted pipelines before closing transport
and storage. Its deadline reports a failure but does not cancel active SQL or
release mutation locks early.

## Trust and deployment

Witness verification checks directed continuation, not user identity or payload
authenticity. The default proof verifier accepts all requests that reach it;
it supplies no application-specific security. The server has no built-in ACL,
login or payload encryption. Reading by ID is intentionally allowed.

The official configuration uses PostgreSQL with separate administrator, migration
and runtime roles. The image runs non-root; Compose adds filesystem, capability,
CPU, memory and PID restrictions. An optional reverse proxy provides HTTPS/WSS.
Operators still own certificates, access/abuse policy, backups and host security.

Custom storage and proof modules execute as trusted code. Storage must implement
atomic batches, aligned reads, defensive copies, read bounds and read-after-write
behavior. No RAM fallback is used when PostgreSQL fails.

These are implementation contracts, not a claim of a formal proof, independent
audit, guaranteed availability or protection from a compromised client device.

## Distribution

This manifest and the server's own code and documentation are covered by
[LICENSE.md](LICENSE.md). Core, SDK, database, runtime and other dependencies
retain separate licenses. Enterprise products are outside this server release.
See [SECURITY.md](SECURITY.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
