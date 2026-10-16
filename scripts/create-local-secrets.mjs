import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const directory=path.resolve(process.env.ULDA_SECRETS_DIR || "secrets");
const files=["postgres_admin_password","postgres_migration_password","postgres_runtime_password"].map(name=>path.join(directory,name));
try {
  if(files.some(file=>fs.existsSync(file)))throw new Error();
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  for(const file of files)fs.writeFileSync(file,randomBytes(32).toString("hex")+"\n",{flag:"wx",mode:0o600});
  console.log("Created three local password files. Protect their host permissions and back them up separately.");
} catch {console.error("Secret creation failed; existing files are never overwritten. Inspect local files before retrying.");process.exitCode=1;}
