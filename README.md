# ULDA Server

ULDA Server stores encrypted application resources in PostgreSQL and synchronizes
connected clients through Socket.IO. Applications use the
[ulda-auth SDK](https://github.com/ulda-io/ulda-auth) to prepare, encrypt and verify
their data.

Each resource contains only **ID, witness and opaque payload**. Catalogs, content
names, passwords and private origins belong to the client. The server cannot
distinguish a master file from a content file or inspect their encrypted contents.

One Node.js application process owns the resource queues and subscriptions.
Independent resources can progress asynchronously; run exactly one server writer
against a database. PostgreSQL is a separate service.

## Deploy the server

The Docker Hub release contains only the application image, including its
PostgreSQL adapter and migration tools. Operators provision and maintain their
own PostgreSQL service and HTTPS/WSS endpoint. Database and proxy images are not
part of this release. See [operator-managed PostgreSQL](docs/EXTERNAL_DATABASE.md)
for the application-only Compose setup and maintenance responsibilities.

PostgreSQL is the built-in persistent backend. Other databases require a
[storage adapter](docs/STORAGE_ADAPTERS.md), not just a different connection URL.

## Local development with Docker Compose

The following disposable development/test stack runs the server and PostgreSQL,
with one-off database setup and migration jobs. Nginx is not required, started or
included in the server image.
The custom PostgreSQL test image has a separate
[security assessment](docs/POSTGRES_SECURITY_REVIEW.md).

Requirements: Docker with Linux containers, Docker Compose, Node.js 22+ for the
local password generator, and a free local port (3000 by default).

From this repository's root, for a **new database volume**:

```powershell
Copy-Item .env.example .env
node scripts/create-local-secrets.mjs
docker compose build
docker compose up -d postgres
docker compose run --rm -e ULDA_DB_SETUP=1 db-setup
docker compose up -d --no-build
docker compose ps -a
curl.exe http://127.0.0.1:3000/ready
```

Check each command succeeds before continuing. The password generator creates
three files in ignored `secrets/` without printing or overwriting them. Setup
creates separate administrator, migration and runtime database roles. The
migration service normally exits with code 0; the server should become healthy.

The application listens on the host's loopback address; PostgreSQL has no
published port. Data persists in the database volume. `docker compose down`
keeps it; **`down -v` deletes it**.

For an existing volume, use the explicit
[adoption procedure](docs/DEPLOYMENT.md#existing-volume-from-the-former-shared-superuser-configuration).
For remote clients, configure the
[HTTPS/WSS endpoint](docs/DEPLOYMENT.md#httpswss-proxy) and exact application origins.
Use your hosting platform's TLS termination or a reverse proxy of your choice.
The optional [TLS regression fixture](test/fixtures/tls/README.md) uses Nginx only
to test encrypted transport; it is not part of the standard deployment.

## Connect your application

Install the SDK in the client application:

```sh
npm install ulda-auth@1.1.0
```

```js
import { Ulda } from 'ulda-auth';

async function createNotes(serverUrl, password) {
  const ulda = new Ulda(serverUrl); // Your HTTPS endpoint.
  try {
    const masterId = await ulda.register(password);
    await ulda.add('notes', { text: 'Hello' }, 'X');
    await ulda.update('notes', { text: 'Updated' });
    return { masterId, data: ulda.snapshot() };
  } finally {
    await ulda.close();
  }
}
```

Keep the returned master ID for subsequent logins. On a new instance, call
`await ulda.connect(masterId, password)`. To observe another client's updates,
use `ulda.on('change', callback)`; the callback can read `ulda.snapshot()`.
The application controls its UI, password input and secure session lifecycle.

For local HTTP testing only, pass `{ allowInsecureLocalhost: true }` as the
constructor's second argument. Set `CORS_ORIGINS` to the application's origins.
The SDK runs on the client and is not a server runtime dependency.

## Behavior

Large-catalog clients can read bounded ID batches and upload large encrypted
operations in parts before one atomic commit. The server never stores a master
or content role. The [transfer extension](docs/SDK_PROTOCOL.md#large-operation-extension)
is supported by `ulda-auth@1.1.0`; older clients retain their original limits.
Per-frame limits and configurable byte/subscription/queue budgets still apply.

- Create, Read and Update subscribe the live connection before its success ACK.
- Each Create or Update batch, and each mixed Delete/Update batch, is one atomic
  database transaction. Separate commands are separate transactions.
- Updates verify the candidate witness against the stored current witness.
  Conflicting candidates are rejected without automatic replay.
- After commit, other affected subscribers receive `ulda:changed`. The writer
  receives an ACK, without an echo of its own change.
- Subscriptions end with the connection. Reconnect and Read restore current
  state and subscriptions; events have no durable replay.
- A missing write ACK means the outcome may be unknown. A lost Create ACK can
  leave a resource whose generated ID the client does not know.

See the [wire protocol](docs/SDK_PROTOCOL.md) for exact arrays, responses and
errors, and the [manifest](MANIFEST.md) for guarantees and component boundaries.

## Configuration and operation

Compose uses mounted password files and a restricted runtime database account.
For a standalone process, use standard PG connection settings with
`PGPASSWORD_FILE`, or a separately protected `DATABASE_URL`.
[Configuration reference](docs/CONFIGURATION.md).

`GET /health` reports process responsiveness. `GET /ready` checks storage and
shutdown state. Keep probes internal. Shutdown drains accepted work before
closing storage; a timeout or forced kill does not prove rollback.

[Deployment](docs/DEPLOYMENT.md) covers migrations, TLS, credentials, backups,
restore and updates. [Admission limits](docs/ADMISSION_LIMITS.md) cover connections,
queues and byte budgets. These budgets are accounting limits, not exact process
RAM or a guarantee against denial of service.

## Security

The server has no built-in authentication, ownership checks or per-resource ACLs.
A connected client can request encrypted records by ID. The SDK provides payload
encryption and verification; the server does not validate the initial witness's
ownership or decrypt payloads. The default proof stage is a placeholder.

Use TLS, reviewed access/abuse controls and exactly one writer. See
[SECURITY.md](SECURITY.md) for the complete boundary and private reporting.

## Development and tests

```powershell
npm ci --ignore-scripts
npm run check
npm ci --prefix test/consumer --ignore-scripts
npm run test:integration
```

The integration runner uses the published SDK and disposable Docker resources.
Do not point destructive database tests at application data.
[Integration instructions](docs/PUBLISHED_SDK_TESTS.md) and
[contributor walkthrough](SERVER_WALKTHROUGH.md).

## Documentation and license

Start at the [documentation index](docs/README.md).

ULDA Server uses the [ULDA Server Community Source License 1.0](LICENSE.md).
Qualifying organizations may use it commercially without a fee while their
worldwide consolidated group gross revenue remains at or below **USD 1,000,000**,
subject to the license's fiscal-year tests and other conditions. A qualifying
organization crossing the threshold has 90 days to obtain a commercial license
or stop. Functionally equivalent offerings require a separate written commercial
license regardless of revenue. Multi-threaded, clustered or distributed server
implementations developed from or using the covered server materials also
require express commercial permission, including for internal use. Ordinary
single-event-loop operation, database connection pooling and independent
instances serving isolated datasets are excluded from that additional restriction;
see Section 5 of the license. Commercial terms are individually agreed.

This is a source-available license, not an OSI-approved open-source license.
Dependencies keep their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
Commercial inquiries: [mark@shaposhnik.ch](mailto:mark@shaposhnik.ch).
