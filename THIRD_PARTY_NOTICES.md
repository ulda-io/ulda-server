# Third-party notices

The [server license](LICENSE.md) covers the server's own materials only.
Dependencies retain their own licenses and copyright notices. The runtime image
keeps the installed packages, including their upstream license files. Do not
remove those notices when redistributing the image.

## Application dependencies

This index follows the production dependency graph in `package-lock.json`.
Paths are relative to `/app/` inside the image or the installed repository root.
Some packages place their full license text in README.md. The original files,
not the short labels below, contain the applicable terms.

| Package | Version | License | Retained notice path |
| --- | --- | --- | --- |
| `@socket.io/component-emitter` | 3.1.2 | MIT | `node_modules/@socket.io/component-emitter/LICENSE` |
| `@types/cors` | 2.8.19 | MIT | `node_modules/@types/cors/LICENSE` |
| `@types/node` | 24.13.3 | MIT | `node_modules/@types/node/LICENSE` |
| `@types/ws` | 8.18.1 | MIT | `node_modules/@types/ws/LICENSE` |
| `accepts` | 1.3.8 | MIT | `node_modules/accepts/LICENSE` |
| `base64id` | 2.0.0 | MIT | `node_modules/base64id/LICENSE` |
| `cookie` | 0.7.2 | MIT | `node_modules/cookie/LICENSE` |
| `cors` | 2.8.6 | MIT | `node_modules/cors/LICENSE` |
| `debug` | 4.4.3 | MIT | `node_modules/debug/LICENSE` |
| `engine.io` | 6.6.11 | MIT | `node_modules/engine.io/LICENSE` |
| `engine.io-parser` | 5.2.3 | MIT | `node_modules/engine.io-parser/LICENSE` |
| `mime-db` | 1.52.0 | MIT | `node_modules/mime-db/LICENSE` |
| `mime-types` | 2.1.35 | MIT | `node_modules/mime-types/LICENSE` |
| `ms` | 2.1.3 | MIT | `node_modules/ms/license.md` |
| `negotiator` | 0.6.3 | MIT | `node_modules/negotiator/LICENSE` |
| `object-assign` | 4.1.1 | MIT | `node_modules/object-assign/license` |
| `pg` | 8.22.0 | MIT | `node_modules/pg/LICENSE` |
| `pg-cloudflare` | 1.4.0 | MIT | `node_modules/pg-cloudflare/LICENSE` |
| `pg-connection-string` | 2.14.0 | MIT | `node_modules/pg-connection-string/LICENSE` |
| `pg-int8` | 1.0.1 | ISC | `node_modules/pg-int8/LICENSE` |
| `pg-pool` | 3.14.0 | MIT | `node_modules/pg-pool/LICENSE` |
| `pg-protocol` | 1.16.0 | MIT | `node_modules/pg-protocol/LICENSE` |
| `pg-types` | 2.2.0 | MIT | `node_modules/pg-types/README.md` |
| `pgpass` | 1.0.5 | MIT | `node_modules/pgpass/README.md` |
| `postgres-array` | 2.0.0 | MIT | `node_modules/postgres-array/license` |
| `postgres-bytea` | 1.0.1 | MIT | `node_modules/postgres-bytea/license` |
| `postgres-date` | 1.0.7 | MIT | `node_modules/postgres-date/license` |
| `postgres-interval` | 1.2.0 | MIT | `node_modules/postgres-interval/license` |
| `socket.io` | 4.8.3 | MIT | `node_modules/socket.io/LICENSE` |
| `socket.io-adapter` | 2.5.8 | MIT | `node_modules/socket.io-adapter/LICENSE` |
| `socket.io-parser` | 4.2.7 | MIT | `node_modules/socket.io-parser/LICENSE` |
| `split2` | 4.2.0 | ISC | `node_modules/split2/LICENSE` |
| `ulda-core` | 1.0.1 | ULDA Core Community Source License 1.0 | `node_modules/ulda-core/LICENSE.md` |
| `undici-types` | 7.18.2 | MIT | `node_modules/undici-types/LICENSE` |
| `vary` | 1.1.2 | MIT | `node_modules/vary/LICENSE` |
| `ws` | 8.21.3 | MIT | `node_modules/ws/LICENSE` |
| `xtend` | 4.0.2 | MIT | `node_modules/xtend/LICENSE` |

The core license applies independently, including its commercial-use conditions.
The client SDK `ulda-auth` is installed by test consumers and client applications;
it is not a server runtime dependency.

## Container and external services

The Node.js/Debian base image has separately licensed components. Node's
distribution includes its own licenses; Debian package copyright and license
notices are under `/usr/share/doc/<package>/copyright` where supplied by the
base distribution. Preserve the base image's notices and comply with each
component's redistribution terms, including source obligations where applicable.
This npm dependency index is not an inventory of every operating-system package.

PostgreSQL and the optional Nginx proxy run as separate images. Their source,
binaries and image layers are not relicensed by the ULDA Server license.
See the upstream [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE),
[Debian copyright information](https://www.debian.org/doc/debian-policy/ch-docs.html#copyright-information),
[PostgreSQL license](https://www.postgresql.org/about/licence/) and
[Nginx license](https://nginx.org/LICENSE).

Development and test dependencies remain in the repository lockfiles and retain
their own terms. They are not installed by the server runtime stage. Recheck this
index and retained notices whenever the production dependency graph changes.
