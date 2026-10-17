# Deploy the server with operator-managed PostgreSQL

The release artifact is **one ULDA Server image**. It includes Node.js, the
application, its dependencies, the PostgreSQL adapter and ULDA schema migration
tools. It does not include a running database or reverse proxy. The client
installs `ulda-auth` separately and connects to the server's Socket.IO endpoint.

The supported persistence implementation is PostgreSQL. Integration acceptance
uses PostgreSQL 18.6; compatibility with other major versions is not implied.
The database image, host and maintenance schedule are chosen by the operator.
A passing server release scan is not a security approval for that database.

## Ownership

| Component | Maintenance boundary |
| --- | --- |
| ULDA Server image, bundled runtime/dependencies, official PostgreSQL adapter and migrations | ULDA maintains the implementation and release checks |
| Database service/image, patching, roles, network, disk and backup/restore | Deployment operator or their database provider |
| TLS termination, certificates and host controls | Deployment operator |
| Third-party storage adapter | Its author/maintainer; operator reviews it as trusted executable code |

Report defects in our adapter, migrations or deployment examples to ULDA even
when they appear only with an external database. Moving a database outside the
release does not exclude defects in our interaction with it.

## Same-host Docker network example

The supplied [application-only Compose file](../deploy/compose.external-db.yaml)
contains `server`, `migrate` and an explicit `db-setup` job. All three use the same
ULDA Server image. It has no database service, database volume, database build or
proxy. It attaches to an **existing** network owned by the operator.

Before starting, provision a dedicated PostgreSQL database on that private
Docker network. Give the database container a stable network alias, for example
`operator-postgres`. Keep its SQL port unpublished. Do not reuse an application
database with unrelated tables. Run exactly one ULDA Server writer; direct SQL
writers and other server replicas are unsupported.

From the repository root, set your own reviewed values:

```powershell
$env:ULDA_SERVER_IMAGE='organization/server@sha256:REPLACE_WITH_REVIEWED_DIGEST'
$env:ULDA_DATABASE_NETWORK='your-existing-database-network'
$env:PGHOST='operator-postgres'
$env:PGPORT='5432'
$env:PGDATABASE='ulda'
$env:ULDA_DB_ADMIN_USER='your-database-administrator'
$env:ULDA_SECRETS_DIR=(Resolve-Path ./secrets).Path
$env:CORS_ORIGINS='https://your-application.example'
```

Prepare three protected files in that directory: `postgres_admin_password`
containing the existing administrator credential, and new independent
`postgres_migration_password` / `postgres_runtime_password` credentials. Do not
print them or put them in command arguments, images or Git. Files must be
readable by the container's Node UID 1000; restrict host access appropriately.
Changing a file does not rotate an existing PostgreSQL account's password.

For a new dedicated database with no existing ULDA roles or tables:

```powershell
docker compose -f deploy/compose.external-db.yaml run --rm -e ULDA_DB_SETUP=1 db-setup
docker compose -f deploy/compose.external-db.yaml up -d --no-build
docker compose -f deploy/compose.external-db.yaml ps -a
curl.exe http://127.0.0.1:3000/ready
```

Check every exit status. Setup creates the restricted roles. The migration job
must finish successfully before the server starts. Runtime receives only its
own password file. The database administrator must have privileges to create
the roles and configure this dedicated database; a managed provider may require
DBA-assisted setup instead. Existing ULDA data requires a backup and the explicit
[adoption procedure](DEPLOYMENT.md#existing-volume-from-the-former-shared-superuser-configuration),
adapted to this Compose file and the operator's database management commands.

The example publishes HTTP only on loopback. Supply your own HTTPS/WSS endpoint
for remote clients. This recipe is for a private same-host Docker network;
off-host PostgreSQL needs separately configured and verified transport security.
It does not enable or certify database TLS. Review certificates and driver
configuration before deploying across hosts.

`docker compose -f deploy/compose.external-db.yaml down` stops the application
services; it cannot remove the externally managed database or its volume.
Database upgrades, backups and restoration are separate operator procedures.
Changing the database's major version or storage adapter requires a tested data
migration, not just changing an environment variable.

To test unreleased source locally, build only the application with
`docker build -t ulda/server:local .` and set `ULDA_SERVER_IMAGE=ulda/server:local`.
No database build is needed. The root `compose.yaml` and `deploy/postgres` /
`deploy/proxy` builds remain development/test fixtures with separately documented
[known findings](POSTGRES_SECURITY_REVIEW.md); they are not published production
dependencies of this server release.

## Other databases

See [storage adapters](STORAGE_ADAPTERS.md). PostgreSQL is built in. Other engines
require an implementation of the storage contract and their own integration,
failure, durability and operational checks. The SDK protocol does not change.
