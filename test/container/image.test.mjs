import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Explicit image only: never rebuild/retag the operator's running image here.
const image = process.env.ULDA_TEST_IMAGE;
assert.ok(image && !image.startsWith("-"), "Set ULDA_TEST_IMAGE to a local test image.");
function docker(args, input) {
  try {
    return execFileSync("docker", args, { encoding: "utf8", input,
      timeout: 30_000, maxBuffer: 1_048_576, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { throw new Error("Container check failed; raw Docker diagnostics suppressed."); }
}
function probe(source, flags = []) {
  return JSON.parse(docker(["run", "--rm", "--network", "none", ...flags,
    image, "node", "--input-type=module", "-e", source]));
}

test("runtime is non-root, cannot alter application code, and contains only runtime inputs", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const lock = JSON.parse(fs.readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  const noticePaths = ["LICENSE.md", "THIRD_PARTY_NOTICES.md"];
  for (const [dir, entry] of Object.entries(lock.packages)) {
    if (!dir || entry.dev) continue;
    const names = fs.readdirSync(`${root}/${dir}`).filter(name => /^(licen[sc]e|notice|copying)(\.|$)/i.test(name));
    for (const name of names.length ? names : ["README.md"]) noticePaths.push(`${dir}/${name}`);
  }
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const expectedNotices = noticePaths.map(name => digest(fs.readFileSync(`${root}/${name}`)));
  const result = probe(`
    import fs from 'node:fs'; import {createRequire} from 'node:module';
    import {createHash} from 'node:crypto';
    const require=createRequire('/app/package.json');
    const paths=['/app','/app/dist/main.js','/app/package.json','/app/node_modules','/app/migrations'];
    const writable=path=>{try{fs.accessSync(path,fs.constants.W_OK);return true;}catch{return false;}};
    const present=name=>{try{require.resolve(name);return true;}catch{return false;}};
    console.log(JSON.stringify({uid:process.getuid(), files:paths.map(path=>({uid:fs.statSync(path).uid,writable:writable(path)})),
      root:fs.readdirSync('/app').sort(), core:present('ulda-core'),
      notices:${JSON.stringify(noticePaths)}.map(name=>createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex')),
      packageTools:['npm','npx','yarn','yarnpkg','corepack','pnpm','pnpx'].map(name=>fs.existsSync('/usr/local/bin/'+name)),
      globalTools:['npm','corepack'].map(name=>fs.existsSync('/usr/local/lib/node_modules/'+name)),
      excluded:['ulda-auth','vitest','typescript','tsx'].map(present)}));
  `);
  assert.notEqual(result.uid, 0);
  assert.ok(result.files.every(file => file.uid === 0 && !file.writable));
  assert.deepEqual(result.root, ["LICENSE.md", "THIRD_PARTY_NOTICES.md", "dist", "migrations", "node_modules", "package-lock.json", "package.json"]);
  assert.deepEqual(result.notices, expectedNotices, "Server and dependency license notices must survive runtime packaging unchanged.");
  assert.equal(result.core, true); assert.deepEqual(result.excluded, [false, false, false, false]);
  assert.ok(result.packageTools.every(present => !present));
  assert.ok(result.globalTools.every(present => !present));
});

test("runtime supports a read-only filesystem, dropped capabilities and no-new-privileges", () => {
  const result = probe(`
    import fs from 'node:fs';
    const status=fs.readFileSync('/proc/self/status','utf8'); let writeDenied=false;
    try{fs.writeFileSync('/tmp/ulda-container-probe','synthetic');}catch(e){writeDenied=e.code==='EROFS'||e.code==='EACCES';}
    const field=name=>status.split(String.fromCharCode(10)).find(line=>line.startsWith(name+':'))?.slice(name.length+1).trim();
    console.log(JSON.stringify({uid:process.getuid(),writeDenied,noNewPrivileges:field('NoNewPrivs'),
      capabilities:field('CapEff'),bounding:field('CapBnd')}));
  `, ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128"]);
  assert.notEqual(result.uid, 0); assert.equal(result.writeDenied, true);
  assert.equal(result.noNewPrivileges, "1");
  assert.match(result.capabilities, /^0+$/); assert.match(result.bounding, /^0+$/);
});

test("image healthcheck honors SERVER_PORT instead of probing only port 3000", () => {
  const check = JSON.parse(docker(["image", "inspect", image, "--format", "{{json .Config.Healthcheck.Test}}"]));
  assert.equal(check[0], "CMD");
  const result = probe(`
    import http from 'node:http'; import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
    const check=${JSON.stringify(check.slice(1))};
    const server=http.createServer((req,res)=>{res.writeHead(req.url==='/ready'?200:404);res.end();});
    await new Promise(resolve=>server.listen(4087,'127.0.0.1',resolve));
    try {await promisify(execFile)(check[0],check.slice(1),{timeout:5000});console.log(JSON.stringify({ok:true}));}
    finally {await new Promise(resolve=>server.close(resolve));}
  `, ["--read-only", "-e", "SERVER_PORT=4087"]);
  assert.deepEqual(result, { ok: true });
});

test("runtime contains no setuid/setgid files or Perl/util-linux packages", () => {
  const result = probe(`
    import fs from 'node:fs';
    const elevated=[];
    const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=dir+'/'+entry.name;if(entry.isSymbolicLink())continue;
      if(entry.isDirectory())walk(file);else if(entry.isFile()&&(fs.statSync(file).mode&0o6000))elevated.push(file);
    }};
    for(const dir of ['/usr','/bin','/sbin','/app'])walk(dir);
    // BusyBox can provide a same-named applet; test the affected package identity.
    const packages=fs.readFileSync('/lib/apk/db/installed','utf8').split(String.fromCharCode(10))
      .filter(line=>line.startsWith('P:')).map(line=>line.slice(2));
    console.log(JSON.stringify({elevated,excluded:packages.filter(name=>/^(perl|util-linux|libmount|libblkid)(-|$)/.test(name)),alpine:fs.existsSync('/etc/alpine-release')}));
  `);
  assert.deepEqual(result.elevated, []);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.alpine, true);
});
