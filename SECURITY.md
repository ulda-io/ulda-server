# Security Policy

ULDA Server stores public witnesses and opaque client payloads, verifies directed
witness transitions and coordinates one application writer over PostgreSQL.
This policy covers the official server code, Socket.IO boundary, PostgreSQL
adapter, migrations and supplied deployment configuration. The release contains
only the application image and its bundled runtime/dependencies. Operators
maintain database/proxy services, images, patches, network access and backups.
Defects in our adapter or deployment instructions remain in scope even when
the database is externally managed. See [deployment ownership](docs/EXTERNAL_DATABASE.md).

Repository PostgreSQL/Nginx builds are local integration fixtures, not published
production dependencies. Their known CVEs remain visible in separate advisory
reports. Application image checks still reject High/Critical/unknown findings
and invalid scan evidence; no database package exception applies to the server.

## Supported versions

Security fixes target the latest released `1.x` version. Upgrade to that version
before reporting an issue that may already be fixed. Pre-1.0 builds and older
patch releases do not receive separate security backports. Reports about current
development code are also welcome through the private channels below.
The protocol identifier `1.0` is separate from the server release number.

Unofficial builds, custom adapters, host systems and third-party services are not
maintained by this project. Reports about their interaction with official server
code are welcome. Core and SDK have their own
[core](https://github.com/ulda-io/ulda-core/blob/main/SECURITY.md) and
[SDK](https://github.com/ulda-io/ulda-auth/blob/main/SECURITY.md) security policies.

## Private reporting

Email [mark@shaposhnik.ch](mailto:mark@shaposhnik.ch) with subject
`[SECURITY] ULDA Server vulnerability report`. Once private reporting is enabled
in the official server repository, its **Security → Report a vulnerability**
form is an alternative. Do not report an undisclosed vulnerability in a public
issue, pull request or discussion.

Include the affected version or commit, image digest when relevant, impact,
minimal reproduction with synthetic data, redacted configuration and any
mitigation. Do not include real payloads, private origins, passwords, tokens,
private keys, connection strings or production database dumps.

Maintainers will coordinate investigation, remediation and disclosure.
This policy does not promise a response deadline, bounty or resolution date.

## Security boundary

- **Open reads:** a connected client can request encrypted resources by ID.
  There is no built-in authentication, ownership check or per-resource ACL.
  CORS is not access control and does not protect against non-browser clients.
- **Initial state:** Create accepts bounded witness/payload bytes. It does not
  prove who owns the first witness or enforce the advertised generation profile.
  The integrating application establishes initial trust and any identity binding.
- **Transitions:** Update and Delete verify only
  `verify(storedCurrentWitness, candidateWitness)`. Every entry must pass before
  the batch mutates storage. An invalid or conflicting continuation is rejected.
- **Payloads:** the server cannot decrypt or verify the encrypted container.
  The SDK encrypts and authenticates it on the client, including the witness as
  associated data. The server cannot enforce that a custom client actually
  encrypted its payload.
- **Proof:** the default `AllowAllProofVerifier` is an explicit placeholder.
  It does not authenticate application data or grant user authorization.
- **Secrets:** origins and decryption passwords belong on the client. Client
  encryption cannot protect a running client from a compromised device.
  The server and database still expose IDs, ciphertext lengths and access patterns.
- **Trusted extensions:** custom storage/proof modules execute with server
  privileges. Fixed wire errors and safe logging are not a sandbox.

## Atomicity and uncertain outcomes

The server must be the only writer to its resource namespace. Resource locks
cover validation, storage, publication and ACK. Reads preceding BEGIN rely on
these in-process locks; multiple replicas or external writers are unsupported.

Each mutation batch is one database transaction. Success follows storage
completion. Before mutation, a definite rejection writes nothing. After an
unexpected mutation or COMMIT error, the writer is disconnected without a negative
ACK because the outcome may be unknown, even if the database actually rolled back.

Do not automatically repeat an unacknowledged write. Read known IDs to reconcile.
A lost Create ACK can leave an allocated ID unknown to the client. Socket.IO
volatile delivery does not solve this problem or provide atomicity across commands.

Changed is best-effort and has no durable history, replay or client receipt.
It goes to other affected subscribers after commit; notification failure does not
undo the mutation. Deletion notifications contain IDs, without a cryptographic
proof. The SDK's documented policy trusts the server for these notifications.
Reconnect requires rereading; it is not proof that every historical event was seen.

Shutdown drains accepted work. Readiness and shutdown deadlines do not cancel
SQL, undo commits or release accepted work early. A forced process kill or network
partition can leave clients uncertain. [Operational policy](docs/OPERATIONS.md).

## Resource and transport controls

Extended operations retain ciphertext and public witnesses under shared staging
budgets and absolute deadlines. No upload part mutates storage; Commit validates
the complete operation against current witnesses before one atomic batch.
Connection cleanup cannot release an accepted commit's capacity prematurely.
Large read snapshots and fragmented notifications retain the existing trust and
unknown-outcome boundaries. Limits bound accounted work, not exact process RSS;
operators must size memory, outbound buffers and timeouts for large catalogs.

The SDK endpoint bounds packet headers, binary attachments, batch sizes,
connection slots, pending/rate-limited commands, input/copy bytes, active reads,
subscription edges and outbound bytes/packets. See
[admission limits](docs/ADMISSION_LIMITS.md) for exact accounting and defaults.

Limits are not a proof of maximum RSS, per-IP fairness or protection of every
raw TCP/HTTP connection. Reconnecting creates a new decoder rate bucket.
Output exhaustion closes the affected recipient and can prevent an ACK after
commit. The legacy test endpoint does not inherit the SDK admission guarantees.

Use HTTPS/WSS and reviewed edge connection/rate controls. The server has no
built-in TLS; the optional proxy terminates TLS and leaves probes/database ports
internal. If PostgreSQL is remote, protect that separate transport too.

## Deployment responsibilities

1. Run one application writer with a dedicated database. Keep PostgreSQL and
   probes internal; decide whether open-by-ID reads fit the application.
2. Use separate administrator, migration and runtime accounts. Mount only the
   required password file in each service. Never bake secrets into images.
3. Keep container restrictions enabled: non-root, read-only root filesystem,
   dropped capabilities, no privilege escalation and bounded resources.
4. Protect the host, secret files, database, backups and operator configuration.
   A database administrator and custom modules remain trusted.
5. Maintain TLS certificates, monitor readiness, restarts, capacity and fixed
   diagnostic codes, and validate backups by restoring to another volume.
6. Review versioned images and applicable dependency/OS advisories. Pin the
   accepted digest, rebuild and retest fixes, and deploy them explicitly.
7. Account for state rollback when restoring an old backup: the server cannot
   recover lost client secrets or recreate updates missing from that backup.

[Deployment and recovery](docs/DEPLOYMENT.md) provides the procedures.
[Container policy](docs/CONTAINER_SECURITY.md) explains the supplied restrictions.

## Diagnostics and disclosure

The built-in logger uses fixed codes and validated context. It does not serialize
raw exceptions, stacks, causes, resource bytes or arbitrary objects, including at
debug level. Setup, migration and handled startup/shutdown failures follow this
policy. External proxies, database audit extensions and custom code require their
own review. [Logging reference](docs/LOGGING.md).

Automated tests and vulnerability scans are evidence for a particular revision
and environment, not an independent audit, absence-of-vulnerabilities guarantee
or acceptance of every deployment. See [Testing](docs/TESTING.md) for the
reproducible checks and the separate integration, deployment and load boundaries.

When a fix is released, the maintainers will describe the affected versions,
mitigation and upgrade through the official repository's advisories/release
notes. Operators are responsible for deploying the fix. A mutable image alias
does not update a running deployment automatically.
