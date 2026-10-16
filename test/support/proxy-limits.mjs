import assert from "node:assert/strict";
import https from "node:https";
import {io} from "socket.io-client";
const sockets=[];
async function status(options={}) {
 return new Promise((resolve,reject)=>{
  const request=https.request(process.env.ULDA_SERVER_URL+"/socket.io/?EIO=4&transport=polling",options,response=>{response.resume();resolve(response.statusCode);});
  request.setTimeout(5000,()=>request.destroy(new Error("deadline")));request.on("error",reject);request.end();
 });
}
try {
 assert.equal(await status({method:"POST",headers:{"Content-Length":"9000000"}}),413);
 for(let i=0;i<20;i++){
  const socket=io(process.env.ULDA_SERVER_URL,{transports:["websocket"],reconnection:false,timeout:5000});sockets.push(socket);
  await new Promise((resolve,reject)=>{socket.once("connect",resolve);socket.once("connect_error",reject);});
 }
 assert.equal(await status(),429);
 console.log("PASS proxy rejects oversized HTTP bodies and excess per-IP connections");
} catch {process.exitCode=1;console.error("FAIL proxy limits; private diagnostics suppressed.");}
finally {for(const socket of sockets)socket.close();}
