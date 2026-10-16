import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPasswordFile, postgresFilePassword } from "../../src/storage/postgres/password-file.js";
const dirs: string[] = [];
function secret(value: string) { const dir=mkdtempSync(join(tmpdir(),"ulda-secret-test-")); dirs.push(dir); const file=join(dir,"password"); writeFileSync(file,value); return file; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
describe("mounted PostgreSQL password", () => {
  it("preserves spaces and punctuation, removes one final newline", () => {
    expect(readPasswordFile(secret(" synthetic ' \\ secret \r\n"))).toBe(" synthetic ' \\ secret ");
  });
  it("rejects missing, empty, oversized or multiline files without disclosing input", () => {
    for (const file of [secret(""),secret("x".repeat(4097)),secret("synthetic\nprivate"),"synthetic-private-missing"]) {
      expect(() => readPasswordFile(file)).toThrow("PostgreSQL password file is missing or invalid.");
    }
  });
  it("fails closed on ambiguous credentials", () => {
    const file=secret("synthetic-password");
    for (const env of [{PGPASSWORD_FILE:file,PGPASSWORD:"other"},{PGPASSWORD_FILE:file,PGSERVICE:"other"}]) expect(()=>postgresFilePassword(env)).toThrow("another credential source");
    expect(()=>postgresFilePassword({PGPASSWORD_FILE:file},"postgres://synthetic")).toThrow("another credential source");
    expect(postgresFilePassword({PGPASSWORD_FILE:file})).toBe("synthetic-password");
    expect(postgresFilePassword({PGPASSWORD:"legacy"})).toBeUndefined();
  });
});
