/** Build the reviewed extension in an already-fetched, exact upstream checkout. No downloads or installation. */
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const PIN = "3b5122f4c81c5df6df38ee48e01327f1034364ee";
export function createBuildEnvironment(parent = process.env) {
 const env = {...parent};
 // Normalize case as Windows treats environment names case-insensitively.
 const isolated = new Set(["GOWORK", "GOFLAGS", "GOENV", "GOROOT", "GOEXPERIMENT", "GOCACHEPROG", "GO111MODULE", "GOTOOLCHAIN", "GOPROXY", "GOSUMDB", "GOMAXPROCS", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]);
 for(const key of Object.keys(env)) if(isolated.has(key.toUpperCase())) delete env[key];
 return {...env, GOWORK:"off", GOFLAGS:"", GOENV:"off", GO111MODULE:"on", GOTOOLCHAIN:"local", GOPROXY:"off", GOSUMDB:"off", GOMAXPROCS:"4"};
}
export function assertSourceInputs(status, ignored) {
 // Ignored workspaces and generated Go can change compilation despite a clean HEAD.
 if(ignored.length) throw new Error("Source checkout contains ignored files; use a clean checkout.");
 const allowed = new Set(["internal/cmd/calendar.go", "internal/cmd/calendar_ezra_event.go", "internal/cmd/calendar_ezra_event_test.go"]);
 for(const line of status.split("\n").filter(Boolean)) {
  const relative=line.replace(/^\?\? |^[ MADRCU?!]{2} /,"");
  if(!allowed.has(relative)) throw new Error("Source checkout contains unrelated changes.");
 }
}
export function build(args = process.argv.slice(2)) {
function option(name) { const i = args.indexOf(name); if(i < 0 || !args[i+1] || args[i+1].startsWith("--")) throw new Error(`Required: ${name}`); return args[i+1]; }
if (args.length !== 6 || args.some((a,i)=>i%2===0&&!['--source','--go','--output'].includes(a))) throw new Error("Use --source <checkout> --go <executable> --output <new binary path>.");
const source = realpathSync(option("--source"));
const go = realpathSync(option("--go"));
const output = resolve(option("--output"));
const here = dirname(fileURLToPath(import.meta.url));
for(const path of [join(source,"internal/cmd/calendar_ezra_event_test.go"),output,process.env.GOCACHE,process.env.GOMODCACHE,process.env.GOPATH].filter(Boolean)) {
  if(path.length>180) throw new Error("Choose compact source/cache/output paths before building.");
}
if (existsSync(output)) throw new Error("Output already exists; select a new output path.");
const env = createBuildEnvironment();
const git = (...cmd) => execFileSync("git",["-C",source,...cmd],{encoding:"utf8",env}).trimEnd();
if(git("rev-parse","HEAD")!==PIN) throw new Error("Upstream checkout does not match reviewed commit.");
const target="internal/cmd/calendar.go";
const original=execFileSync("git",["-C",source,"show",`${PIN}:${target}`],{encoding:"utf8",env});
const marker="type CalendarCmd struct {";
if(original.split(marker).length!==2) throw new Error("Upstream command registration changed.");
const registered=original.replace(marker,marker+'\n\tEzraEvent CalendarEzraEventCmd `cmd:"" name:"ezra-event" help:"Exact owned event read or conditional delete (Ezra v1)"`');
assertSourceInputs(git("status","--porcelain","--untracked-files=all"), git("ls-files","--others","--ignored","--exclude-standard","-z"));
const current=readFileSync(join(source,target),"utf8").replace(/\r\n/g,"\n");
if(current!==original&&current!==registered) throw new Error("Command registration has unrelated edits.");
for(const name of ["calendar_ezra_event.go","calendar_ezra_event_test.go"]) {
 const path=join(source,"internal/cmd",name), payload=readFileSync(join(here,name),"utf8");
 if(existsSync(path)&&readFileSync(path,"utf8").replace(/\r\n/g,"\n")!==payload) throw new Error(`Existing extension differs: ${name}`);
 writeFileSync(path,payload);
}
writeFileSync(join(source,target),registered);
execFileSync(go,["test","-p","2","-run","^(TestEzraEvent|TestBuildRemindersDisabled|TestCalendarReminderFlagsAreMutuallyExclusive|TestCalendarCreateCmd_ReminderPopupZeroForceSendsMinutes)","./internal/cmd"],{cwd:source,env,stdio:"inherit"});
mkdirSync(dirname(output),{recursive:true});
execFileSync(go,["build","-p","2","-trimpath","-o",output,"./cmd/gog"],{cwd:source,env,stdio:"inherit"});
console.log(`Built reviewed gog extension at ${output}; runtime installation requires separate approval.`);

}
if(process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) build();
