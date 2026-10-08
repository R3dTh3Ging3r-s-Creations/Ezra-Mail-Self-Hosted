// @vitest-environment node
import {afterEach,describe,it,expect,vi} from "vitest";
import {mkdtemp,readFile,writeFile,mkdir,cp,symlink,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {buildAgentLinuxRelease} from "./build-agent-linux";
const roots:string[]=[];
const sources=["plugins/ezra-mail/linux/key-agent-mcp-linux.ts","plugins/ezra-mail/linux/build-agent-linux.ts","plugins/ezra-mail/linux/agent-linux-runtime.ts","src/lib/email/agent-http-client.ts","src/lib/email/agent-key-mcp.ts","src/lib/email/agent-wire-schema.ts","src/lib/email/agent-safe-errors.ts","src/lib/email/agent-resource-types.ts","src/lib/email/agent-types.ts","src/lib/email/agent-operation-schema.ts","src/lib/email/calendar-day.ts","package.json","package-lock.json","LICENSE","NOTICE"];
async function checkout(){
 const root=await mkdtemp(join(tmpdir(),"ezm-"));roots.push(root);
 for(const file of sources){await mkdir(join(root,file,".."),{recursive:true});await cp(resolve(file),join(root,file));}
 await writeFile(join(root,".gitignore"),"node_modules/\nPRIVATE_OWNER_RECOVERY/\n");
 await symlink(resolve("node_modules"),join(root,"node_modules"),"junction");
 const git=(...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true});
 git("init","-q");git("config","core.autocrlf","false");git("add",".");git("-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","-qm","fixture");
 return {root,git,output:join(root,"PRIVATE_OWNER_RECOVERY","bridge")};
}
afterEach(async()=>{for(const root of roots.splice(0)){if(!resolve(root).startsWith(join(tmpdir(),"ezm-")))throw new Error("Unexpected test cleanup path");await rm(root,{recursive:true,force:true});}});
describe("minimal Linux bridge release",()=>{
 it("bundles a clean pinned checkout and fails closed when launched outside its Linux service",async()=>{
  const {root,git,output}=await checkout();await buildAgentLinuxRelease(root,output);
  const manifest=JSON.parse(await readFile(join(output,"release.json"),"utf8"));
  const bundle=await readFile(join(output,"bridge.cjs"));
  expect(manifest).toEqual({schema:1,revision:git("rev-parse","HEAD").trim(),bundleSha256:createHash("sha256").update(bundle).digest("hex")});
  const result=spawnSync(process.execPath,[join(output,"bridge.cjs")],{encoding:"utf8",env:{...process.env,CREDENTIALS_DIRECTORY:""}});
  expect(result.status).toBe(1);expect(result.stdout).toBe("");expect(result.stderr).toContain("Linux scoped MCP startup refused");
  expect(await readFile(join(output,"THIRD-PARTY-NOTICES.txt"),"utf8")).toContain("@modelcontextprotocol/sdk");
 },30000);
 it("rejects modified runtime inputs and never leaves a usable manifest",async()=>{
  const {root,output}=await checkout();await writeFile(join(root,"plugins/ezra-mail/linux/key-agent-mcp-linux.ts"),"console.log('changed');");
  await expect(buildAgentLinuxRelease(root,output)).rejects.toThrow();
  await expect(readFile(join(output,"release.json"))).rejects.toThrow();
 },30000);
 it("rejects a committed database import even when Git is clean",async()=>{
  const {root,git,output}=await checkout();await writeFile(join(root,"src/lib/email/database.ts"),"export const forbidden = 'database';");
  const entry=join(root,"plugins/ezra-mail/linux/key-agent-mcp-linux.ts");await writeFile(entry,(await readFile(entry,"utf8"))+"\nimport {forbidden} from '../../../src/lib/email/database'; console.error(forbidden);\n");
  git("add",".");git("-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","-qm","unexpected dependency");
  await expect(buildAgentLinuxRelease(root,output)).rejects.toThrow();
  await expect(readFile(join(output,"release.json"))).rejects.toThrow();
 },30000);
 it("rejects ambient compiler injection before publishing artifacts",async()=>{
  const {root,output}=await checkout();vi.stubEnv("ESBUILD_BINARY_PATH","/tmp/other-esbuild");
  try{await expect(buildAgentLinuxRelease(root,output)).rejects.toThrow();await expect(readFile(join(output,"release.json"))).rejects.toThrow();}finally{vi.unstubAllEnvs();}
 });
 it("refuses existing or overly long output paths",async()=>{
  const {root,output}=await checkout();await mkdir(output,{recursive:true});
  await expect(buildAgentLinuxRelease(root,output)).rejects.toThrow();
  await expect(buildAgentLinuxRelease(root,join(output,"x".repeat(241)))).rejects.toThrow();
 });
});