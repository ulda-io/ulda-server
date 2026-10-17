// Public package exports only. This consumer is excluded from the server image.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, isAbsolute } from "node:path";
const root = realpathSync(fileURLToPath(new URL("./node_modules/ulda-auth/", import.meta.url)));
const entry = realpathSync(fileURLToPath(import.meta.resolve("ulda-auth")));
const within = relative(root, entry);
if (within.startsWith("..") || isAbsolute(within)) throw new Error("Install the isolated SDK consumer with npm ci.");
const manifest = JSON.parse(readFileSync(new URL("./node_modules/ulda-auth/package.json", import.meta.url)));
if (manifest.name !== "ulda-auth" || manifest.version !== "1.1.0") throw new Error("Expected published ulda-auth@1.1.0.");
export const sdkIdentity = Object.freeze({ name: manifest.name, version: manifest.version });
export { Ulda, SocketIoTransport } from "ulda-auth";
