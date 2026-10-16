# Deployment, database roles and recovery

Run exactly one ULDA Server process against a dedicated PostgreSQL database.
This guide uses the repository's Compose configuration. Public image publication
is a separate release step; substitute a reviewed immutable image digest when one
is available. Docker Compose 2.24.4+ is required by the TLS override.

See the [configuration reference](CONFIGURATION.md) for environment variables
and the distinction between standalone settings and Compose interpolation.

## New installation

For a **new** PostgreSQL volume, from the repository root:

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

The generator creates three random password files under ignored `secrets/`,
without printing them or overwriting existing files. Configure a different
`ULDA_SECRETS_DIR` in Compose and in the generator's environment when needed.
It does not read `.env` itself. Do not regenerate passwords for an existing
database: changing a mounted file does not change the database's stored password.

The build creates both the application and its PostgreSQL image. PostgreSQL stays
on version 18 and Debian bookworm/glibc. The TLS overlay adds a separate slim
Nginx build. See [auxiliary images](AUXILIARY_IMAGES.md) for package choices,
immutable image overrides and database minor-update checks.

Protect the directory with host filesystem permissions. Compose file secrets are
bind mounts, not an encrypted vault. Their host permissions must allow the
container reader: Node UID 1000 for runtime/migration, and proxy UID 101 for its
TLS key. Compose cannot remap ownership of file-backed secrets. Grant narrowly
scoped read access using ownership/ACLs on Linux; restrict the host directory to
the operator on Windows. Never put secrets in Git, image layers, build arguments
or diagnostic output. See [Docker's secret model](https://docs.docker.com/compose/how-tos/use-secrets/).

The setup job is an explicitly selected `admin` profile service. Ordinary
`compose up` does not run it. It requires confirmation, an otherwise idle database
and new role names. Existing accounts are never silently modified. A failed
acknowledgement/connection can leave setup committed: inspect the roles before
retrying. The job suppresses private diagnostics and built-in password-bearing SQL
logs; independently configured audit extensions and the database administrator
remain trusted.

## Roles and secrets

| Service/account | Access |
| --- | --- |
| PostgreSQL bootstrap administrator (`POSTGRES_USER`) | Cluster administration; its secret is mounted only in PostgreSQL and explicit setup |
| `ulda_migrator` | Owns ULDA tables/identity sequence; can create objects in public; no superuser, role creation or database creation |
| `ulda_runtime` | CONNECT, public USAGE, SELECT/INSERT/UPDATE/DELETE on ulda_resources, USAGE on its identity sequence |
| Server container | Only the runtime password file |
| Migration container | Only the migration password file |
| Proxy container | Only TLS certificate/key; no database password |

Runtime cannot change the schema, truncate the table, read the migration ledger,
set a sequence value, become the migrator, create roles or read server files.
The administrator retains database ownership. No runtime grants are automatically
given to unrelated/future tables. Each managed migration run reapplies the exact
current grants; future schema changes must review them.

The fixed roles are intended for one dedicated ULDA deployment per PostgreSQL
cluster. Other schemas must not grant access to PUBLIC if they need isolation.
PostgreSQL catalog metadata remains visible according to normal PostgreSQL
permissions. These roles do not implement application ACLs or prevent the trusted
database administrator from accessing opaque records. See
[PostgreSQL privileges](https://www.postgresql.org/docs/18/sql-grant.html).

Standalone runtime and migration commands support `PGPASSWORD_FILE`. The file
must be nonempty, at most 4096 bytes, with no embedded newline/NUL; one trailing
newline is removed. It cannot be combined with `PGPASSWORD`, `DATABASE_URL` or
`PGSERVICE`. Ordinary PG environment variables and DATABASE_URL remain supported
when the file option is absent. Mounted secrets are read at process startup;
restart after a coordinated password rotation.

## Existing volume from the former shared-superuser configuration

Do not delete/reinitialize the volume. Keep the same Compose project name and
POSTGRES_DB/POSTGRES_USER, and preserve the existing administrator password in
`postgres_admin_password`. Create separate new migration/runtime passwords.
Back up first, verify a restore on another volume, then stop the old server and
all other database clients. Do not run old and new writers simultaneously.

```powershell
docker compose stop server
docker compose build
docker compose run --rm -e ULDA_DB_SETUP=1 -e ULDA_DB_ADOPT_EXISTING=1 db-setup
docker compose run --rm --no-deps migrate
docker compose up -d --no-build server
```

The adoption flag is required when both existing ULDA tables are present. Setup
transfers only those tables and the attached identity sequence to the migrator;
it preserves resource IDs, ciphertext and the migration ledger. It also revokes
PUBLIC database/public-schema privileges, so this procedure is for a dedicated
ULDA database. It refuses existing role names and inconsistent partial schemas.
A DBA must review custom role/table/extension layouts separately.

After verification, remove obsolete shared runtime credentials/configuration
and rotate the former administrator password through a trusted administrative
session (`psql \password`), updating its mounted file too. The role changes do not
erase credentials from previously created containers or backups.

## HTTPS/WSS proxy

Supply a valid certificate chain and matching private key for your domain,
and set CORS_ORIGINS to the application's exact origins. Set in local `.env`:

```dotenv
ULDA_TLS_CERT_FILE=/absolute/path/to/fullchain.pem
ULDA_TLS_KEY_FILE=/absolute/path/to/privkey.pem
ULDA_TLS_PUBLISH_ADDRESS=0.0.0.0
ULDA_TLS_PORT=443
CORS_ORIGINS=https://your-application.example
```

Then use **both files for subsequent lifecycle commands**:

```powershell
docker compose -f compose.yaml -f deploy/compose.tls.yaml build proxy
docker compose -f compose.yaml -f deploy/compose.tls.yaml up -d --no-build
```

The override removes the server's published HTTP port; PostgreSQL remains
unpublished. Only the TLS proxy is exposed. Its pinned Nginx runs as UID 101,
read-only, without capabilities; only a 16 MiB temporary filesystem is writable.
Application and database traffic stays on the private Docker host networks.
Use database TLS separately if PostgreSQL is moved off-host.

The proxy forwards only `/socket.io/`, handles WebSocket upgrade, disables proxy
retries and keeps health/readiness internal. Certificates are validated by clients;
never disable certificate verification. Renew certificates through your chosen
certificate manager and recreate the proxy so replaced secret files are remounted.
This example does not obtain or renew certificates automatically.

Proxy defaults: 20 connections per source IP, 20 HTTP requests/s with burst 40,
8 MiB HTTP body ceiling, bounded headers and 75-second upstream idle timeouts.
Tune per-IP values for NAT/shared offices. HTTP rate/body controls do not limit
individual messages after WebSocket upgrade; the server's binary, connection,
queue and byte limits still apply. CORS is not authentication. There is no raw
request/access logging; avoid logging socket IDs, URLs, payloads or headers in
upstream infrastructure. The restrictive error log is not a metrics exporter.
[WebSocket proxy semantics](https://nginx.org/en/docs/http/websocket.html),
[request limits](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html).

## Resource budgets, readiness and monitoring

Compose currently starts with one CPU and 1 GiB each for server and PostgreSQL;
the Node heap cap is 512 MiB. The proxy has one CPU/128 MiB. PostgreSQL allows 40
connections, runtime role 12, migration role 5; pools use 10 and 2 respectively.
Connection count is not application-user count: Socket.IO clients share the pool.

These are bounded starting values, not a certified capacity for every host or
payload size. Leave host memory for Docker/OS and measure under the final load
profile. Buffers, GC and database reads can exceed the JavaScript heap; accounting
budgets are not RSS limits. An OOM kill can leave writes with unknown outcomes.
Review [admission limits](ADMISSION_LIMITS.md) before changing either limit layer.

SQL statement/lock/idle-transaction limits remain 10/5/10 seconds; readiness waits
2 seconds with a 1-second cache. Docker's probe timeout is 3 seconds. The server
drain warning deadline is 10 seconds and Compose termination grace is 30 seconds.
A deadline never proves rollback or cancels an accepted write; a forced kill can
leave an unknown result. [Operational semantics](OPERATIONS.md).

Monitor internal /ready and /health, container restarts/OOM flags, CPU/RSS, disk
free space, PostgreSQL connections, fixed diagnostic error codes, backup age and
restore drill results. Measure ACK latency/errors in the integrating application
without private data. Admission counters are available to embedded/test runtimes;
the standard image does not expose a public metrics endpoint. Do not expose the
Docker socket, raw PG diagnostics or a debug data endpoint to monitor it.

## Backup

A volume restart is not a backup. Keep encrypted off-host copies with restricted
access and a retention policy. Define RPO/RTO and test recovery on your own volume
size; the small local drill does not establish production recovery times.

For a maintenance snapshot, stop admissions/writes by stopping proxy/server
first, leaving PostgreSQL running. Use the same Compose files/project as the
deployment. These commands use the default project and internal Unix socket:

```powershell
docker compose stop server
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-acl --table=public.ulda_resources --table=public.ulda_resources_id_seq --table=public.ulda_schema_migrations --file=/tmp/ulda.dump'
New-Item -ItemType Directory -Force backups
docker compose cp postgres:/tmp/ulda.dump ./backups/ulda.dump
Get-FileHash ./backups/ulda.dump -Algorithm SHA256
docker compose exec -T postgres rm /tmp/ulda.dump
```

Check every command's exit status before continuing. Use a unique backup filename,
not an existing backup that might be overwritten. The archive covers the current
ULDA tables, identity sequence and migration ledger; it does not include roles,
passwords, TLS keys, configuration or unrelated schemas. Revisit the object list
when adding schema objects. Back up operator configuration/secrets separately.
The client must retain its own master ID/password; the server cannot reconstruct
them. For lower RPO, design WAL/PITR separately.
[PostgreSQL backup behavior](https://www.postgresql.org/docs/18/app-pgdump.html).

## Restore into a new volume

Use a **new Compose project**, leaving the original volume intact and its server
stopped. Only restore a trusted archive, with PostgreSQL tools matching the major
version. Restore executes SQL and is not a safe way to inspect an untrusted file.

```powershell
$RestoreProject = 'ulda-restore-' + [guid]::NewGuid().ToString('N').Substring(0,12)
docker compose -p $RestoreProject up -d postgres
docker compose -p $RestoreProject cp ./backups/ulda.dump postgres:/tmp/ulda.dump
docker compose -p $RestoreProject exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --single-transaction --no-owner --no-acl /tmp/ulda.dump'
docker compose -p $RestoreProject run --rm -e ULDA_DB_SETUP=1 -e ULDA_DB_ADOPT_EXISTING=1 db-setup
docker compose -p $RestoreProject run --rm --no-deps migrate
docker compose -p $RestoreProject up -d --no-build server
```

Wait for PostgreSQL health before copying/restoring. Do not run migrations into
the empty target before restoring: the archive creates the tables. Restore as
administrator, then explicitly adopt the restored ULDA objects and apply the
managed grants. For TLS use both Compose files at every step, and start the proxy
only after verifying the restored server.

Compare row IDs, witness/payload bytes or private offline fingerprints, migration
ledger and sequence state. Test SDK connect/read, one authorized update and a new
Create with an ID above the restored sequence. Never publish decrypted values or
raw records as evidence. Keep the original volume offline until acceptance; do
not run both copies as active writers. After restoring an older backup, old SDK
sessions may hold newer chain state: close/reopen them explicitly and account for
data loss since the backup. No automatic mutation replay is introduced.
[Restore options](https://www.postgresql.org/docs/18/app-pgrestore.html).

## Update and rollback

1. Record the current image digest, configuration and migration ledger. Take and
   validate a backup; reserve enough space for both old and restored data.
2. Review/pull the tested image and set ULDA_SERVER_IMAGE to its immutable digest.
   Do not use the local build command to overwrite a production image tag.
3. Stop proxy/server, check graceful exit and confirm no other writer is active.
4. Run the migration job explicitly against the stopped deployment using the new
   image (`compose run --rm --no-deps migrate`); check exit 0.
5. Start exactly one server with `--no-build`, wait for internal readiness, run
   SDK smoke checks, then reopen proxy traffic and monitor errors/latency.

Switching the image back does not undo schema/data/role changes. Only use an older
image with a reviewed compatible schema, otherwise restore the accepted backup
into a separate volume and explicitly accept the resulting recovery point.
Neither timeout nor failed deployment proves that prior writes rolled back.

## Reproduce the local deployment drill

```powershell
npm ci --ignore-scripts
npm ci --prefix test/consumer --ignore-scripts
npm run check
npm run test:deployment
```

The runner creates two unique Compose projects, a test CA certificate, synthetic
SDK resources and a backup. It tests fresh role setup, refusal without explicit
existing-data adoption, restoration into another volume, runtime privilege
denials, WSS/CORS, private ports, server/database restart and a paused database.
It never uses the operator's .env, working database or image tag. Test secrets and
reports stay under ignored .local; images are retained locally, never published.
Successful runs remove temporary secrets, certificates, the dump and SDK state;
failed runs retain them under ignored .local for local inspection. Synthetic
credentials are not production credentials. The drill does not replace
final load, real certificate renewal, browser or independent security review.

The runner builds task-specific PostgreSQL/Nginx tags unless explicit
`ULDA_TEST_POSTGRES_IMAGE` and `ULDA_TEST_PROXY_IMAGE` references are supplied.
All three image IDs are saved in the result. Optionally set
`ULDA_TEST_PREVIOUS_POSTGRES_IMAGE` to a locally available older **18.x bookworm**
image: the source test volume starts with that image, then is reopened with the
new image before restoring its backup into another fresh volume. The drill
compares locale/collation metadata, sequence state and SDK ciphertext. It never
upgrades an operator's database. Major-version or libc changes require a separate
migration procedure.
