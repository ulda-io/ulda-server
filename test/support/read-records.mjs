// Test-only raw read follows docs/SDK_PROTOCOL.md; no SDK private imports.
import { io } from "socket.io-client";
export async function readRecords(url, ids) {
  const socket = io(url, { transports: ["websocket"], reconnection: false, timeout: 5000 });
  try {
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    return await socket.timeout(5000).emitWithAck("ulda:read", ids);
  } finally { socket.close(); }
}
