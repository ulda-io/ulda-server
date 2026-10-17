# PostgreSQL deployment image

This image derives from the official PostgreSQL 18 Debian bookworm image.
PostgreSQL and Debian components retain their own licenses and copyright
notices in `/usr/share/doc`. The ULDA server license does not replace them.

The gosu 1.19 source is fetched from https://github.com/tianon/gosu with a
verified archive checksum. Its implementation is unchanged except for the
version label. ULDA rebuilds it
using Go 1.26.9, github.com/moby/sys/user 0.4.1 and golang.org/x/sys 0.44.0,
and labels the binary `1.19-ulda.1`. The compiler and source build tree are
absent from the runtime. Gosu and moby/sys/user use Apache-2.0; Go and x/sys
use BSD-style licenses. Their full license texts and dependency checksums
are retained alongside this notice.

OS package upgrades are applied. PostgreSQL JIT/LLVM, GnuPG installation
tools, the less pager and their unused dependencies are removed. Setuid and
setgid permission bits are removed from system executables. Package metadata,
the official database initialization scripts, backup tools and locales remain.

The inherited `ssl-cert-snakeoil` certificate and private key are removed from
the final filesystem. They remain recoverable from the public upstream image's
lower layers and must never be used as a deployment identity. GnuTLS's embedded
public self-test vectors remain unmodified; they are not operator credentials.
