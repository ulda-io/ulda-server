// Closed-loop capacity measurement on fresh, explicitly owned local resources.
// Exactly one outstanding SDK update per connection; no target updates/second.
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Histogram, loadOptions } from "../test/load/metrics.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));process.chdir(root);
const options=loadOptions(process.env), requestedImage=process.env.ULDA_TEST_IMAGE;
assert(requestedImage&&!requestedImage.startsWith("-"),"Set ULDA_TEST_IMAGE to the reviewed local image.");
const id=randomUUID().replaceAll("-",""), project="ulda-capacity-"+id.slice(0,16);
const folder=path.join(root,".local",project);fs.mkdirSync(folder,{recursive:true});
fs.writeFileSync(path.join(folder,"empty.env"),"");
const env={...process.env,ULDA_SECRETS_DIR:path.join(folder,"secrets"),ULDA_SERVER_IMAGE:requestedImage,
  ULDA_SERVER_PORT:"0",ULDA_PUBLISH_ADDRESS:"127.0.0.1",POSTGRES_USER:"ulda_test_admin",POSTGRES_DB:"ulda_test_"+id};
// Fixed reviewed default budgets; do not inherit an operator's accidental overrides.
for(const name of Object.keys(env))if(/^(?:MAX_|DATABASE_|READINESS_|GRACEFUL_|CORS_|COMMAND_BURST$|BINARY_PACKET_TIMEOUT_MS$|PG)/.test(name))delete env[name];
const overlay=path.join(folder,"capacity.json");
fs.writeFileSync(overlay,JSON.stringify({services:{server:{cpus:options.profile==="host"?0:1,environment:{LOG_LEVEL:"error"}},postgres:{cpus:options.profile==="host"?0:1}}}));
const result={status:"RUNNING",startedAt:new Date().toISOString(),options,requestedImage,sdk:"ulda-auth@1.0.1",
  protocol:"HTTP/WebSocket loopback, no TLS proxy",mode:"X",workload:"independent encrypted SDK content updates",
  cpuQuota:options.profile==="host"?"none for test server/DB":"1 CPU each",memoryLimitBytes:1073741824,
  generator:{node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,hostRamBytes:os.totalmem()},samples:[]};
const children=[];let created=false,phase="prepare",statsTimer,statsTask=Promise.resolve();
async function run(file,args,overrides={}) {
  try {const {stdout}=await promisify(execFile)(file,args,{cwd:root,env,timeout:180000,maxBuffer:8*1024*1024,windowsHide:true,...overrides});return stdout.trim();}
  catch {throw new Error("Capacity command failed; private diagnostics suppressed.");}
}
const docker=(...args)=>run("docker",args);
const dc=(...args)=>docker("compose","--project-name",project,"--env-file",path.join(folder,"empty.env"),"-f","compose.yaml","-f",overlay,...args);
const sql=query=>dc("exec","-T","postgres","psql","-v","ON_ERROR_STOP=1","-U",env.POSTGRES_USER,"-d",env.POSTGRES_DB,"-At","-c",query);
async function until(check,timeout=60000){const end=Date.now()+timeout;do{try{if(await check())return;}catch{}await new Promise(r=>setTimeout(r,250));}while(Date.now()<end);throw new Error("Capacity setup deadline");}
async function waitFor(predicate,timeout){const end=Date.now()+timeout;while(!predicate()){if(children.some(c=>c.failed)||Date.now()>end)throw new Error("Capacity worker failed or timed out");await new Promise(r=>setTimeout(r,100));}}
async function main(){
  result.imageId=await docker("image","inspect",requestedImage,"--format","{{.Id}}");env.ULDA_SERVER_IMAGE=result.imageId;
  result.consumerLockSha256=createHash("sha256").update(fs.readFileSync("test/consumer/package-lock.json")).digest("hex");
  result.docker=JSON.parse(await docker("info","--format",'{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}'));
  await run(process.execPath,["scripts/create-local-secrets.mjs"]);
  created=true;await dc("up","-d","--no-build","postgres");await until(async()=>await sql("SELECT 1")==="1");
  await dc("run","--rm","--no-deps","-e","ULDA_DB_SETUP=1","db-setup");
  await dc("run","--rm","--no-deps","migrate");
  await dc("up","-d","--no-build","server");
  const port=await dc("port","server","3000"),url="http://127.0.0.1:"+port.split(":").at(-1);
  await until(async()=>{const response=await fetch(url+"/ready",{signal:AbortSignal.timeout(3000)});await response.arrayBuffer();return response.status===200;});
  const app=await dc("ps","--quiet","server"),db=await dc("ps","--quiet","postgres");
  result.containers={serverImage:await docker("inspect",app,"--format","{{.Image}}"),databaseImage:await docker("inspect",db,"--format","{{.Image}}")};
  for(const cid of [app,db]){
    const host=JSON.parse(await docker("inspect",cid,"--format","{{json .HostConfig}}"));
    assert.equal(host.NanoCpus,options.profile==="host"?0:1_000_000_000);assert.equal(host.Memory,1073741824);
  }
  phase="clients";
  for(let i=0;i<options.workers;i++){
    const count=Math.floor(options.clients/options.workers)+(i<options.clients%options.workers?1:0);
    const proc=fork(path.join(root,"test/load/client.mjs"),[],{cwd:root,env,windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]});
    const child={proc,ready:false,warmed:false,failed:false,exited:false,report:null,progress:{confirmed:0}};children.push(child);
    proc.on("message",m=>{
      if(m.kind==="ready")child.ready=true;
      if(m.kind==="warmed")child.warmed=true;
      if(m.kind==="progress")child.progress=m;
      if(m.kind==="result")child.report=m;
      if(m.kind==="abort"||m.kind==="failed"){child.failed=true;for(const c of children)if(c.proc.connected)c.proc.send({action:"stop"});}
    });
    proc.on("error",()=>{child.failed=true;});
    proc.on("exit",code=>{child.exited=true;if(code!==0||!child.report)child.failed=true;});
    proc.send({action:"init",url,clients:count});
  }
  await waitFor(()=>children.every(c=>c.ready),600000);
  assert.equal(Number(await sql("SELECT count(*) FROM public.ulda_resources")),options.clients*2);
  console.log(`PASS ${options.clients} SDK connections and independent content resources prepared`);
  phase="warmup";for(const c of children)c.proc.send({action:"start",warmup:options.warmup});
  await waitFor(()=>children.every(c=>c.warmed),(options.warmup+30)*1000);
  phase="measurement";const startAt=Date.now()+1000;
  for(const c of children)c.proc.send({action:"measure",startAt,seconds:options.seconds});
  const sample=async()=>{
    try{const rows=(await docker("stats","--no-stream","--format","{{json .}}",app,db)).split("\n").filter(Boolean).map(line=>JSON.parse(line));
      const waits=JSON.parse(await sql("SELECT COALESCE(json_agg(s),'[]'::json) FROM (SELECT state,wait_event_type,wait_event,count(*) AS connections FROM pg_stat_activity WHERE datname=current_database() AND usename='ulda_runtime' GROUP BY state,wait_event_type,wait_event) s"));
      result.samples.push({elapsedSeconds:(Date.now()-startAt)/1000,databaseWaits:waits,containers:rows.map(x=>({service:x.ID===app.slice(0,12)?"server":x.Name.includes("server")?"server":"postgres",cpu:x.CPUPerc,memory:x.MemUsage,memoryPercent:x.MemPerc,net:x.NetIO,block:x.BlockIO,pids:x.PIDs}))});
    }catch{result.metricErrors=(result.metricErrors||0)+1;}
  };
  statsTimer=setInterval(()=>{statsTask=statsTask.then(sample);},10000);
  const progress=setInterval(()=>console.log(JSON.stringify({phase:"capacity",seconds:Math.round((Date.now()-startAt)/1000),confirmed:children.reduce((n,c)=>n+c.progress.confirmed,0)})),30000);
  try{await waitFor(()=>children.every(c=>c.exited),(options.seconds+180)*1000);}finally{clearInterval(progress);}
  clearInterval(statsTimer);await statsTask;await sample();
  const latency=new Histogram(),ack=new Histogram();
  for(const c of children){assert(c.report);latency.merge(c.report.latency);ack.merge(c.report.ack);}
  const sum=key=>children.reduce((n,c)=>n+c.report[key],0);
  const seconds=Math.max(...children.map(c=>c.report.durationMs))/1000;
  result.measurement={attempted:sum("attempted"),confirmed:sum("confirmed"),failed:sum("failed"),asyncErrors:sum("asyncErrors"),
    authorEchoes:sum("pushes"),confirmedAfterDeadline:sum("afterDeadline"),durationIncludingDrainSeconds:seconds,
    confirmedPerSecond:sum("confirmed")/seconds,latency:latency.summary(),ackLatency:ack.summary(),verifiedClients:sum("finalVerified"),
    jsonBytes:children.map(c=>c.report.jsonBytes),generatorCpuCores:sum("cpuMicros")/1e6/seconds,
    generatorMaxRssBytes:children.map(c=>c.report.maxRss),generatorEventLoopP99Ms:children.map(c=>c.report.eventLoopP99Ms)};
  assert.equal(result.measurement.attempted,result.measurement.confirmed);assert.equal(result.measurement.verifiedClients,options.clients);
  assert.equal(result.measurement.authorEchoes,0);assert.equal(result.measurement.failed,0);assert.equal(result.measurement.asyncErrors,0);
  assert.equal(Number(await sql("SELECT count(*) FROM public.ulda_resources")),options.clients*2);
  phase="recovery";await until(async()=>{const r=await fetch(url+"/ready",{signal:AbortSignal.timeout(3000)});await r.arrayBuffer();return r.status===200;});
  const logs=await dc("logs","--no-color","server","postgres");
  for(const name of fs.readdirSync(env.ULDA_SECRETS_DIR))assert(!logs.includes(fs.readFileSync(path.join(env.ULDA_SECRETS_DIR,name),"utf8").trim()));
  assert(!logs.includes("synthetic-capacity-"));
  result.status="PASS";result.integrity="all final content sequences reread and verified; expected row count; no author echoes";
}
try{await main();}
catch{result.status="FAIL";result.failedPhase=phase;result.partial=children.map(c=>c.progress);process.exitCode=1;console.error("FAIL capacity "+phase+"; private diagnostics suppressed.");}
finally{
  clearInterval(statsTimer);await statsTask;
  for(const c of children)if(!c.exited){if(c.proc.connected)c.proc.send({action:"stop"});c.proc.kill();}
  try{
    if(created){const ids=(await docker("ps","--all","--quiet","--filter","label=com.docker.compose.project="+project)).split(/\s+/).filter(Boolean);
      for(const cid of ids)assert.equal(await docker("inspect",cid,"--format",'{{index .Config.Labels "com.docker.compose.project"}}'),project);
      await dc("down","--volumes","--remove-orphans");}
    result.cleanup="PASS";
    for(const name of ["postgres_admin_password","postgres_migration_password","postgres_runtime_password"]){
      const target=path.resolve(env.ULDA_SECRETS_DIR,name);assert(target.startsWith(path.resolve(folder)+path.sep));
      if(fs.existsSync(target)){assert(!fs.lstatSync(target).isSymbolicLink());fs.unlinkSync(target);}
    }
  }catch{result.cleanup="FAIL";result.status="FAIL";process.exitCode=1;}
  result.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(folder,"result.json"),JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify({status:result.status,measurement:result.measurement,report:path.relative(root,path.join(folder,"result.json"))}));
}
