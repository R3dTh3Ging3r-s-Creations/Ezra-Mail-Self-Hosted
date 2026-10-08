/** Offline release assembly. Does not install, download, provision credentials or change services. */
import {build,version as esbuildVersion} from "esbuild";
import {readFile,writeFile,mkdir,lstat,realpath,readdir} from "node:fs/promises";
import {resolve,join,relative,dirname,sep} from "node:path";
import {builtinModules} from "node:module";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
const runtimeSources=["plugins/ezra-mail/linux/key-agent-mcp-linux.ts","plugins/ezra-mail/linux/agent-linux-runtime.ts","src/lib/email/agent-http-client.ts","src/lib/email/agent-key-mcp.ts","src/lib/email/agent-wire-schema.ts","src/lib/email/agent-safe-errors.ts","src/lib/email/agent-resource-types.ts","src/lib/email/agent-types.ts","src/lib/email/agent-operation-schema.ts","src/lib/email/calendar-day.ts"];
const sourceInputs=[...runtimeSources,"plugins/ezra-mail/linux/build-agent-linux.ts","package.json","package-lock.json","LICENSE","NOTICE"];
const inside=(parent:string,child:string)=>{const rel=relative(parent,child);return rel!==""&&!rel.startsWith(`..${sep}`)&&rel!==".."&&!resolve(rel).startsWith(`${sep}${sep}`)&&!rel.includes(":");};
export async function buildAgentLinuxRelease(source:string,destination:string){
 for(const key of ["ESBUILD_BINARY_PATH","NODE_OPTIONS","NODE_PATH"])if(process.env[key])throw new Error("Ambient compiler overrides are unsupported.");
 const root=await realpath(source),output=resolve(destination);
 if(join(output,"THIRD-PARTY-NOTICES.txt").length>240||!inside(join(root,"PRIVATE_OWNER_RECOVERY"),output))throw new Error("Use a compact new output directory inside PRIVATE_OWNER_RECOVERY.");
 try{await lstat(output);throw new Error("Output exists.");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const env={...process.env};for(const key of Object.keys(env))if(/^GIT_|^NODE_OPTIONS$|^NODE_PATH$|^ESBUILD_BINARY_PATH$/i.test(key))delete env[key];
 const git=(...args:string[])=>execFileSync("git",["-C",root,...args],{env,encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();
 const revision=git("rev-parse","HEAD");if(!/^[a-f0-9]{40}$/.test(revision))throw new Error("Invalid source revision.");
 git("ls-files","--error-unmatch","--",...sourceInputs);
 git("diff","--exit-code","HEAD","--",...sourceInputs);
 const lock=JSON.parse(await readFile(join(root,"package-lock.json"),"utf8"));
 if(esbuildVersion!==lock.packages?.["node_modules/esbuild"]?.version)throw new Error("Locked build-tool version does not match.");
 const result=await build({absWorkingDir:root,entryPoints:[runtimeSources[0]],outfile:"bridge.cjs",bundle:true,platform:"node",target:"node22",format:"cjs",write:false,metafile:true,legalComments:"inline",logLevel:"silent",tsconfigRaw:{compilerOptions:{}}});
 const modules=await realpath(join(root,"node_modules"));const packageRoots=new Set<string>();
 for(const input of Object.keys(result.metafile!.inputs)){
  const file=await realpath(resolve(root,input));
  if(inside(modules,file)){
   let folder=dirname(file);
   while(inside(modules,folder)){
    try{const pkg=JSON.parse(await readFile(join(folder,"package.json"),"utf8"));if(pkg.name&&pkg.version){packageRoots.add(folder);break;}}catch{/* Walk to package root. */}
    folder=dirname(folder);
   }
   if(!inside(modules,folder))throw new Error("Dependency license identity unavailable.");
  }else if(!runtimeSources.includes(relative(root,file).split(sep).join("/")))throw new Error("Bridge contains an unapproved runtime dependency.");
 }
 for(const item of Object.values(result.metafile!.outputs))for(const imported of item.imports){if(imported.external&&!builtinModules.includes(imported.path.replace(/^node:/,"")))throw new Error("Bridge has an external runtime dependency.");}
 const notices=[await readFile(join(root,"NOTICE"),"utf8"),await readFile(join(root,"LICENSE"),"utf8")];
 for(const folder of [...packageRoots].sort()){
  const pkg=JSON.parse(await readFile(join(folder,"package.json"),"utf8"));
  const names=(await readdir(folder)).filter(name=>/^(license|licence|copying)(\.|$)/i.test(name));
  if(!names.length)throw new Error(`Dependency license file unavailable: ${pkg.name}`);
  notices.push(`\n${pkg.name}@${pkg.version}\n`,...(await Promise.all(names.map(name=>readFile(join(folder,name),"utf8")))));
 }
 // Recheck tracked inputs after compilation before publishing any manifest.
 if(git("rev-parse","HEAD")!==revision)throw new Error("Source revision changed during build.");
 git("diff","--exit-code","HEAD","--",...sourceInputs);
 const bundle=result.outputFiles![0].contents;
 const bundleSha256=createHash("sha256").update(bundle).digest("hex");
 await mkdir(output,{recursive:true});
 if(await realpath(output)!==output)throw new Error("Output must not traverse a symlink.");
 await writeFile(join(output,"bridge.cjs"),bundle,{flag:"wx",mode:0o444});
 await writeFile(join(output,"THIRD-PARTY-NOTICES.txt"),notices.join("\n"),{flag:"wx",mode:0o444});
 await writeFile(join(output,"release.json"),JSON.stringify({schema:1,revision,bundleSha256},null,2)+"\n",{flag:"wx",mode:0o444});
 return {revision,bundleSha256};
}
if(process.argv[1]?.replaceAll("\\","/").endsWith("/build-agent-linux.ts")){
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=="--output")throw new Error("Use --output <new PRIVATE_OWNER_RECOVERY subdirectory>.");
 buildAgentLinuxRelease(process.cwd(),args[1]).then(()=>console.log("Built scoped Linux MCP release; installation requires owner approval.")).catch(()=>{console.error("Linux MCP release build refused. Verify clean source, locked dependencies and output directory.");process.exitCode=1;});
}