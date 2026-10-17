# PostgreSQL image security assessment

Scope: this is the retained assessment of the repository's **test fixture**,
not the ULDA Server release image. The server-only release no longer distributes
this PostgreSQL image. Its unresolved CVEs have not been fixed or waived; they
remain findings for anyone choosing to deploy that image. The historical
package assessment below does not provide a production approval. See
[release boundaries](RELEASING.md) and [operator responsibilities](EXTERNAL_DATABASE.md).

Reviewed on 2026-10-17 for the Linux amd64 image built from the pinned PostgreSQL
18.6 bookworm base. This is an assessment of this deployment, not a claim that
PostgreSQL or Debian has no vulnerabilities. Recheck after any package, base,
authentication, extension or deployment change. Scanner severities and vendor
assessments can differ. Source-package findings can be repeated for multiple
binary packages; counts are not counts of independently reachable attacks.

## Critical findings

**CVE-2023-45853 — MiniZip, reported against zlib1g.**
The installed Debian `zlib1g` version `1:1.2.13.dfsg-1` does not contain the
vulnerable MiniZip implementation. Debian builds MiniZip separately in bookworm
and explicitly identifies this source-package finding as inapplicable to the
zlib binary packages. The image has no MiniZip package/files and libz exports no
`zipOpenNewFileInZip` name. This is a non-affected package assessment, not a
patched zlib claim. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2023-45853).

The CI assessment requires the exact OS, binary/source versions, architecture,
official package inventory and installed-file list. It applies only to the
PostgreSQL artifact whose identity was already verified, and expires on
2026-11-17. A changed version, missing evidence, reported fixed version, or a
MiniZip package in the inventory disables it. The full finding remains in the
Trivy report and raw severity counts. The assessment helper retains its expiry
and tests for any future auxiliary-image review; the application-only release
does not use this PostgreSQL exception. It is not a wildcard ignore rule.

**CVE-2026-6653 — libxml2 use-after-free.**
Debian still marks `2.9.14+dfsg-1.3~deb12u6` affected. Its bookworm fix is
postponed; the upstream repair is not present in this binary. The vulnerable
path parses malicious XML. PostgreSQL dynamically links libxml2 and provides
SQL XML functions. ULDA stores parameters as `bytea` and does not call those
functions, but that does not remove them from PostgreSQL or protect unrelated
SQL workloads. This finding would block publication of this PostgreSQL image
under the former full-stack gate. It is not exempted on the basis of encrypted
payloads; it is outside the application-only artifact, not a repaired package.
[Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-6653),
[PostgreSQL XML support](https://www.postgresql.org/docs/18/datatype-xml.html).

Switching to Debian trixie alone does not resolve the current libxml2 findings:
its stable package also uses the affected 2.9.14-based code. Do not mix unstable
distribution packages into the database image or remove a dynamically required
library to obtain a clean scan. A maintained fixed package, or a separately
reviewed PostgreSQL build without XML support, needs compatibility, upgrade,
backup and SDK acceptance before replacing the current artifact.

## Other findings that blocked the former database-image release

The following assessments describe conditions and remaining work. They are not
additional CI exemptions. None is marked fixed merely because the ordinary
ULDA request path does not exercise it. Linked Debian records include upstream
patch/advisory references and distribution status.

| Component / findings | Assessment for the supplied deployment |
| --- | --- |
| libxml2: [CVE-2026-86138](https://security-tracker.debian.org/tracker/CVE-2026-86138), [86140](https://security-tracker.debian.org/tracker/CVE-2026-86140), [86142](https://security-tracker.debian.org/tracker/CVE-2026-86142), [86143](https://security-tracker.debian.org/tracker/CVE-2026-86143), [86144](https://security-tracker.debian.org/tracker/CVE-2026-86144) | Dictionary/element formatting/XPointer/writer/XInclude defects. Upstream fixes exist; bookworm fixes are postponed. No general XML-package exemption. |
| libxml2 Python bindings: [CVE-2026-74860](https://security-tracker.debian.org/tracker/CVE-2026-74860) | The advisory requires Python SAX bindings. They are absent from this image; this does not resolve the separate C-library defects. |
| util-linux: [CVE-2026-53613](https://security-tracker.debian.org/tracker/CVE-2026-53613), [76642](https://security-tracker.debian.org/tracker/CVE-2026-76642), [78409](https://security-tracker.debian.org/tracker/CVE-2026-78409), [78410](https://security-tracker.debian.org/tracker/CVE-2026-78410) | Privileged mount/path handling. System SUID/SGID bits are removed and the running database has no effective capabilities; no application mount interface is exposed. Initialization still starts as root. Await package fixes or separately review exact code/version applicability. |
| util-linux: [CVE-2026-78408](https://security-tracker.debian.org/tracker/CVE-2026-78408), [53615](https://security-tracker.debian.org/tracker/CVE-2026-53615) | The installed nsenter lacks `--join-cgroup`; ULDA does not parse disk partitions or receive raw host devices. Keep the findings and reassess if deployment privileges change. |
| gzip: [CVE-2026-41992](https://security-tracker.debian.org/tracker/CVE-2026-41992) | Crafted LZH input. No resource is passed to gzip by ULDA. Restore/init archives must be trusted; no bookworm fix is currently supplied. |
| libacl: [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369) | Symlink-following ACL operations. Do not share writable initialization/backup directories with untrusted users. The upstream repair adds ABI and is not a safe isolated package patch. |
| LDAP: [CVE-2023-2953](https://security-tracker.debian.org/tracker/CVE-2023-2953) | Allocation-failure handling. LDAP authentication is not configured, but PostgreSQL requires the linked library; it cannot simply be deleted. |
| Perl: [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538), [82560](https://security-tracker.debian.org/tracker/CVE-2026-82560) | Crafted Archive::Tar input and Pod::Text resource exhaustion. No resource-to-tar/POD conversion exists. Perl remains a dependency of Debian's PostgreSQL tooling. Unknown severity blocked the former database artifact gate and still blocks any finding in the application artifact. |
| OpenSSL: [CVE-2026-84782](https://security-tracker.debian.org/tracker/CVE-2026-84782) | DTLS handshake issue. PostgreSQL does not use DTLS; the optional external HTTPS proxy is a separate image. This is a configuration assessment, not an OpenSSL patch. |
| systemd: [CVE-2026-16742](https://security-tracker.debian.org/tracker/CVE-2026-16742) | The vulnerable homed service and helper are absent; `libsystemd0` is linked by PostgreSQL. No homed-managed users exist in this deployment. |
| ncurses: [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720) | Vendor review describes a CLI-tool crash; affected binaries/ranges still need precise upstream confirmation. Do not declare the whole package safe or silently downgrade scanner severity. |

## Public test keys inherited from upstream

The upstream image contains `/etc/ssl/private/ssl-cert-snakeoil.key` and its
certificate. These are a shared test identity, not an operator secret. The
derived image removes both from its final filesystem. Container/deployment
tests verify absence before and after initialization. The standard internal
database has `ssl=off`; the optional Nginx proxy uses certificates mounted by
the operator. Enabling database TLS requires a separately provisioned identity.

Deletion in a later Docker layer does **not** erase the public test key from
the upstream layers. Anyone pulling the image can recover those old bytes.
Never use that identity for real TLS, even if copied out under another name.

The six complete private-key blocks embedded in `libgnutls.so.30.34.3` match the
public vectors in GnuTLS 3.7.9's
[public-key self tests](https://github.com/gnutls/gnutls/blob/3.7.9/lib/crypto-selftests-pk.c).
All six were compared by SHA-256 without printing or copying their contents
into this repository. The reviewed source-file SHA-256 is
`c3d79122e072177f55dc30a98f68b949c0f36f6159a363aae9512a22a9280ed0`;
the installed library SHA-256 is
`779b25d20249988bea2c1aa6bbeb218f5ae7ea8a9d30ce4f54ea37372965cc4b`.
These public vectors remain unmodified. Removing bytes from a crypto library
would break its self tests and is not a sound secret-removal technique. These
fingerprints are review evidence, not an exemption for arbitrary future keys.

Application/deployment test credentials are generated in disposable local test
directories, excluded from Git and image build contexts, and removed after
successful cleanup. Full image-layer inspection is still required: checking
only the final filesystem cannot establish the absence of secrets in history.
