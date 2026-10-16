import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// A mounted local secret, never an untrusted request path. Keep failures fixed.
export function readPasswordFile(filename: string): string {
  let fd: number | undefined;
  const bytes = Buffer.alloc(4097);
  try {
    fd = openSync(filename, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error();
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    const value = bytes.subarray(0, size).toString("utf8").replace(/\r?\n$/u, "");
    if (!value || size > 4096 || /[\r\n\0]/u.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error("PostgreSQL password file is missing or invalid.");
  } finally {
    bytes.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

export function postgresFilePassword(env: NodeJS.ProcessEnv, connectionString?: string): string | undefined {
  if (!env.PGPASSWORD_FILE) return undefined;
  if (env.PGPASSWORD !== undefined || connectionString !== undefined || env.PGSERVICE !== undefined) {
    throw new Error("PGPASSWORD_FILE cannot be combined with another credential source.");
  }
  return readPasswordFile(env.PGPASSWORD_FILE);
}
