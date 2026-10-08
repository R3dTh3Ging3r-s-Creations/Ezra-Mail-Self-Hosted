import { EventEmitter } from "node:events";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { runGoogleCalendarHelper } from "@/lib/email/google-calendar-helper";
const mocks=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock("node:child_process",()=>({spawn:mocks.spawn,default:{spawn:mocks.spawn}}));
let child: EventEmitter & {stdout:EventEmitter;stderr:EventEmitter;kill:ReturnType<typeof vi.fn>};
beforeEach(()=>{vi.useFakeTimers();child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:vi.fn()});mocks.spawn.mockReset().mockReturnValue(child);});
afterEach(()=>vi.useRealTimers());
it("writes a bounded update payload to stdin without placing contents in argv",async()=>{
 const stdin=Object.assign(new EventEmitter(),{end:vi.fn()});Object.assign(child,{stdin});
 const run=runGoogleCalendarHelper(["--mode","update","--patch-stdin"],undefined,'{"summary":"PRIVATE EVENT"}');
 expect(stdin.end).toHaveBeenCalledWith('{"summary":"PRIVATE EVENT"}');
 expect(JSON.stringify(mocks.spawn.mock.calls[0][1])).not.toContain("PRIVATE EVENT");
 child.stdout.emit("data",Buffer.from('{}'));child.emit("close",0);await run;
});
it("refuses oversized stdin before process launch",async()=>{await expect(runGoogleCalendarHelper([],undefined,"x".repeat(65_537))).rejects.toThrow();expect(mocks.spawn).not.toHaveBeenCalled();});
it("limits executable command and preserves opaque argument boundaries",async()=>{const args=["owner@gmail.test","event","--account","owner@gmail.test","--mode","delete","--if-match",'"opaque"',"--force"];const run=runGoogleCalendarHelper(args);child.stdout.emit("data",Buffer.from('{"status":"deleted"}'));child.emit("close",0);expect(await run).toEqual({status:"deleted"});expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String),["--enable-commands-exact","calendar.ezra-event","calendar","ezra-event",...args,"--json","--no-input"],expect.objectContaining({shell:false,windowsHide:true}));});
it("discards sensitive stderr and process errors",async()=>{const run=runGoogleCalendarHelper([]);child.stderr.emit("data",Buffer.from("SECRET provider diagnostic"));child.emit("error",new Error("SECRET path"));await expect(run).rejects.toThrow("Calendar helper unavailable.");expect(mocks.spawn).toHaveBeenCalledOnce();});
it.each(["not json",'{"incomplete":'])('rejects malformed JSON %s',async value=>{const run=runGoogleCalendarHelper([]);child.stdout.emit("data",Buffer.from(value));child.emit("close",0);await expect(run).rejects.toThrow("Malformed");});
it("bounds output and terminates only its helper",async()=>{const run=runGoogleCalendarHelper([]);child.stdout.emit("data",Buffer.alloc(4_194_305));await expect(run).rejects.toThrow("exceeds limit");expect(child.kill).toHaveBeenCalledOnce();});
it("cancellation never retries helper",async()=>{const controller=new AbortController();const run=runGoogleCalendarHelper([],controller.signal);controller.abort();await expect(run).rejects.toThrow("interrupted");expect(mocks.spawn).toHaveBeenCalledOnce();expect(child.kill).toHaveBeenCalledOnce();});
it("pre-aborted request never spawns",async()=>{const controller=new AbortController();controller.abort();await expect(runGoogleCalendarHelper([],controller.signal)).rejects.toThrow();expect(mocks.spawn).not.toHaveBeenCalled();});
it("deadline never repeats dispatch",async()=>{const run=runGoogleCalendarHelper([]);const assertion=expect(run).rejects.toThrow("deadline");await vi.advanceTimersByTimeAsync(120_000);await assertion;expect(mocks.spawn).toHaveBeenCalledOnce();});
it("nonzero exit never parses an apparent success",async()=>{const run=runGoogleCalendarHelper([]);child.stdout.emit("data",Buffer.from('{"status":"deleted"}'));child.emit("close",1);await expect(run).rejects.toThrow("Calendar helper failed.");});

it("redacts synchronous process launch failures",async()=>{mocks.spawn.mockImplementationOnce(()=>{throw new Error("SECRET executable path");});await expect(runGoogleCalendarHelper([])).rejects.toThrow("Calendar helper unavailable.");});
