# PostgreSQL and TLS proxy images

Compose builds three separate images. The client SDK still connects only to the
application server; PostgreSQL and the proxy do not import `ulda-auth` or decrypt
application resources. Auxiliary Docker build contexts allow only their build
files, dependency checksums and notices. Local secrets, backups and source trees
are not copied into them.

## PostgreSQL

`deploy/postgres/Dockerfile` derives from official PostgreSQL 18.6 bookworm,
pinned by digest. It retains Debian/glibc, the official entrypoint, UID 999,
the PostgreSQL 18 volume layout, locales, `psql`, `pg_dump` and `pg_restore`.
Available OS updates are installed. It removes PostgreSQL JIT/LLVM, GnuPG
installation tools, `less` and their unused dependencies. ULDA's prepared
resource queries do not require JIT. Do not use this image for unrelated
workloads that need those tools. Removing files in a derived image does not
remove their bytes from existing lower image layers.

The official gosu 1.19 implementation is rebuilt with Go 1.26.9 and updated,
checksum-locked moby/sys/user and x/sys dependencies. Its version label identifies
the rebuild. The compiler is confined to a build stage; full third-party license
texts and module checksums are retained under `/usr/local/share/licenses/gosu`.
The archive checksum is checked before compilation. See the
[modification notice](../deploy/postgres/NOTICE.md).

System executable setuid/setgid bits are removed. Compose sets
`no-new-privileges`; initialization starts as root, then the official entrypoint
uses gosu to replace itself with PostgreSQL as UID 999. The database is not a
rootless/read-only container: it must initialize/chown and write its volume.
It has no published port and uses separate runtime/migration credentials.

## Nginx

`deploy/proxy/Dockerfile` uses official stable Nginx 1.30.6 Alpine 3.24 slim,
pinned by digest, plus available Alpine updates. The unused dynamic XML, XSLT,
image-filter and Perl module dependencies are omitted by this upstream variant.
Core TLS and WebSocket proxy support remain. The supplied configuration does not
enable HTTP/2, HTTP/3, mail, stream, or arbitrary module loading.

The TLS overlay keeps UID/GID 101, read-only storage, no capabilities,
`no-new-privileges`, bounded temporary storage and resource limits. Only
`/socket.io/` is forwarded. [TLS deployment](DEPLOYMENT.md#httpswss-proxy).

## Build and verify

Use new local tags, not tags serving an active deployment:

```powershell
docker build --pull --no-cache -t ulda/postgres:security-check deploy/postgres
docker build --pull --no-cache -t ulda/proxy:security-check deploy/proxy
$env:ULDA_TEST_POSTGRES_IMAGE='ulda/postgres:security-check'
$env:ULDA_TEST_PROXY_IMAGE='ulda/proxy:security-check'
node --test test/container/auxiliary.test.mjs
```

Where Docker Scout component-metadata submission is authorized, scan all images
in full. Keep the exact image IDs, platform and reports. An `--only-fixed` result
does not cover vulnerabilities that lack distribution fixes. Do not delete the
dpkg/APK databases, hide findings, or treat a passing scan as proof of absence
of vulnerabilities. OS update layers require an uncached rebuild to refresh.

```powershell
docker scout cves local://ulda/postgres:security-check
docker scout cves local://ulda/proxy:security-check
$env:ULDA_TEST_IMAGE='ulda/server:security-check'
npm run test:integration
npm run test:deployment
```

The application image must already exist when passed explicitly. Deployment
also runs auxiliary image tests. Tests retain only safe result summaries after
successful cleanup. Repeat capacity acceptance for a changed database artifact;
results for the previous image do not certify the new one.

For deployment, `ULDA_SERVER_IMAGE`, `ULDA_POSTGRES_IMAGE` and `ULDA_PROXY_IMAGE`
select independent images. Use reviewed registry digests once published, or
local image IDs for local acceptance, and `--no-build` when starting them. A base
digest alone does not identify the final image after OS package updates.

## Existing PostgreSQL volumes

Before a same-major update, stop writes, make a trusted backup and prove restore
on another volume. Record old/new image IDs, database version, installed
extensions and `datcollversion`/`pg_database_collation_actual_version` from
`pg_database`. Preserve the Compose project, volume, passwords and role names.
Stop PostgreSQL cleanly, then recreate only that service with the reviewed image.
Wait for health and verify stored resource fingerprints, sequence state and SDK
read/update/create before reopening traffic. Do not rerun initial role setup on
an already managed volume.

Review the [PostgreSQL 18.6 migration notes](https://www.postgresql.org/docs/release/18.6/):
same-major updates do not require a dump/restore, but custom replication plugins,
pgcrypto usage or certain extension indexes can require additional work. The
standard ULDA schema uses none of those extensions. A libc/ICU change can require
reindexing; do not merely refresh collation metadata to hide a mismatch. Major
version changes require their own migration. Rollback after data/schema changes
may require restoring the tested backup to a new volume.

## Residual package findings

Evaluate each advisory against the exact artifact and enabled functions. For
the supplied deployment, PostgreSQL does not expose DTLS, process uploaded POD
or tar files, probe disks, or authenticate through LDAP/SASL DIGEST-MD5. Package
findings for these paths must still be retained and reassessed if the operator
adds extensions, authentication methods, scripts or privileged mounts.

Examples of the required distinctions are OpenSSL's
[DTLS-specific advisory](https://openssl-library.org/news/secadv/20260929.txt),
the [SASL DIGEST-MD5 plugin issue](https://github.com/cyrusimap/cyrus-sasl/issues/889),
and the [disputed affected range of zlib's gz writer](https://github.com/madler/zlib/issues/1310).
An absent plugin or disabled protocol is a deployment-specific assessment,
not an upstream patch. Retain unresolved vendor findings; do not globally
allowlist whole packages. Recheck full reports before each release and after
changes to the image or deployment configuration.
