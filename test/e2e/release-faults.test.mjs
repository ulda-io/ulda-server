// Destructive fault injection is restricted to the dedicated release test database.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Ulda,SocketIoTransport} from '../consumer/index.mjs';
import {requireTestDatabase} from '../support/test-database.mjs';
import {createUldaServer} from '../../dist/app/create-server.js';
import {loadConfig} from '../../dist/config/config.js';
import {PostgresResourceStorage} from '../../dist/storage/postgres/postgres-resource-storage.js';
import {runPostgresMigrations} from '../../dist/storage/postgres/migrations.js';
const connectionString=requireTestDatabase();
function saveResult(name,data){const folder=process.env.ULDA_TEST_RESULTS_DIR;if(!folder)return;mkdirSync(folder,{recursive:true});writeFileSync(join(folder,name),JSON.stringify(data,null,2)+'\n');}
const pool=new Pool({connectionString,max:4});
const dbOptions={connectionString,maxConnections:8,connectionTimeoutMs:5000,idleTimeoutMs:5000};
const password='synthetic-release-fault-passphrase';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
before(async()=>{const client=await pool.connect();try{await runPostgresMigrations(client,resolve('migrations/postgres'));}finally{client.release();}});
after(()=>pool.end());
async function until(fn){for(let i=0;i<400;i++){if(fn())return;await sleep(10);}assert.fail('Controlled state not reached');}
async function setup(t){
 await pool.query('TRUNCATE public.ulda_resources');
 const config=loadConfig({LOG_LEVEL:'error'});config.host='127.0.0.1';config.port=0;
 const server=createUldaServer({config,storage:new PostgresResourceStorage(dbOptions)});
 const {port}=await server.start(),url='http://127.0.0.1:'+port,clients=[];
 let closing;const stop=()=>closing??=server.close();
 async function client(timeout=10000,reconnect=false){
  const transport=new SocketIoTransport(url,{allowInsecureLocalhost:true,timeout});
  const ulda=new Ulda(url,{transport,reconnect}),trace=[];
  transport.on('trace',e=>trace.push(e));clients.push(ulda);await ulda.ready;
  const socket=[...server.io.sockets.sockets.values()].at(-1);
  return {ulda,transport,trace,socket};
 }
 t.after(async()=>{for(const ulda of clients)await ulda.close();await stop();assert.equal(server.router.subscriptionTotal,0);await pool.query('TRUNCATE public.ulda_resources');});
 return {server,client,stop};
}
const rows=ids=>pool.query('SELECT id::text,witness,payload FROM public.ulda_resources WHERE id=ANY($1::bigint[]) ORDER BY id',[ids]).then(r=>r.rows);
function staleLast(c,event,witness){c.socket.use((args,next)=>{if(args[0]===event&&args[1].length===2)args[1][1].witness=Buffer.from(witness);next();});}

test('late invalid update member leaves both PostgreSQL rows unchanged',{timeout:20000},async t=>{
 const {server,client}=await setup(t),a=await client();const master=await a.ulda.register(password);
 const [original]=await rows([master]);let reservation;
 const create=server.storage.createBatch.bind(server.storage);
 server.storage.createBatch=async items=>{const result=await create(items);reservation=result[0];return result;};
 staleLast(a,'ulda:update',original.witness);
 await assert.rejects(a.ulda.add('item',{value:1}),{code:'CONFLICT'});
 assert.deepEqual((await rows([master]))[0],original);
 const stored=await server.storage.findById(reservation.id);
 assert.deepEqual(stored,reservation);assert.equal(Object.keys(a.ulda.snapshot()).length,0);
});

test('late invalid catalog member prevents the entire mixed Delete',{timeout:20000},async t=>{
 const {client}=await setup(t),a=await client();const master=await a.ulda.register(password);await a.ulda.add('item',{value:1});
 const content=a.trace.filter(e=>e.phase==='ack'&&e.event==='ulda:create').at(-1).ids[0];
 const original=await rows([master,content]);staleLast(a,'ulda:delete',original.find(r=>r.id===master).witness);
 await assert.rejects(a.ulda.delete('item'),{code:'CONFLICT'});assert.deepEqual(await rows([master,content]),original);
});

async function stagedReaders(t){
 const ctx=await setup(t),a=await ctx.client();const master=await a.ulda.register(password);
 await a.ulda.add('first',{value:0});await a.ulda.add('last',{value:0});
 const b=await ctx.client();await b.ulda.connect(master,password);
 const emit=b.socket.emit.bind(b.socket);b.socket.emit=(event,...args)=>event==='ulda:changed'?b.socket:emit(event,...args);
 await a.ulda.update('first',{value:1});await a.ulda.update('last',{value:1});
 return {...ctx,a,b,emit};
}
test('bad last Read item never publishes the earlier valid content',{timeout:20000},async t=>{
 const {b}=await stagedReaders(t);
 b.socket.use((args,next)=>{if(args[0]==='ulda:read'&&args[1].length===2){const ack=args[2];args[2]=reply=>{
   if(reply.ok){const item=reply.data.at(-1);item.payload=Buffer.from(item.payload);item.payload[item.payload.length-1]^=1;}
   ack(reply);
 };}next();});
 await assert.rejects(b.ulda.refresh(),{code:'CRYPTO_FAILED'});
 assert.equal(b.ulda.value('first').value,0);assert.equal(b.ulda.value('last').value,0);
});
test('bad last Changed item never publishes the earlier valid content',{timeout:20000},async t=>{
 const {server,a,b,emit}=await stagedReaders(t);
 const ids=a.trace.filter(e=>e.phase==='ack'&&e.event==='ulda:create').slice(1).flatMap(e=>e.ids);
 const records=await server.storage.findManyByIds(ids.map(BigInt));
 const updated=records.map(r=>({id:r.id.toString(),witness:r.witness,payload:r.payload}));
 updated.at(-1).payload=Buffer.from(updated.at(-1).payload);updated.at(-1).payload[updated.at(-1).payload.length-1]^=1;
 const fault=new Promise(resolve=>b.ulda.on('error',resolve));emit('ulda:changed',{updated,deleted:[]});
 assert.equal((await fault).code,'CRYPTO_FAILED');assert.equal(b.ulda.value('first').value,0);assert.equal(b.ulda.value('last').value,0);
});

test('lost recovery commit ACK under independent writes is reconciled without replay', {timeout:30000},async t=>{
 const {server,client}=await setup(t),victim=await client(200);const master=await victim.ulda.register(password);await victim.ulda.add('item',{value:1});
 const previous=victim.trace.filter(e=>e.phase==='ack'&&e.event==='ulda:create').at(-1).ids[0];
 const others=[];for(let i=0;i<12;i++){const c=await client();await c.ulda.register(password);await c.ulda.add('item',{value:0});others.push(c);}
 let updates=0,creates=0,completedOthers=0,backgroundAtCommit;
 victim.socket.use((args,next)=>{if(args[0]==='ulda:update'){updates++;backgroundAtCommit=completedOthers;args[2]=()=>{};}if(args[0]==='ulda:create')creates++;next();});
 const background=Promise.all(others.map(async c=>{for(let value=1;value<=20;value++){await c.ulda.update('item',{value});completedOthers++;}}));
 await assert.rejects(victim.ulda.recoverContent('item'),{code:'UNKNOWN_OUTCOME'});
 await background;
 // Reconnect reads the committed catalog, but a retained repair plan still requires
 // an explicit recoverContent call; it must not silently replay its Update.
 await assert.rejects(victim.ulda.reconnect(),{code:'NEEDS_RESYNC'});
 const reconciled=await victim.ulda.recoverContent('item');assert.equal(reconciled.reconciled,true);
 assert.equal(victim.ulda.status,'open');assert.equal(victim.ulda.value('item').value,1);
 const current=victim.trace.filter(e=>e.phase==='ack'&&e.event==='ulda:create').at(-1).ids[0];
 assert.notEqual(current,previous);assert.ok(await server.storage.findById(BigInt(previous)));
 assert.equal(updates,1);assert.equal(creates,1);assert.ok(backgroundAtCommit<240);assert.equal(completedOthers,240);
 for(const c of others){await c.ulda.refresh();assert.equal(c.ulda.value('item').value,20);}
});

// Same-process monotonic timestamps isolate commit-observed -> decrypt -> public change.
// This complements the Docker fan-out throughput runs; it is not a server capacity test.
test('50 readers accept every committed Changed, and the author receives no echo', {timeout:60000},async t=>{
 const {server,client}=await setup(t),a=await client();const master=await a.ulda.register(password);
 await a.ulda.add('item',{seq:0,text:'x'.repeat(992)});
 const peers=[];for(let i=0;i<50;i++){const b=await client();await b.ulda.connect(master,password);peers.push(b);}
 let active=false,commitAt=0,authorEchoes=0,bytes=0,accepted=0;
 const commitToAccepted=[],receiveToAccepted=[];
 const apply=server.storage.applyBatch.bind(server.storage);
 server.storage.applyBatch=async items=>{await apply(items);if(active)commitAt=performance.now();};
 a.transport.on('trace',e=>{if(active&&e.phase==='push')authorEchoes++;});
 for(const b of peers){
  let receivedAt=0;
  b.transport.on('trace',e=>{if(active&&e.phase==='push'){receivedAt=performance.now();bytes+=(e.updated??[]).reduce((n,x)=>n+x.witnessBytes+x.payloadBytes,0);}});
  b.ulda.on('change',()=>{if(active){const now=performance.now();commitToAccepted.push(now-commitAt);receiveToAccepted.push(now-receivedAt);accepted++;}});
 }
 active=true;const startedAt=new Date().toISOString();
 for(let seq=1;seq<=100;seq++){await a.ulda.update('item',{seq,text:'x'.repeat(992)});await until(()=>peers.every(b=>b.ulda.value('item').seq===seq));}
 active=false;assert.equal(accepted,5000);assert.equal(authorEchoes,0);
 const summary=values=>{values.sort((a,b)=>a-b);return {count:values.length,p50Ms:values[Math.ceil(values.length*.5)-1],p95Ms:values[Math.ceil(values.length*.95)-1],p99Ms:values[Math.ceil(values.length*.99)-1],maxMs:values.at(-1)};};
 saveResult('fanout-components.json',{startedAt,finishedAt:new Date().toISOString(),readers:50,updates:100,accepted,authorEchoes,binaryBytesReceived:bytes,
  byteLayer:'witness+payload only',clock:'one Node process for timestamp observation; real PostgreSQL',
  commitObservedToAccepted:summary(commitToAccepted),transportReceiveToAccepted:summary(receiveToAccepted),verified:true});
});


test('overlapping reversed batches serialize while a disjoint PostgreSQL write progresses', {timeout:20000},async t=>{
 const {server,client}=await setup(t),a=await client();const master=await a.ulda.register(password);
 const b=await client();await b.ulda.connect(master,password);
 const independent=await client();await independent.ulda.register(password);await independent.ulda.add('item',{value:0});
 const read=server.storage.findManyByIds.bind(server.storage);const release=Promise.withResolvers();let held=false,secondArrived=false,second;
 server.storage.findManyByIds=async(ids,...args)=>{const records=await read(ids,...args);
  if(!held&&ids.length===2&&ids.includes(BigInt(master))){held=true;await release.promise;}return records;};
 b.socket.use((args,next)=>{if(args[0]==='ulda:update'){args[1].reverse();secondArrived=true;}next();});
 const first=a.ulda.add('alpha',{value:1}).then(()=> 'OK',e=>e.code);
 try{
  await until(()=>held);second=b.ulda.add('beta',{value:2}).then(()=> 'OK',e=>e.code);
  await until(()=>secondArrived);
  // This must finish while the first batch is deliberately held, proving no global lock.
  await independent.ulda.update('item',{value:1});assert.equal(independent.ulda.value('item').value,1);
  release.resolve();assert.equal(await first,'OK');assert.equal(await second,'CONFLICT');
  await b.ulda.refresh();assert.equal(b.ulda.value('alpha').value,1);assert.equal(Object.hasOwn(b.ulda.snapshot(),'beta'),false);
 }finally{release.resolve();await Promise.allSettled([first,second].filter(Boolean));}
});


test('automatic reconnect exhausts its bounded attempts without replay or a late revival', {timeout:10000},async t=>{
 const {client,stop}=await setup(t);const c=await client(100,{maxAttempts:3,initialDelay:20,maxDelay:20,jitter:0,budget:1500});
 await c.ulda.register(password);await c.ulda.add('item',{value:1});
 let attempts=0,stopped;
 c.ulda.on('reconnect',event=>{if(event.phase==='attempt')attempts++;if(event.phase==='stopped')stopped=event;});
 const before=c.trace.filter(e=>e.phase==='send'&&['ulda:create','ulda:update','ulda:delete'].includes(e.event)).length;
 await stop();await until(()=>stopped);assert.equal(attempts,3);assert.equal(stopped.code,'OFFLINE');
 assert.equal(c.ulda.status,'disconnected');assert.equal(c.ulda.value('item').value,1);
 await sleep(200);assert.equal(attempts,3);assert.equal(c.ulda.status,'disconnected');
 assert.equal(c.trace.filter(e=>e.phase==='send'&&['ulda:create','ulda:update','ulda:delete'].includes(e.event)).length,before);
 await c.ulda.close();await sleep(100);assert.equal(c.ulda.status,'closed');assert.equal(attempts,3);
});


test('process exits after PostgreSQL commit and before ACK or Changed; restart reconciles without writes', {timeout:20000},async t=>{
 const {spawn}=await import('node:child_process');await pool.query('TRUNCATE public.ulda_resources');
 const children=[],clients=[];
 async function launch(port=0){
  const child=spawn(process.execPath,['test/support/crash-runtime.mjs'],{env:{...process.env,CRASH_TEST_PORT:String(port)},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const messages=[];child.on('message',m=>messages.push(m));const closed=new Promise(resolve=>child.once('exit',resolve));
  const c={child,messages,closed};children.push(c);await until(()=>messages.some(m=>m.type==='ready'));return c;
 }
 t.after(async()=>{for(const c of clients)await c.ulda.close();for(const c of children)if(c.child.exitCode===null){c.child.send({type:'close'});await c.closed;}await pool.query('TRUNCATE public.ulda_resources');});
 const first=await launch(),port=first.messages.find(m=>m.type==='ready').port,url='http://127.0.0.1:'+port;
 function client(){const transport=new SocketIoTransport(url,{allowInsecureLocalhost:true,timeout:1000}),ulda=new Ulda(url,{transport,reconnect:false}),trace=[];
  transport.on('trace',e=>trace.push(e));const c={transport,ulda,trace};clients.push(c);return c;}
 const a=client(),master=await a.ulda.register(password);await a.ulda.add('item',{value:1});
 const b=client();await b.ulda.connect(master,password);let pushes=0;b.transport.on('trace',e=>{if(e.phase==='push')pushes++;});
 const id=a.trace.filter(e=>e.phase==='ack'&&e.event==='ulda:create').at(-1).ids[0];
 first.child.send({type:'arm'});await until(()=>first.messages.some(m=>m.type==='armed'));
 await assert.rejects(a.ulda.update('item',{value:2}),{code:'UNKNOWN_OUTCOME'});assert.equal(await first.closed,77);
 assert.equal(a.ulda.value('item').value,1);assert.equal(b.ulda.value('item').value,1);assert.equal(pushes,0);
 const committed=await rows([master,id]);const second=await launch(port);
 await a.ulda.reconnect();await b.ulda.reconnect();assert.equal(a.ulda.value('item').value,2);assert.equal(b.ulda.value('item').value,2);
 assert.deepEqual(await rows([master,id]),committed);
 second.child.send({type:'counts'});await until(()=>second.messages.some(m=>m.type==='counts'));assert.equal(second.messages.find(m=>m.type==='counts').writes,0);
 saveResult('process-crash.json',{success:true,exitCode:0,scenario:'real process exit after COMMIT before ACK/Changed',sdkVersion:'1.1.0',privateDiagnosticsSuppressed:true});
});
