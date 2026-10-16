import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import test from "node:test";

function probe(name, script, flags = []) {
  const image = process.env[`ULDA_TEST_${name}_IMAGE`];
  assert.ok(image && !image.startsWith("-"), "Provide an explicit auxiliary test image.");
  try {
    return execFileSync("docker", ["run", "--rm", "--network", "none", ...flags,
      "--entrypoint", "sh", image, "-ec", script], {encoding:"utf8", timeout:30000,
      stdio:["ignore","pipe","pipe"], windowsHide:true}).trim();
  } catch { throw new Error("Auxiliary image check failed; raw diagnostics suppressed."); }
}

test("PostgreSQL retains backup/locale tools and drops to the configured non-root groups", () => {
  assert.equal(probe("POSTGRES", `
    test "$(gosu postgres id -u)" = 999
    test "$(gosu postgres id -G)" = "$(id -G postgres)"
    test "$(gosu postgres sh -c 'printf %s "$HOME"')" = /var/lib/postgresql
    test "$(gosu 999:999 id -G)" = 999
    if gosu does-not-exist true 2>/dev/null; then exit 1; fi
    if gosu postgres sh -c 'exit 17'; then exit 1; else test "$?" = 17; fi
    gosu --version | grep -F '1.19-ulda.1 (go1.26.9'
    postgres --version | grep -F '18.6'
    pg_dump --version >/dev/null; pg_restore --version >/dev/null
    locale -a | grep -qi '^en_US.utf8$'
    test -s /var/lib/dpkg/status
    for f in gosu-LICENSE go-LICENSE moby-sys-user-LICENSE x-sys-LICENSE go.mod go.sum ULDA-NOTICE.md; do
      test -s "/usr/local/share/licenses/gosu/$f"
    done
    test -z "$(find /usr /bin /sbin -xdev -type f -perm /6000 -print)"
    if dpkg-query -W -f='\${db:Status-Status}\\n' postgresql-18-jit libllvm19 gnupg less 2>/dev/null | grep -q '^installed$'; then exit 1; fi
    printf '\\nPASS'
  `, ["--security-opt","no-new-privileges:true"]).split("\n").at(-1), "PASS");
});

test("slim proxy runs without privileges and omits XML/image dependencies", () => {
  assert.equal(probe("PROXY", `
    test "$(id -u)" = 101
    test -s /lib/apk/db/installed
    nginx -v 2>&1 | grep -F '1.30.6'
    apk --no-network list --installed zlib | grep -F '1.3.2-r1'
    if grep -Eq '^P:(libxml2|expat|libpng|libxslt|perl)$' /lib/apk/db/installed; then exit 1; fi
    test -z "$(find /usr /bin /sbin -xdev -type f -perm /6000 -print)"
    printf '\\nPASS'
  `, ["--user","101:101","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges:true"]).split("\n").at(-1), "PASS");
});
