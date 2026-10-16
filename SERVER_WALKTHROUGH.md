# Current server walkthrough
Active contract: [SDK_PROTOCOL.md](docs/SDK_PROTOCOL.md).
The [manifest](MANIFEST.md) explains component boundaries and guarantees.

Production main.ts → createUldaServer(default sdk) → register-sdk-handlers.
One RequestRouter owns the existing FIFO and two subscription indexes.

| File | Responsibility |
|---|---|
| src/admission/* | Shared byte budgets, handshake slots and request ownership |
| src/protocol/sdk-commands.ts | Strict binary body validation, limits, fixed errors and output copies |
| src/transports/socketio/sdk-parser.ts | Bounds header/attachment counts/bytes before reassembly |
| src/transports/socketio/register-sdk-handlers.ts | ACK once, locks, capacity reservation, lifecycle, unknown outcome |
| src/domain/sdk-resource-service.ts | Aligned reads, whole-batch directed verify and proof before write |
| src/transports/socketio/sdk-publisher.ts | Post-commit Changed to other affected subscribers |
| src/transports/socketio/outbound-limit.ts | Account ACK/Changed bytes until transport drain; disconnect overloaded receivers |
| src/router/request-router.ts | Shared canonical ID locks, direct registry, drain |
| src/storage/postgres/postgres-resource-storage.ts | Real atomic batch transactions on one PoolClient |
| src/storage/in-memory-resource-storage.ts | Explicit test/benchmark adapter with staged atomic batches |
| src/ulda/ulda-core-verifier.ts | Public root-import directed verification only |
| src/proof/allow-all-proof-verifier.ts | Explicit unimplemented proof policy |
| src/transports/socketio/register-socket-handlers.ts | Opt-in historical legacy/core benchmark API |
| test/unit/sdk-server.test.ts | SDK wire, concurrency, subscriptions, failure and decoder cases |
| test/integration/postgres-resource-storage.test.ts | Real DB atomicity and connection-failure cases |
| test/e2e/sdk.test.mjs, release-faults.test.mjs | Pinned public npm SDK with actual backend/PostgreSQL; controlled test-only faults |
| scripts/check-published-sdk.mjs | Disposable Docker integration, image checks and server/database restart |
| src/cli/setup-postgres-roles.ts | Explicit administrator setup/adoption; never application startup |
| src/storage/postgres/password-file.ts, runtime-grants.ts | Mounted DB passwords and exact managed runtime grants |
| scripts/check-deployment.mjs | Disposable Compose/TLS, privilege denials, backup/restore and SDK recovery |

All SDK packets first reserve ingress capacity; handler ownership lasts through finally.
Read/validate reserve worst-case row bytes, subscriptions reserve per-socket and global slots.
Limits, shutdown/close semantics and metrics: [ADMISSION_LIMITS](docs/ADMISSION_LIMITS.md).

Read: locks → single bounded batch read → size/completeness check → subscribe → ACK.
Create: create FIFO → subscription capacity → transaction → subscribe → ordered IDs ACK.
Update/Delete: all ID locks → capacity → read all → verify all/proof → transaction → subscribe
→ Changed excluding author → ACK. A late validation failure never reaches storage.

Current read precedes SQL BEGIN while all ID queues are held; single writer is mandatory.
Create content followed by Update content+catalog is two commands; the server never models that relation.
Session end never revives on a delayed commit. Storage completion ambiguity closes the connection;
the SDK reports UNKNOWN_OUTCOME and must not replay. Core remains unchanged.

Migrations, HTTP readiness, default PostgreSQL/no fallback, non-root container and graceful drain
remain. No schema change. Unknown database COMMIT does not mean failed write.
Legacy APIs, old Base64 examples and exact retry semantics only apply to explicit legacy mode.
Reproducible checks and their scope are documented in [Testing](docs/TESTING.md).
