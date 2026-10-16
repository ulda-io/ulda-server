// Test-only process boundary: exit after a real COMMIT, before publication or ACK.
import { createUldaServer } from "../../dist/app/create-server.js";
import { loadConfig } from "../../dist/config/config.js";
import { PostgresResourceStorage } from "../../dist/storage/postgres/postgres-resource-storage.js";
import { requireTestDatabase } from "./test-database.mjs";
const connectionString = requireTestDatabase();
const config = loadConfig({ LOG_LEVEL: "error" }); config.host = "127.0.0.1"; config.port = Number(process.env.CRASH_TEST_PORT ?? 0);
const storage = new PostgresResourceStorage({ connectionString, maxConnections: 4, connectionTimeoutMs: 5000, idleTimeoutMs: 5000 });
let armed = false, writes = 0;
const apply = storage.applyBatch.bind(storage);
storage.applyBatch = async changes => { await apply(changes); writes++; if (armed) process.exit(77); };
const server = createUldaServer({ config, storage });
process.on("message", message => {
  if (message?.type === "arm") { armed = true; process.send?.({ type: "armed" }); }
  if (message?.type === "counts") process.send?.({ type: "counts", writes });
  if (message?.type === "close") void server.close().then(() => process.exit(0));
});
const { port } = await server.start(); process.send?.({ type: "ready", port });
