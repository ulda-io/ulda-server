import assert from "node:assert/strict";
import fs from "node:fs";
import {Ulda,SocketIoTransport} from "../consumer/index.mjs";
const clients=[];
try {
 const saved=JSON.parse(fs.readFileSync(process.env.ULDA_SMOKE_STATE_FILE,"utf8"));
 const transport=new SocketIoTransport(process.env.ULDA_SERVER_URL), ulda=new Ulda(process.env.ULDA_SERVER_URL,{transport,reconnect:false});clients.push(ulda);
 await ulda.connect(saved.id,"synthetic-container-smoke-passphrase");
 await ulda.update("container-check-X",{n:43,text:"synthetic restore update"});
 assert.equal(ulda.value("container-check-X").n,43);
 const created=[];transport.on("trace",e=>{if(e.phase==="ack"&&e.event==="ulda:create")created.push(...e.ids);});
 await ulda.add("after-restore",{n:1},"S");
 assert.equal(created.length,1); assert.ok(saved.ids.every(id=>BigInt(created[0])>BigInt(id)));
 await ulda.superDelete();
 console.log("PASS restored SDK update, identity sequence and deletion");
} catch {process.exitCode=1;console.error("FAIL restored SDK; private diagnostics suppressed.");}
finally {for(const client of clients)await client.close();}
