import {constants, type Stats} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import {posix as path} from "node:path";
import {createHash} from "node:crypto";
import {z} from "zod";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const execFileAsync=promisify(execFile);

type FileKind = "release" | "credential";
type Metadata = Pick<Stats,"uid"|"mode"|"size"|"nlink"|"isFile"|"isSymbolicLink">;
export type LinuxRuntimeContext = {platform:string;uid:number|undefined;execPath:string;entryPath:string;environment:Record<string,string|undefined>};
export type LinuxRuntimeFiles = {read:(file:string,kind:FileKind,maxBytes:number,uid:number)=>Promise<Buffer>};
const refused = () => new Error("Linux scoped MCP startup refused.");
const profilePath = "/etc/ezra-mail-cloud-mcp/profile.json";
const credentialDirectory = "/run/credentials/ezra-mail-cloud-mcp.service";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const profileSchema = z.object({enabled:z.literal(true),origin:z.string(),qualifiedRevision:revision,
 releaseDirectory:z.string().regex(/^\/opt\/ezra-mail-cloud-mcp\/releases\/[a-zA-Z0-9_-]+$/),bundleSha256:sha,
 nodeExecutable:z.string().regex(/^\/[a-zA-Z0-9_./-]+$/),}).strict();
const releaseSchema = z.object({schema:z.literal(1),revision,bundleSha256:sha}).strict();

export function validateLinuxFileMetadata(info:Metadata,kind:FileKind,uid:number,maxBytes:number,acl?:string){
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size<1||info.size>maxBytes)throw refused();
 if(kind==="release"){
  if(info.uid!==0||(info.mode&0o222)!==0)throw refused();
  return;
 }
 const mode=info.mode&0o7777;
 if(![0,uid].includes(info.uid))throw refused();
 if(mode===0o400)return;
 // With a POSIX ACL, stat's group bits represent the ACL mask, not group access.
 // systemd gives exactly this named service UID read access to a root-owned file.
 if(mode!==0o440||info.uid!==0||!acl)throw refused();
 const entries=acl.split("\n").filter(line=>line!=="");
 const expected=["user::r--",`user:${uid}:r--`,"group::---","mask::r--","other::---"];
 if(entries.length!==expected.length||expected.some(entry=>entries.filter(line=>line===entry).length!==1))throw refused();
}

/** No symlink parents, writable shared ancestry, unchecked readFile, or path fallback. */
export const linuxRuntimeFiles:LinuxRuntimeFiles={async read(file,kind,maxBytes,uid){
 try{
  if(path.resolve(file)!==file||await realpath(file)!==file)throw refused();
  let parent=path.dirname(file);
  while(true){
   const info=await lstat(parent);
   const serviceCredentialParent=kind==="credential"&&parent===credentialDirectory;
   if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o022)!==0||
    !(info.uid===0||(serviceCredentialParent&&info.uid===uid)))throw refused();
   if(parent==="/")break;parent=path.dirname(parent);
  }
  const before=await lstat(file);
  let acl:string|undefined;
  if(kind==="credential"&&(before.mode&0o7777)===0o440){
   // Fixed metadata-only command; never runs a shell or prints credential contents.
   const result=await execFileAsync("/usr/bin/getfacl",["--absolute-names","--numeric","--omit-header","--no-effective","--",file],{encoding:"utf8",timeout:2000,maxBuffer:4096,env:{LANG:"C",LC_ALL:"C",NODE_ENV:"production"}});
   if(result.stderr)throw refused();acl=result.stdout;
  }
  validateLinuxFileMetadata(before,kind,uid,maxBytes,acl);
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const info=await handle.stat();validateLinuxFileMetadata(info,kind,uid,maxBytes,acl);
   if(info.ino!==before.ino||info.dev!==before.dev||info.mode!==before.mode||info.ctimeMs!==before.ctimeMs)throw refused();
   const buffer=Buffer.alloc(maxBytes+1);let count=0;
   while(count<buffer.length){const part=await handle.read(buffer,count,buffer.length-count,null);if(!part.bytesRead)break;count+=part.bytesRead;}
   if(count!==info.size||count>maxBytes)throw refused();
   return buffer.subarray(0,count);
  }finally{await handle.close();}
 }catch{throw refused();}
}};

export async function loadLinuxAgentRuntime(context:LinuxRuntimeContext,files:LinuxRuntimeFiles=linuxRuntimeFiles){
 try{
  if(context.platform!=="linux"||!Number.isInteger(context.uid)||!context.uid||context.uid<0)throw refused();
  const uid=context.uid;
  for(const name of ["NODE_OPTIONS","NODE_PATH","NODE_TLS_REJECT_UNAUTHORIZED","LD_PRELOAD","LD_LIBRARY_PATH"]){if(context.environment[name])throw refused();}
  if(context.environment.CREDENTIALS_DIRECTORY!==credentialDirectory)throw refused();
  const profile=profileSchema.parse(JSON.parse((await files.read(profilePath,"release",4096,uid)).toString("utf8")));
  const origin=new URL(profile.origin);
  if(origin.protocol!=="https:"||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash)throw refused();
  if(context.execPath!==profile.nodeExecutable||path.resolve(profile.nodeExecutable)!==profile.nodeExecutable||
   context.entryPath!==`${profile.releaseDirectory}/bridge.cjs`)throw refused();
  const release=releaseSchema.parse(JSON.parse((await files.read(`${profile.releaseDirectory}/release.json`,"release",4096,uid)).toString("utf8")));
  if(release.revision!==profile.qualifiedRevision||release.bundleSha256!==profile.bundleSha256)throw refused();
  const bundle=await files.read(context.entryPath,"release",16*1024*1024,uid);
  if(createHash("sha256").update(bundle).digest("hex")!==profile.bundleSha256)throw refused();
  const getKey=async()=>{
   try{
    const value=(await files.read(`${credentialDirectory}/ezra-agent-key`,"credential",256,uid)).toString("utf8").replace(/\r?\n$/,"");
    if(!/^ezra_[A-Za-z0-9-]{1,64}\.[A-Za-z0-9_-]{43}$/.test(value))throw refused();
    return value;
   }catch{throw refused();}
  };
  await getKey();
  return {origin:origin.origin,getKey};
 }catch{throw refused();}
}