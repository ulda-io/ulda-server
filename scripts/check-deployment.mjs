// Destructive deployment validation uses fresh uniquely named Compose projects only.
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {randomUUID,createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));process.chdir(root);
const id=randomUUID().replaceAll("-",""),folder=path.join(root,".local","deployment-"+id);
fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,"empty.env"),"");
const certs=path.join(folder,"certs");fs.mkdirSync(certs);
const source="ulda-deploy-"+id.slice(0,12),restore=source+"-restore",image="ulda/server:deployment-"+id;
const env={...process.env,POSTGRES_USER:"ulda_test_admin",POSTGRES_DB:"ulda_test_"+id,
 ULDA_SECRETS_DIR:path.join(folder,"secrets"),ULDA_SERVER_IMAGE:image,ULDA_SERVER_PORT:"0",
 ULDA_TLS_PORT:"0",ULDA_TLS_PUBLISH_ADDRESS:"127.0.0.1",ULDA_PUBLISH_ADDRESS:"127.0.0.1",
 ULDA_TLS_CERT_FILE:path.join(certs,"cert.pem"),ULDA_TLS_KEY_FILE:path.join(certs,"key.pem"),
 CORS_ORIGINS:"https://application.example",ULDA_TEST_ALLOW_RESET:"1",ULDA_SMOKE_STATE_FILE:path.join(folder,"state.json")};
delete env.PGPASSWORD;delete env.PGPASSWORD_FILE;delete env.DATABASE_URL;delete env.ULDA_TEST_DATABASE_URL;
env.NODE_EXTRA_CA_CERTS=env.ULDA_TLS_CERT_FILE;
const results={status:"RUNNING",checks:[],image,sdk:"ulda-auth@1.0.1",node:process.version};
const projects=new Set();let phase="prepare";
async function run(file,args,options={}) {
 try {const r=await promisify(execFile)(file,args,{cwd:root,env,timeout:180000,maxBuffer:8*1024*1024,windowsHide:true,...options});return (r.stdout+(options.includeStderr?r.stderr:"")).trim();}
 catch {throw new Error("Deployment command failed; private diagnostics suppressed.");}
}
const docker=(...args)=>run("docker",args);
function dc(project,...args) {assert.ok([source,restore].includes(project));projects.add(project);return docker("compose","--project-name",project,"--env-file",path.join(folder,"empty.env"),"-f","compose.yaml","-f","deploy/compose.tls.yaml",...args);}
const pass=message=>{results.checks.push(message);console.log("PASS "+message);};
async function until(fn){const end=Date.now()+60000;do{try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,200));}while(Date.now()<end);throw new Error("Deployment deadline");}
const sql=(project,query)=>dc(project,"exec","-T","postgres","psql","-v","ON_ERROR_STOP=1","-U",env.POSTGRES_USER,"-d",env.POSTGRES_DB,"-At","-c",query);
async function expectFailure(fn){let failed=false;try{await fn();}catch{failed=true;}assert.ok(failed);}
async function startDb(project){await dc(project,"up","-d","--no-build","postgres");await until(async()=>await sql(project,"SELECT 1")==="1");}
async function setup(project,adopt=false){return dc(project,"run","--rm","--no-deps","-e","ULDA_DB_SETUP=1",...(adopt?["-e","ULDA_DB_ADOPT_EXISTING=1"]:[]),"db-setup");}
async function migrate(project){await dc(project,"run","--rm","--no-deps","migrate");}
async function ready(project){
 await until(async()=>{await dc(project,"exec","-T","server","node","-e","fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(4000)}).then(r=>{if(r.status!==200)process.exit(1)})");return true;});
 const published=await dc(project,"port","proxy","8443");env.ULDA_SERVER_URL="https://127.0.0.1:"+published.split(":").at(-1);
}
async function smoke(action){console.log(await run(process.execPath,["scripts/container-sdk-smoke.mjs",action]));}
async function securityChecks(project){
 const config=JSON.parse(await dc(project,"config","--format","json"));
 assert.ok(!config.services.postgres.ports?.length);assert.ok(!config.services.server.ports?.length);
 assert.equal(config.services.server.environment.PGUSER,"ulda_runtime");
 assert.equal(config.services.migrate.environment.PGUSER,"ulda_migrator");
 assert.equal(config.services.server.environment.PGPASSWORD,undefined);
 assert.deepEqual(config.services.server.secrets.map(s=>s.source),["db_runtime_password"]);
 assert.equal(config.services.server.mem_limit,"1073741824");
 const probe=`
  import assert from 'node:assert/strict';
  import {createPostgresPool} from './dist/storage/postgres/postgres-pool.js';
  import {loadConfig} from './dist/config/config.js';
  const pool=createPostgresPool(loadConfig().database);
  try {
   const {rows:[role]}=await pool.query("SELECT current_user,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user");
   assert.equal(role.current_user,'ulda_runtime'); for(const k of ['rolsuper','rolcreaterole','rolcreatedb','rolreplication','rolbypassrls'])assert.equal(role[k],false);
   for(const query of ["CREATE TABLE public.forbidden(x int)","CREATE SCHEMA forbidden","CREATE TEMP TABLE forbidden(x int)","CREATE ROLE forbidden","ALTER TABLE public.ulda_resources ADD COLUMN forbidden int","TRUNCATE public.ulda_resources","SELECT * FROM public.ulda_schema_migrations","SELECT * FROM unrelated.secret","SELECT setval('public.ulda_resources_id_seq',999999)","SET ROLE ulda_migrator","SELECT pg_read_file('/etc/passwd')"]){
    await assert.rejects(pool.query(query),error=>error.code==='42501');
   }
   assert.equal((await pool.query("SHOW statement_timeout")).rows[0].statement_timeout,'10s');
   console.log('PASS runtime role rejects 11 privileged operations');
  } finally {await pool.end();}
 `;
 console.log(await dc(project,"exec","-T","server","node","--input-type=module","-e",probe));
 // Test CA is added explicitly. Certificate verification remains enabled.
 const tlsProbe=`
  import https from 'node:https';import assert from 'node:assert/strict';
  const status=await new Promise((resolve,reject)=>https.get(process.env.ULDA_SERVER_URL+'/ready',r=>{r.resume();resolve(r.statusCode);}).on('error',reject));assert.equal(status,404);
  const r=await new Promise((resolve,reject)=>https.get(process.env.ULDA_SERVER_URL+'/socket.io/?EIO=4&transport=polling',{headers:{Origin:'https://application.example'}},r=>{r.resume();resolve(r.headers);}).on('error',reject));assert.equal(r['access-control-allow-origin'],'https://application.example');console.log('PASS TLS and CORS');
 `;
 phase="tls-probe";
 await until(async()=>{await run(process.execPath,["--input-type=module","-e",tlsProbe]);return true;});
 pass("least-privilege runtime, mounted secret isolation, private ports and verified HTTPS/CORS");
}
async function main(){
 await import("../test/consumer/index.mjs");
 await run(process.execPath,["scripts/create-local-secrets.mjs"]);
 await docker("run","--rm","--mount","type=bind,source="+certs+",target=/out","--entrypoint","sh","postgres:18.4-bookworm","-c","openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout /out/key.pem -out /out/cert.pem -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 && chmod 644 /out/key.pem /out/cert.pem");
 phase="build";await docker("build","-t",image,".");results.imageId=await docker("image","inspect",image,"--format","{{.Id}}");
 env.ULDA_TEST_IMAGE=image;
 await run(process.execPath,["--test","test/container/image.test.mjs","test/container/context.test.mjs"]);
 pass("image build and four container checks");
 phase="new-volume";await startDb(source);
 await expectFailure(()=>dc(source,"run","--rm","--no-deps","db-setup"));
 const runtimeSecret=path.join(env.ULDA_SECRETS_DIR,"postgres_runtime_password"),originalSecret=fs.readFileSync(runtimeSecret);
 fs.writeFileSync(runtimeSecret,fs.readFileSync(path.join(env.ULDA_SECRETS_DIR,"postgres_admin_password")));
 await expectFailure(()=>setup(source));
 assert.equal(await sql(source,"SELECT count(*) FROM pg_roles WHERE rolname IN ('ulda_migrator','ulda_runtime')"),"0");
 fs.writeFileSync(runtimeSecret,originalSecret);await setup(source);
 await expectFailure(()=>setup(source));
 await migrate(source);await migrate(source);
 await sql(source,"CREATE SCHEMA unrelated; CREATE TABLE unrelated.secret(value text); INSERT INTO unrelated.secret VALUES ('synthetic unrelated marker')");
 await dc(source,"up","-d","--no-build","server","proxy");await ready(source);await securityChecks(source);
 phase="proxy-limits";console.log(await run(process.execPath,["test/support/proxy-limits.mjs"]));
 await smoke("prepare");
 pass("fresh roles, explicit setup, repeat migration and two-client X/S through WSS");
 phase="backup";await dc(source,"stop","proxy","server");
 const serverId=await dc(source,"ps","--all","--quiet","server");
 assert.equal(await docker("inspect",serverId,"--format","{{.State.ExitCode}}"),"0");
 const sequence=await sql(source,"SELECT last_value,is_called FROM public.ulda_resources_id_seq");
 await dc(source,"exec","-T","postgres","pg_dump","-U",env.POSTGRES_USER,"-d",env.POSTGRES_DB,"--format=custom","--no-acl","--table=public.ulda_resources","--table=public.ulda_resources_id_seq","--table=public.ulda_schema_migrations","--file=/tmp/ulda.dump");
 await dc(source,"cp","postgres:/tmp/ulda.dump",path.join(folder,"ulda.dump"));
 results.backupSha256=createHash("sha256").update(fs.readFileSync(path.join(folder,"ulda.dump"))).digest("hex");
 await dc(source,"stop","postgres");
 phase="restore";await startDb(restore);
 await dc(restore,"cp",path.join(folder,"ulda.dump"),"postgres:/tmp/ulda.dump");
 await dc(restore,"exec","-T","postgres","pg_restore","-U",env.POSTGRES_USER,"-d",env.POSTGRES_DB,"--exit-on-error","--single-transaction","--no-owner","--no-acl","/tmp/ulda.dump");
 // Existing legacy owner stays untouched unless adoption was explicitly selected.
 await expectFailure(()=>setup(restore));
 assert.equal(await sql(restore,"SELECT count(*) FROM pg_roles WHERE rolname IN ('ulda_migrator','ulda_runtime')"),"0");
 await setup(restore,true);await migrate(restore);
 assert.equal(await sql(restore,"SELECT last_value,is_called FROM public.ulda_resources_id_seq"),sequence);
 assert.equal(await sql(restore,"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner='ulda_migrator'"),"2");
 await dc(restore,"up","-d","--no-build","server","proxy");await ready(restore);await smoke("check");
 pass("backup restored into a different volume, explicit legacy adoption, exact ciphertext/IDs and sequence");
 phase="restart";
 await dc(restore,"restart","server");await ready(restore);await smoke("check");
 await dc(restore,"restart","postgres");await ready(restore);await smoke("check");
 phase="database-outage";
 const dbId=await dc(restore,"ps","--quiet","postgres");
 await docker("pause",dbId);
 try {await dc(restore,"exec","-T","server","node","--input-type=module","-e",`import assert from 'node:assert/strict';await new Promise(r=>setTimeout(r,1100));const base='http://127.0.0.1:3000';assert.equal((await fetch(base+'/ready',{signal:AbortSignal.timeout(5000)})).status,503);assert.equal((await fetch(base+'/health',{signal:AbortSignal.timeout(5000)})).status,200);`);}
 finally {await docker("unpause",dbId);}
 await ready(restore);await smoke("check");
 console.log(await run(process.execPath,["test/support/restored-sdk.mjs"]));
 assert.equal(await sql(restore,"SELECT count(*) FROM public.ulda_resources"),"0");
 pass("server/PG restart, bounded not-ready during outage, restored SDK update/new ID/delete");
 phase="log-canaries";
 const logs=await dc(restore,"logs","--no-color","server","migrate","db-setup","postgres","proxy");
 for(const file of fs.readdirSync(env.ULDA_SECRETS_DIR)){const value=fs.readFileSync(path.join(env.ULDA_SECRETS_DIR,file),"utf8").trim();assert.equal(logs.includes(value),false);}
 for(const marker of ["synthetic-container-smoke-passphrase","synthetic container integration","container-check-X"])assert.equal(logs.includes(marker),false);
 pass("private canaries absent from collected service logs");results.status="PASS";
}
try{await main();}
catch{results.status="FAIL";results.failedPhase=phase;process.exitCode=1;console.error("FAIL "+phase+"; private diagnostics suppressed.");}
finally{
 try{
  for(const project of projects){
   const ids=(await docker("ps","--all","--quiet","--filter","label=com.docker.compose.project="+project)).split(/\s+/).filter(Boolean);
   for(const cid of ids)assert.equal(await docker("inspect",cid,"--format",'{{index .Config.Labels "com.docker.compose.project"}}'),project);
   await dc(project,"down","--volumes","--remove-orphans");
  }
  results.cleanup="PASS";
 }catch{results.status="FAIL";results.cleanup="FAIL";process.exitCode=1;}
 // Remove private test artifacts after successful cleanup; retain only safe reports.
 if(results.status==='PASS'){
  for(const name of ['ulda.dump','state.json','certs/key.pem','certs/cert.pem','secrets/postgres_admin_password','secrets/postgres_migration_password','secrets/postgres_runtime_password']){
   const target=path.resolve(folder,name);assert.ok(target.startsWith(folder+path.sep));
   if(fs.existsSync(target)){assert.equal(fs.lstatSync(target).isSymbolicLink(),false);fs.unlinkSync(target);}
  }
 }
 fs.writeFileSync(path.join(folder,"result.json"),JSON.stringify(results,null,2)+"\n");
 console.log("Deployment "+results.status+"; report "+path.relative(root,path.join(folder,"result.json")));
}
