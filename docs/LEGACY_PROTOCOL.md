# Legacy resource protocol

The resource:* endpoint is retained for explicit compatibility tests. Production
main.ts registers only the [SDK protocol](SDK_PROTOCOL.md). Select legacy mode
programmatically with createUldaServer({ protocol: "legacy", ...options }); the
two protocols are not registered together on the production endpoint.

The published ulda-auth SDK uses ulda:* events and cannot use this endpoint.
The SDK admission guarantees and binary packet format do not apply to legacy
mode. The implementation is in
[register-socket-handlers.ts](../src/transports/socketio/register-socket-handlers.ts),
with regression coverage in [socket-server.test.ts](../test/unit/socket-server.test.ts).

## Socket.IO API

Application CRUD is available only through Socket.IO v4. HTTP is used only for
the operational `/health` and `/ready` endpoints. There is no REST CRUD API.

All commands expect an acknowledgement callback. With `socket.io-client`, use
`emitWithAck()` and a client-side timeout.

| Event | Request | Successful result |
|---|---|---|
| `server:config` | no payload | public server/profile configuration |
| `resource:create` | `{ witness, payload }` | `resource`, `idempotent`, `subscribed` |
| `resource:read` | `{ id }` | `resource` |
| `resource:read-many` | `{ ids }` | `resources`, `missingIds` |
| `resource:subscribe` | `{ id }` | current `resource` snapshot |
| `resource:subscribe-many` | `{ resources: [{ id }] }` | per-item `results`, current `subscriptions` |
| `resource:unsubscribe` | `{ id }` | unsubscribed `id` |
| `resource:update` | `{ id, baseWitness, candidateWitness, payload, proof? }` | `resource`, `idempotent` |
| `resource:delete` | `{ id, baseWitness, candidateWitness, proof? }` | transient `deleted`, `idempotent` |

Server-to-client events:

| Event | Payload |
|---|---|
| `resource:updated` | full `{ id, witness, payload }` snapshot |
| `resource:deleted` | transient `{ id, witness }` delete notice |

## Wire format and acknowledgements

- `id` is a canonical decimal string from `"1"` through
  `"9223372036854775807"`.
- Witnesses and payloads are canonical, unpadded Base64URL strings.
- A witness must not be empty. A payload may be empty.
- `proof`, when present, must be an object or `null`.
- Unknown fields are rejected. Socket identity and action are derived from the
  connection and event name, not from request fields.

A successful acknowledgement has `ok: true` and a request ID:

```json
{
  "ok": true,
  "requestId": "..."
}
```

A rejected command has this shape:

```json
{
  "ok": false,
  "error": {
    "code": "stale_state",
    "message": "Resource changed since the supplied base witness.",
    "requestId": "..."
  },
  "current": {
    "id": "1",
    "witness": "...",
    "payload": "..."
  }
}
```

`current` is included only for errors that provide a current snapshot. Clients
must branch on `error.code`, not on the human-readable message.

Current error codes include:

- `invalid_request`;
- `invalid_witness`;
- `invalid_transition`;
- `invalid_proof` when a custom proof verifier is installed;
- `not_found`;
- `stale_state`;
- `witness_reuse_conflict`;
- `rate_limited`;
- `not_ready`;
- `internal_error`.

## Conflict behavior

Read, Subscribe, Update, and Delete operations for the same resource ID share
one FIFO queue. Different IDs can be processed concurrently.

For a normal Update, the server:

1. reads the current resource;
2. compares `baseWitness` with the stored witness;
3. verifies `verify(storedWitness, candidateWitness)`;
4. runs the configured proof stage;
5. stores the candidate witness and payload;
6. emits the update event and returns the acknowledgement.

The first valid request that successfully stores a new state wins. A later
request built from the old witness receives `stale_state` and the current
snapshot. The server does not merge, rebase, or automatically retry the losing
candidate.

An exact Update retry is idempotent when the candidate witness is already
current and the payload matches. Reusing the same witness with a different
payload returns `witness_reuse_conflict`. Create and hard Delete are not
idempotent operations.

This ordering guarantee applies only to one server process with one writer and
a storage adapter that provides read-after-write behavior. Do not run multiple
replicas of this release and do not write directly to its table.

## Subscriptions

Subscriptions are stored in the server process and are scoped to a live
Socket.IO connection.

- Create attempts to subscribe the creating socket. Check the returned
  `subscribed` field.
- Read does not subscribe.
- Subscribe returns a current snapshot before the acknowledgement.
- The initiating socket receives events only when it is subscribed.
- Disconnect or server restart removes the in-memory subscriptions. Subscribe
  again after reconnecting.
- Events do not have delivery acknowledgements or replay. Use Read after a gap
  or uncertain connection state.

## Development and deployment

Use the [current setup instructions](../README.md) and [deployment guide](DEPLOYMENT.md)
for PostgreSQL roles, secret files and TLS. Do not expose the legacy test endpoint
as the SDK server. Run the compatibility regressions through npm test; no separate
browser benchmark application is required.
