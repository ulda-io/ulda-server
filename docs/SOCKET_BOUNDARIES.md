# Socket replies, ordering and failure ownership

This document describes the default `ulda:*` endpoint. The complete command
bodies and limits are in [SDK_PROTOCOL.md](SDK_PROTOCOL.md) and
[ADMISSION_LIMITS.md](ADMISSION_LIMITS.md). Opt-in legacy benchmarks are outside
this contract; the production endpoint does not register their handlers.

## Replies

Every command requires one body and a Socket.IO ACK callback. The server attempts
the ACK at most once. An ACK confirms a command result; it is not an additional
client receipt, authentication mechanism, or guarantee that a device received it.

| Command | Success ACK |
| --- | --- |
| `ulda:hello` | `{ok:true}` |
| `ulda:create` | `{ok:true,data:[id,...]}` in input order |
| `ulda:read` | `{ok:true,data:[{id,witness,payload},...]}` in requested order |
| `ulda:update` | `{ok:true}` |
| `ulda:delete` | `{ok:true}` |
| `ulda:session.close` | `{ok:true}` |

IDs are canonical positive signed-BIGINT decimal strings. Witness and payload
are binary attachments. Read is all-or-error: a missing or oversized late item
cannot produce a partial success or partial new subscription.

A definite rejection before mutation returns only `{ok:false,error:code}`.
Allowed codes are `invalid_request`, `invalid_witness`, `conflict`, `not_found`,
`too_large`, `not_ready`, `invalid_proof` and `storage_error`. Internal queue and
subscription-capacity refusals map to `too_large`; rejected witness transitions
map to `conflict`. Unrecognized exceptions map to `storage_error`.

The mapper does not serialize exception messages, stacks, causes, current rows,
arbitrary codes or `toJSON`. It reads only a recognized own string data property
on a domain error, without getters or coercion. A failed inspection also returns
the fixed fallback. Invalid commands with an ACK receive `invalid_request`;
commands without an ACK do not execute. Parser/frame or ingress failures may
instead close the connection before a command can be dispatched.

## Server execution order

1. Validate the whole command and reserve ingress/copy capacity.
2. Acquire the relevant FIFO slots. Read/Update/Delete hold all selected resource
   locks; Create has a separate queue until storage assigns IDs.
3. Reserve subscription capacity before asynchronous storage work. Read and
   mutation validation also reserve worst-case row bytes.
4. Read checks the entire result, subscribes, then replies. Create waits for one
   atomic batch transaction, subscribes the live session, then returns its IDs.
5. Update/mixed Delete reads all rows and checks every witness and proof before
   starting one atomic storage mutation. A late validation failure writes nothing.
6. After storage reports successful commit, subscribe the updated IDs and emit
   one `ulda:changed` packet to each other affected subscriber. Its only fields are
   `{updated:[{id,witness,payload},...],deleted:[id,...]}`. Each recipient sees only
   its subscribed IDs. The author's socket receives no echo.
7. Remove all subscription edges for deleted IDs, attempt the writer's success
   ACK, then release the locks and remaining operation reservations.

The order above is server execution order. Independent connections can observe
Changed and ACK in a different wall-clock order. There is no cross-client
delivery barrier. An overlapping command cannot enter the protected pipeline
before the preceding pipeline finishes. Unrelated IDs can progress independently.

## Failures after mutation starts

If storage rejects after a mutation has started, the outcome can be unknown,
including when COMMIT succeeded but its response was lost. The server closes the
writer without a negative ACK and does not publish an unconfirmed result. It
does not retry or infer rollback from a timeout. A missing Create ACK can leave
an allocated ID unknown to the caller; that remains an accepted protocol limit.

After a confirmed commit, failure to emit Changed cannot undo storage, stop
healthy recipients, or turn success into a rejection. Deleted-resource registry
cleanup still runs. A synchronous failure of the diagnostic callback must not
interrupt fan-out or prevent closing an uncertain writer. A failed ACK send is
contained and is not attempted again, including an ACK for a malformed event.

Changed is best-effort: it has no receipt, durable history or replay. A missed
notification requires a fresh Read/SDK refresh or reconnect. A live subscription
is not proof that a client has received every change. Closing a logical session
clears subscriptions but does not cancel already accepted writes; later
completion cannot recreate subscriptions for that session.

## Reservation ownership

| Reservation | Ownership and release |
| --- | --- |
| Ingress bytes and pending command | Decoder owns incomplete and undispatched packets. Handler claims the lease before accepted work and releases it in `finally`. Decoder destruction releases only unclaimed work. |
| Defensive input copies | Charged to the same ingress lease before allocation; released with that operation. |
| Resource queue slots | Held through the protected pipeline, including commit and publication/ACK attempts. Exceptions release slots without poisoning the next operation. |
| Read bytes | Reserved before storage Read/validation and released after actual completion or failure. A client disconnect alone does not release them. |
| Subscription reservations | Per-socket and global slots reserved before awaits. Always released after the attempt; successful live registry edges remain until deletion/session end. |
| Outbound bytes/packets | Remain charged after flush until transport drain or close. Closing one receiver does not release another receiver's backlog. |
| Connection slot | Covers pending handshake and the adopted physical connection. Upgrade does not allocate a second slot. |

Shutdown rejects new queued commands with `not_ready`, drains accepted work,
then closes transport and storage. An accepted write keeps its memory and locks
until it actually settles. Accounting limits bound defined work/backlog; they
are not an exact measurement of process RSS or a complete network abuse policy.

## Trusted extension boundary

Storage, proof/verifier and logger implementations run inside the server process.
They are trusted code. Fixed wire errors and contained diagnostic failures handle
ordinary failures; they do not sandbox a malicious plugin. Storage must preserve
atomicity, aligned bounded reads and read-after-write, with no hidden work after
its promise resolves. A never-settling adapter can prevent graceful drain.

The server stores opaque payload bytes and public witnesses; it cannot validate
client plaintext or AEAD without keys. It never assigns master/content roles.
Initial trust, decryption and payload authenticity remain client responsibilities.

The [test suites](TESTING.md) cover these boundaries with controlled fault scenarios.
