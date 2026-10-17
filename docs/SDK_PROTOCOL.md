# SDK wire protocol

The default server implements the binary `ulda:*` contract used by
`ulda-auth@1.0.1` and the large-operation extension for newer clients. Socket.IO uses the root namespace and `/socket.io/` path.
The configured protocol identifier `1.0` is not a server release number and
is not repeated in every command.

## Fields and framing

Every command takes exactly two arguments: one body and a Socket.IO ACK callback.
The server attempts the ACK at most once. Without a callback, the command does
not execute. Normal SDK calls handle Socket.IO framing and callbacks internally.

- `id`: canonical decimal string from `"1"` through `"9223372036854775807"`.
  No sign, leading zeros or numeric JSON value. This is the PostgreSQL limit;
  other SDK backends may support longer IDs.
- `witness`: public candidate bytes, a Socket.IO binary attachment.
- `payload`: opaque bytes, a Socket.IO binary attachment.
- Binary values are `Uint8Array`/`Buffer`, not Base64 strings.
- Ordinary CRUD arrays are nonempty, at most 64 entries, with no duplicate IDs.
- Additional resource metadata is not accepted: no role, name, parent, password,
  origin, `baseWitness`, revision, `requestId`, `sessionId` or `watch`.

A server resource is exactly `{id,witness,payload}`. The server does not parse
payloads, even as JSON or encryption containers.

## Events and acknowledgements

The following shapes are notation, not JSON encodings of binary data.

| Event | Body | Successful ACK |
| --- | --- | --- |
| `ulda:hello` | `{}` | `{ok:true}` |
| `ulda:read` | `[id,...]` | `{ok:true,data:[{id,witness,payload},...]}` |
| `ulda:create` | `[{witness,payload},...]` | `{ok:true,data:[id,...]}` |
| `ulda:update` | `[{id,witness,payload},...]` | `{ok:true}` |
| `ulda:delete` | `[{id,witness},{id,witness,payload},...]` | `{ok:true}` |
| `ulda:session.close` | `{}` | `{ok:true}` |

Read returns all records in input order. A missing or oversized member rejects
the entire read, without a partial response or partial new subscriptions.
Create returns one generated ID per input entry, in order.

For Delete, the absence of `payload` means delete. An entry with `payload`
means update, even if that payload has zero length. At least one entry must be a
deletion. This permits an encrypted catalog update and a resource deletion in
one transaction without disclosing a catalog relationship.

Hello confirms router availability. It is not login, identity verification or
a database check; use internal HTTP `/ready` for the latter. Session close ends
the logical socket session and its subscriptions. New commands require a new
connection; accepted writes are not cancelled.

## Pipeline and atomicity

After whole-command parsing and input/copy admission, Read/Update/Delete acquire
all resource keys in canonical numeric order through the shared FIFO.
The response preserves input order. Independent ID sets may progress concurrently.
Create has a separate queue until storage assigns IDs.

**Read:** reserve subscription and read capacity → one aligned bounded storage
read → validate all records and aggregate response size → subscribe → ACK.

**Create:** reserve subscription capacity → atomic `createBatch` → subscribe
new IDs on the live session → ordered ID ACK. The initial witness is only
bounded opaque bytes; core does not verify initial ownership or a predecessor.

**Update and mixed Delete:** reserve capacity → one aligned read of current
records → for each entry, await `verify(current.witness,candidate.witness)`
then await the proof verifier → one atomic `applyBatch` → subscribe updated IDs
→ Changed to other subscribers → clear deleted subscriptions → success ACK.

All validation must pass before storage mutation starts. The default proof
stage receives `null` and accepts it; it supplies no content or identity proof.
Locks and owned reservations remain until the protected pipeline finishes,
including the ACK attempt. See [socket boundaries](SOCKET_BOUNDARIES.md).

PostgreSQL uses one PoolClient for BEGIN, every batch statement and COMMIT.
Failure before commit causes a rollback attempt of the whole transaction.
Unexpected storage completion errors still have the conservative uncertain
outcome described below. A mutation affecting an unexpected row count fails.

Current records are read before BEGIN while Router locks are held. The server
must be the only writer, with read-after-write storage. This is not a
multiple-replica consistency mechanism. Custom adapters must implement atomic
batches; there is no separately committed single-operation fallback.

The first accepted valid transition wins. A second candidate based on the old
state is checked against the newly stored witness and conflicts if it is no
longer a valid continuation. Repeating a previously accepted candidate conflicts.
There is no write replay, automatic rebase or idempotency key.

A content Create followed by Update of content and master is two commands and
two transactions. A resource can remain unlinked between them. The server does
not interpret the client's hierarchy or repair an interrupted workflow.

## Subscriptions and Changed

The Router maintains two indexes: resource ID → sockets and socket → resource
IDs, with no duplicate edges. It does not create application resource rooms.

Successful Create, Read and Update subscribe before ACK. Mixed Delete subscribes
its updated IDs. Subscription capacity is reserved before asynchronous storage,
including concurrent commands on one connection. Errors add no new subscriptions.

After commit, each other affected subscriber receives one logical Changed event.
When it fits ordinary framing, this is one `ulda:changed` event:

```js
{
  updated: [{ id, witness, payload }],
  deleted: [id]
}
```

Either array may be empty. Each recipient receives only its subscribed IDs.
The author socket is excluded. Other tabs or devices have their own sockets
and receive updates normally. A deleted resource is removed from every
subscription index; no tombstone is stored.

Disconnect or session close clears both index directions. Late completion of
an accepted command cannot restore an ended session's subscriptions.

Changed is best-effort, with no client ACK, durable history or replay. Sending it
fails independently for each recipient; failure cannot roll back a commit or
turn a successful mutation into a definite rejection. Across connections, there
is no guarantee whether a subscriber observes Changed before the writer sees
its ACK. Reconnect followed by Read restores current state and subscriptions.

## Errors and unknown outcomes

See [large-operation transfer](#large-operation-extension) for staging and
fragmented read/notification rules. Those rules do not change Commit uncertainty.

A definite failure before storage mutation returns:

```js
{ ok: false, error: 'code' }
```

| Code | Meaning |
| --- | --- |
| `invalid_request` | Malformed command, field shape or ID |
| `too_large` | Size, queue, subscription or other available capacity exceeded |
| `not_found` | A requested resource is absent |
| `invalid_witness` | Witness processing failed with a recognized witness error |
| `conflict` | Candidate is not an accepted continuation of stored state |
| `invalid_proof` | Configured proof policy rejected the entry |
| `not_ready` | Router/session is not accepting work |
| `storage_error` | Safe fallback for failures before mutation |

Errors contain no raw exception message, stack, private data or current row.
Parser/transport violations can close the connection before an ACK is possible.

If a mutation has started and storage throws unexpectedly, the server closes
the writer without a negative ACK. COMMIT may have succeeded before its response
was lost. The SDK reports `UNKNOWN_OUTCOME` and does not repeat the write.
This is conservative even when the transaction actually rolled back.

Read known IDs to reconcile. A lost Create ACK has no ID recovery mechanism and
can leave an unlinked row. Volatile delivery does not guarantee receipt or
combine separate commands into an atomic operation.

Disconnect does not cancel accepted work. Shutdown rejects new admissions,
drains accepted pipelines, then closes transport and storage. A forced kill
does not provide graceful completion guarantees.

## Limits and profiles

| Boundary | Limit |
| --- | ---: |
| Batch entries | 64 |
| Binary attachments | 128 |
| UTF-8 packet header | 65536 bytes |
| Individual attachment / payload | 1100000 bytes |
| Aggregate binary bytes | 8388608 bytes |
| Witness | min(`MAX_WITNESS_BYTES`, 167) bytes |
| Engine.IO frame | min(`MAX_SOCKET_MESSAGE_BYTES`, 1100000) bytes |

Zero-length payloads are permitted. Read responses also undergo aggregate
binary-size validation. Oversized batches are rejected, not split by the server.
Increasing operational budgets does not raise these fixed wire limits.

The compatible SDK generation profile is Compact V1, N=5, SHA-256,
originSize=256, uint32 age, X/S. Create does not inspect or enforce the first
profile; the Compact V1 verifier requires the configured origin size.

Additional connection, pending-command, read, subscription and outbound budgets
are in [admission limits](ADMISSION_LIMITS.md). A slow or overloaded receiver may
be disconnected; a committed mutation remains committed. Budgets are not exact
RSS or complete abuse protection.

## Large-operation extension

Clients advertise Socket.IO handshake `auth: {uldaTransfer:1}` to receive
fragmented notifications. This flag is a framing capability, not authentication.
Resources remain exactly ID, witness and opaque payload; no catalog role is added.
Ordinary CRUD remains compatible with 1.0.1 for its original supported sizes.

`ulda:transfer` accepts one exact body plus an ACK callback:

| Body | Successful ACK |
|---|---|
| `{kind:'begin',action:'create'\|'update'\|'delete',count}` | `{ok:true,token}` |
| `{kind:'append',token,items}` | `{ok:true}` |
| `{kind:'part',token,resourceId?,witness,total,offset,payload}` | `{ok:true}` |
| `{kind:'commit',token}` | Original action's ACK: Create returns IDs; Update/Delete return `{ok:true}` |
| `{kind:'cancel',token}` | `{ok:true}` |
| `{kind:'read',resourceId,offset}` | `{ok:true,data:{id,witness,payload,total,offset}}` |

A random 32-character lowercase hexadecimal token identifies one upload on one
connection. It is neither a durable operation ID nor an idempotency key. Begin
counts must fit the Router's total-key budget; Create remains at most 64 records.
Append uses the ordinary action entry shape, at most 64 items and 8 MiB of binary
data. A Delete append may contain only update entries, but its completed operation
must contain at least one deletion. Duplicate resource IDs are rejected.

Part carries at most 1 MiB of ciphertext. Omit resourceId only for Create.
Total/offset are byte counts; each resource begins at offset zero and continues
contiguously with the same ID, witness and total. All data must fit resource,
logical-operation and shared staging budgets before allocation/copying.

Begin/Append/Part never mutate storage or open a database transaction. Commit
requires the complete upload, obtains all affected Router keys, validates current
rows in groups of at most 64, then invokes storage once for the entire operation.
A late conflict rejects every mutation. Updated IDs are subscribed before ACK;
Changed is published only after commit. Accepted Commit may finish after a
disconnect; its reservations remain owned until it finishes.

One connection can hold one upload and one large read. Upload expiry, Cancel,
malformed staged data or disconnect clears uncommitted staging. The absolute
deadline is not renewed by each part. Missing Commit ACK is an unknown outcome,
never permission to replay. An interrupted pre-Commit upload cannot itself commit.

Ordinary Read still accepts at most 64 IDs and returns one complete ACK. The SDK
divides larger catalogs into sequential ID arrays and reduces a group on an
explicit `too_large` response. The server never streams an unbounded ID array.
For an oversized singleton, Read offset zero pins a bounded ciphertext snapshot;
subsequent offsets return at most 1 MiB from that same witness/version. Last part,
expiry or disconnect releases it. New reads after completion may see newer state.
Separate resource reads are not one global database snapshot.

Large Changed uses `ulda:changed.part` with ordered frames:
`{kind:'begin',count}`, then `{kind:'append',items}` and/or
`{kind:'part',resourceId,witness,total,offset,payload}`, then `{kind:'end'}`.
Append entries are updated `{id,witness,payload}` or deleted `{id}`.
Each recipient receives only its subscribed resources. No client ACK is required.
The SDK reassembles and verifies the complete event before publishing local state.
All frames of a logical notification are enqueued together; ordinary output
budgets still apply and can disconnect a slow or overloaded recipient.

If a notification cannot fit ordinary framing and its recipient did not advertise
the capability, the server disconnects that recipient rather than silently
leaving stale state. Upgrade all clients sharing a catalog before exceeding the
old SDK limits. There is no encrypted-format migration or nested-catalog logic.

## Legacy protocol boundary

The historical `resource:*` / Base64 API is available only through explicit
`createUldaServer({protocol:"legacy"})` in tests/benchmarks. Production does not
register those handlers. Its metadata and retry behavior are not part of this
contract. [Legacy documentation](LEGACY_PROTOCOL.md).
