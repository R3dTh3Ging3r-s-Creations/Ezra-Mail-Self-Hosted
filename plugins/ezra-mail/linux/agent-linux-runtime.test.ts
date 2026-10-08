// @vitest-environment node
import {createHash} from "node:crypto";
import {describe,it,expect,vi} from "vitest";
import {loadLinuxAgentRuntime, validateLinuxFileMetadata} from "./agent-linux-runtime";
const root="/opt/ezra-mail-cloud-mcp/releases/fixture";
const bytes=Buffer.from("synthetic bundle, never executable");
const profile={enabled:true,origin:"https://ezra.example.test:8450",qualifiedRevision:"a".repeat(40),releaseDirectory:root,bundleSha256:createHash("sha256").update(bytes).digest("hex"),nodeExecutable:"/usr/local/bin/node"};
const context={platform:"linux",uid:991,execPath:"/usr/local/bin/node",entryPath:`${root}/bridge.cjs`,environment:{CREDENTIALS_DIRECTORY:"/run/credentials/ezra-mail-cloud-mcp.service"}};
const fixtureKey=`ezra_fixture.${"K".repeat(43)}`;
function fixture(patch:Record<string,unknown>={}){
 const files=new Map<string,Buffer>([
 ["/etc/ezra-mail-cloud-mcp/profile.json",Buffer.from(JSON.stringify({...profile,...patch}))],
 [`${root}/bridge.cjs`,bytes],
 [`${root}/release.json`,Buffer.from(JSON.stringify({schema:1,revision:profile.qualifiedRevision,bundleSha256:profile.bundleSha256}))],
 ["/run/credentials/ezra-mail-cloud-mcp.service/ezra-agent-key",Buffer.from(fixtureKey)],
 ]);
 const read=vi.fn(async(path:string)=>{const value=files.get(path);if(!value)throw new Error("missing fixture");return value;});
 return {files,read};
}
describe("Linux scoped bridge startup",()=>{
 it("loads only the pinned bundle, profile and service credential, retaining rotation reads",async()=>{
  const io=fixture();const runtime=await loadLinuxAgentRuntime(context,io);
  expect(runtime.origin).toBe("https://ezra.example.test:8450");expect(await runtime.getKey()).toBe(fixtureKey);
  io.files.set("/run/credentials/ezra-mail-cloud-mcp.service/ezra-agent-key",Buffer.from(`ezra_rotated.${"R".repeat(43)}`));
  expect(await runtime.getKey()).toBe(`ezra_rotated.${"R".repeat(43)}`);
  expect(new Set(io.read.mock.calls.map(c=>c[0]))).toEqual(new Set(io.files.keys()));
 });
 it.each([{platform:"win32"},{uid:0},{uid:undefined},{execPath:"/tmp/node"},{entryPath:"/tmp/bridge.cjs"}])("refuses unsupported execution context %j before advertising tools",async patch=>{
  await expect(loadLinuxAgentRuntime({...context,...patch} as typeof context,fixture())).rejects.toThrow("Linux scoped MCP startup refused");
 });
 it.each([{NODE_OPTIONS:"--import=/tmp/injection.mjs"},{NODE_TLS_REJECT_UNAUTHORIZED:"0"},{NODE_PATH:"/tmp/modules"},{LD_PRELOAD:"/tmp/inject.so"},{CREDENTIALS_DIRECTORY:"/tmp/copied-credentials"}])("rejects inherited injection or alternate credential location %j",async patch=>{
  await expect(loadLinuxAgentRuntime({...context,environment:{...context.environment,...patch}},fixture())).rejects.toThrow();
 });
 it.each([{enabled:false},{origin:"http://localhost:8789"},{origin:"https://user:pass@ezra.test"},{origin:"https://ezra.test/path"},{qualifiedRevision:"main"},{releaseDirectory:"/tmp/fixture"},{arbitraryCommand:"cat " + ["", "etc", "passwd"].join("/")}])("rejects unsafe profile %j",async patch=>{
  await expect(loadLinuxAgentRuntime(context,fixture(patch))).rejects.toThrow();
 });
 it("refuses a modified bundle or mismatched revision without reading credentials",async()=>{
  for(const path of [`${root}/bridge.cjs`,`${root}/release.json`]){
   const io=fixture();io.files.set(path,Buffer.from(path.endsWith(".json")?JSON.stringify({schema:1,revision:"b".repeat(40),bundleSha256:profile.bundleSha256}):"tampered"));
   await expect(loadLinuxAgentRuntime(context,io)).rejects.toThrow();
   expect(io.read.mock.calls.some(c=>c[0].includes("credentials"))).toBe(false);
  }
 });
 it("redacts malformed keys and filesystem failures",async()=>{
  const io=fixture();io.files.set("/run/credentials/ezra-mail-cloud-mcp.service/ezra-agent-key",Buffer.from("DO_NOT_LOG_ME"));
  await expect(loadLinuxAgentRuntime(context,io)).rejects.toThrow(/^Linux scoped MCP startup refused\.$/);
  io.read.mockRejectedValue(new Error(fixtureKey));
  await expect(loadLinuxAgentRuntime(context,io)).rejects.not.toThrow(fixtureKey);
 });
});
describe("Linux trusted-file metadata",()=>{
 const meta={uid:0,mode:0o100444,size:10,nlink:1,isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};
 it("accepts root-owned immutable release files and private service credentials",()=>{
  expect(()=>validateLinuxFileMetadata(meta,"release",991,100)).not.toThrow();
  expect(()=>validateLinuxFileMetadata({...meta,uid:991,mode:0o100400},"credential",991,100)).not.toThrow();
 });
 it.each([{uid:991},{mode:0o100664},{mode:0o100644},{size:101},{nlink:2},{isFile:()=>false},{isSymbolicLink:()=>true}])("rejects untrusted release metadata %j",patch=>{
  expect(()=>validateLinuxFileMetadata({...meta,...patch},"release",991,100)).toThrow();
 });
 it.each([{uid:992},{mode:0o100440},{mode:0o100600}])("rejects readable, mutable or foreign credentials %j",patch=>{
  expect(()=>validateLinuxFileMetadata({...meta,uid:991,mode:0o100400,...patch},"credential",991,100)).toThrow();
 });
});
describe("systemd credential ACL",()=>{
 const meta={uid:0,mode:0o100440,size:10,nlink:1,isFile:()=>true,isSymbolicLink:()=>false};
 const acl="user::r--\nuser:991:r--\ngroup::---\nmask::r--\nother::---\n";
 it("accepts root-owned systemd credentials readable only by the selected service UID",()=>{
  expect(()=>validateLinuxFileMetadata(meta,"credential",991,100,acl)).not.toThrow();
 });
 it.each([
  acl.replace("user:991:r--","user:992:r--"),
  acl.replace("group::---","group::r--"),
  acl.replace("other::---","other::r--"),
  acl+"user:992:r--\n",acl+"group:991:r--\n",acl+"default:user::r--\n",
  acl.replace("mask::r--","mask::rw-"),acl+"user:991:r--\n", "",
 ])("rejects incomplete, extra or broader ACL entries %j",bad=>{
  expect(()=>validateLinuxFileMetadata(meta,"credential",991,100,bad)).toThrow();
 });
});