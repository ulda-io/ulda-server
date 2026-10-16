import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Docker excludes unrelated files and private canaries before sending the build context", () => {
  const root = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const local = path.join(root, ".local"); fs.mkdirSync(local, { recursive: true });
  const out = fs.mkdtempSync(path.join(local, "context-check-"));
  const suffix = randomUUID(), created = [];
  try {
    for (const name of [`context-${suffix}.txt`, `src/context-${suffix}.key`]) {
      const target = path.join(root, name);
      fs.writeFileSync(target, "synthetic-private-context-marker", { flag: "wx" }); created.push(target);
    }
    try {
      execFileSync("docker", ["build", "--file", "-", "--output", `type=local,dest=${out}`, root], {
        input: "FROM scratch\nCOPY . /\n", encoding: "utf8", timeout: 60_000,
        maxBuffer: 1_048_576, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { throw new Error("Build-context check failed; raw Docker diagnostics suppressed."); }
    assert.deepEqual(fs.readdirSync(out).sort(), [".dockerignore", "Dockerfile", "LICENSE.md", "THIRD_PARTY_NOTICES.md", "migrations",
      "package-lock.json", "package.json", "src", "tsconfig.build.json", "tsconfig.json"].sort());
    assert.ok(fs.existsSync(path.join(out, "src/main.ts")));
    assert.ok(fs.existsSync(path.join(out, "migrations/postgres/001_create_ulda_resources.sql")));
    assert.equal(fs.existsSync(path.join(out, `src/context-${suffix}.key`)), false);
  } finally {
    for (const file of created) fs.unlinkSync(file);
    // Only the fresh task-owned directory under this repository may be removed.
    const resolved = fs.realpathSync(out);
    assert.equal(path.dirname(resolved), fs.realpathSync(local));
    assert.ok(path.basename(resolved).startsWith("context-check-"));
    fs.rmSync(resolved, { recursive: true });
  }
});
