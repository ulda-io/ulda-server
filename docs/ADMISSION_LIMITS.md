# Admission and resource limits

The default SDK endpoint bounds connections, retained input, concurrent reads,
outbound messages, queued work and subscriptions. Work reserves capacity before
using the corresponding resources. Capacity exhaustion rejects admission instead
of adding to an unbounded queue.

There is one process, one Router and independent per-ID queues, without a global
execution lock. These controls apply to `ulda:*`; the explicit legacy benchmark
endpoint does not inherit the SDK guarantees.

## Settings

Settings are read at process startup. Compose passes only variables explicitly
interpolated in compose.yaml; other settings require a Compose environment
override. See [configuration](CONFIGURATION.md#message-and-admission-bounds).
Invalid values fail startup. Zero does not disable these limits.
MiB means 1048576 bytes.

| Variable | Default | Accounting scope |
| --- | ---: | --- |
| MAX_CONNECTIONS | 1000 | Live Engine.IO connections plus reserved pending handshakes |
| MAX_INFLIGHT_BYTES | 67108864 | Shared input, queued packets and defensive-copy reserves |
| MAX_ACTIVE_READ_BYTES | 268435456 | Worst-case encrypted rows for active Read/validation |
| MAX_BUFFERED_TOTAL_BYTES | 67108864 | Shared outbound bytes until transport drain |
| MAX_BUFFERED_SOCKET_BYTES | 16777216 | Per-connection outbound bytes |
| MAX_PENDING_COMMANDS_PER_SOCKET | 64 | One decoder's assembly, dispatch, queued and executing packets |
| MAX_COMMANDS_PER_SECOND | 1000 | Per-decoder token-bucket refill rate |
| COMMAND_BURST | 2000 | Token-bucket capacity |
| BINARY_PACKET_TIMEOUT_MS | 30000 | Absolute binary assembly deadline after its header |
| MAX_SUBSCRIPTIONS_TOTAL | 100000 | All socket–ID edges plus reserved slots |
| MAX_SUBSCRIPTIONS_PER_SOCKET | 10000 | One socket's edges plus reserved slots |
| MAX_QUEUED_TOTAL | 10000 | Total Router key reservations; a batch occupies multiple keys |
| MAX_QUEUED_PER_RESOURCE | 100 | Running/waiting reservations for one key |

Fixed outbound packet ceilings are 4096 per socket and 65536 overall.
Engine.IO handshake and Socket.IO CONNECT waits are bounded at 10 seconds.
[Wire size limits](SDK_PROTOCOL.md#limits-and-profiles) remain fixed when
operational budgets are raised.

## Input ownership

1. Before header decoding, reserve 1024 bytes per packet plus four times the
   header's UTF-8 length. These are accounting units, not measured object sizes.
2. Before reconstruction, each attachment reserves its length plus 64 bytes.
   An incomplete packet already consumes shared capacity and a pending slot.
3. The same lease follows the reconstructed packet through Socket.IO dispatch.
   The handler claims it by the body object, not by ACK callback identity.
4. Mutation parsing checks all shapes, IDs and logical byte lengths first.
   Before defensive copies it reserves three times the total logical
   witness/payload length. Reused attachment placeholders count separately
   where they create separate copies.
5. The accepted operation retains ownership through queueing and execution,
   releasing it once in `finally`. Rejection, malformed input and reconstruction
   timeout release only the corresponding unaccepted packets.
6. Decoder destruction releases incomplete or unclaimed work. Disconnect does
   not cancel SQL or release the accepted operation's memory reservation early.

The rate bucket consumes one token per Socket.IO header, including CONNECT and
DISCONNECT; attachments are not additional tokens. The assembly deadline does
not extend when more fragments arrive. Only one root namespace CONNECT is allowed.
Unsolicited client ACK packets are rejected because Changed requests no receipt.
Engine.IO heartbeats are handled at another layer.

## Reads and subscriptions

Before fetching records for Read or mutation validation, reserve
`numberOfIds × (1100000 + 167)` bytes. The row size is unknown before the query,
so small records consume this same conservative reservation.

The default 256 MiB fits at most 243 concurrent record positions. A 64-entry batch
reserves 70410688 bytes. One ID needs at least 1100167 bytes; a two-resource
Update needs 2200334. A smaller budget can reject even tiny actual records.
Commands waiting for Router keys do not hold active-read capacity yet.

PostgreSQL checks each column length in SQL before transferring oversized BYTEA
values into Node. Any oversized member rejects the operation. The in-memory test
adapter checks before copying. Custom `findManyByIds(ids,bounds)` adapters must
honor bounds before transfer/copying; a later service check cannot undo an
allocation already made by trusted code.

The aggregate Read response is checked after selection. SQL does not impose a
separate aggregate batch ceiling; the read reservation covers all worst-case
positions. Read capacity is released after the Read ACK or after mutation
validation finishes. Transport output has separate accounting.

Subscription capacity is reserved per connection and globally before awaits or
writes. Existing edges are not duplicated; concurrent requests include already
reserved slots. Create/Read/Update subscribe before ACK; mixed Delete subscribes
updated IDs. Session end removes both indexes and cannot be undone by late work.
Deletion removes the ID's edges from the registry. No resource rooms are created.

## Output ownership

ACKs, Changed, binary attachments and control packets reserve their length plus
64 bytes per frame. Accounting spans the Engine.IO write buffer and the period
after flush until transport drain. Flush alone does not release capacity.
Upgrade, drain and close release their owned portions once.

If either per-socket or shared output capacity is exceeded, the socket currently
receiving that attempted enqueue is closed. This is not a fairness guarantee:
a healthy recipient can also be closed when shared capacity is exhausted.
Disconnect releases that socket's output and subscriptions, not another socket's
reservations. Committed writes stay committed.

## Client-visible results

| Condition | Result |
| --- | --- |
| No handshake capacity | Connection rejected; Socket.IO connect_error |
| Shutdown in progress | New handshake/work rejected as not ready |
| Copy/read/subscription/Router capacity exhausted before mutation | ACK `{ok:false,error:"too_large"}`; no mutation by that command |
| Parser size/rate/pending/deadline violation | Connection closed; a negative ACK is not guaranteed |
| Output exhausted | Recipient closed; committed data is retained |
| Unexpected failure after mutation starts | Writer closed without a negative ACK; unknown result |

A sent write may be uncertain after connection loss even if the server actually
rejected it before SQL. The client cannot infer definite failure without a reply.
There is no automatic mutation replay. Read after reconnect reconciles known IDs;
a lost Create ACK cannot recover the generated ID.

## Observation and deployment

The embedded `server.admission.snapshot()` exposes numeric current/peak accounting
and connection/pending/packet counts. It is not a public HTTP endpoint.
Diagnostic logs contain no raw witness, payload, origin, password or database
exception. [Logging policy](LOGGING.md).

Budgets do not add up to process RSS. Runtime metadata, garbage collection,
JSON parsing, driver copies, database temporary results, proxy/TLS and kernel
buffers cost additional memory. Size containers and host headroom from measured
payload/batch/concurrency profiles; defaults do not certify any machine capacity.

MAX_CONNECTIONS does not count every raw HTTP/TCP connection before handshake.
The rate bucket is per decoder and resets on a new connection, not per IP.
Use edge connection/rate controls, TLS, monitoring and backups. One application
process does not eliminate native runtime or operating-system threads.
A second writer against the same namespace is unsupported.

Lower budgets can reject otherwise valid requests. Tuning must not weaken
atomicity, change cryptography or introduce automatic write replay.
See [deployment](DEPLOYMENT.md) and [testing](TESTING.md).
