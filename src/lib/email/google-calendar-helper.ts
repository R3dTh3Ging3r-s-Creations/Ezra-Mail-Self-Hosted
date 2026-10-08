import { spawn } from "node:child_process";
/** Credential handling stays inside gog; never surface helper stderr or launch errors. */
export async function runGoogleCalendarHelper(args: string[], signal?: AbortSignal, input?:string): Promise<unknown> {
  signal?.throwIfAborted();
  if(input!==undefined&&Buffer.byteLength(input)>65_536)throw new Error("Calendar helper input exceeds limit.");
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(process.env.GOG_PATH || "gog.exe", ["--enable-commands-exact", "calendar.ezra-event", "calendar", "ezra-event", ...args, "--json", "--no-input"], { windowsHide: true, shell: false, env: process.env }); } catch { reject(new Error("Calendar helper unavailable.")); return; }
    const chunks: Buffer[] = []; let size = 0; let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); if (error) { child.kill(); reject(error); } else { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Malformed calendar helper result.")); } } };
    const abort = () => finish(new Error("Calendar helper interrupted."));
    const timer = setTimeout(() => finish(new Error("Calendar helper deadline exceeded.")), 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 4_194_304) finish(new Error("Calendar helper response exceeds limit.")); else chunks.push(chunk); });
    child.stderr!.on("data", () => { /* Drain and discard potentially sensitive diagnostics. */ });
    child.on("error", () => finish(new Error("Calendar helper unavailable.")));
    child.on("close", code => finish(code === 0 ? undefined : new Error("Calendar helper failed.")));
    if(input!==undefined){
      child.stdin!.on("error",()=>finish(new Error("Calendar helper unavailable.")));
      child.stdin!.end(input);
    }
    if (signal?.aborted) abort();
  });
}
