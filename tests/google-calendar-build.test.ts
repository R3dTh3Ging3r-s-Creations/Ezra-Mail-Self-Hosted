import { expect, it } from "vitest";
// @ts-expect-error The standalone Node build recipe has no TypeScript declaration.
import { createBuildEnvironment, assertSourceInputs } from "../tools/gog-ezra/build.mjs";

it("isolates compilation from inherited Go workspaces, flags, config, toolchain and cache programs", () => {
 const inherited = { GOWORK:"C:/other/go.work", GOFLAGS:"-overlay=other.json -tags=unsafe", GOENV:"C:/other/env", GOROOT:"C:/other/go", GOEXPERIMENT:"other", GOCACHEPROG:"unreviewed-cache.exe", GOTOOLCHAIN:"auto", GO111MODULE:"off", GIT_WORK_TREE:"other", PATH:"expected-path" };
 const clean = createBuildEnvironment(inherited);
 expect(clean).toMatchObject({ GOWORK:"off", GOFLAGS:"", GOENV:"off", GOTOOLCHAIN:"local", GO111MODULE:"on", GOPROXY:"off", GOSUMDB:"off", PATH:"expected-path" });
 for(const key of ["GOROOT","GOEXPERIMENT","GOCACHEPROG","GIT_WORK_TREE"]) expect(clean).not.toHaveProperty(key);
 expect(inherited.GOWORK).toBe("C:/other/go.work");
});
it("preserves explicit cross-compilation targets and isolated cache locations", () => {
 const explicit = { GOOS:"linux", GOARCH:"amd64", GOPATH:"D:/gp", GOCACHE:"D:/gc", GOMODCACHE:"D:/gm" };
 expect(createBuildEnvironment(explicit)).toMatchObject(explicit);
});
it("normalizes case variants of inherited controls for Windows environment keys", () => {
 const clean = createBuildEnvironment({ gowork:"other", GoFlags:"-overlay=other.json", GoEnv:"other", GoRoot:"other", GoExperiment:"other", GoCacheProg:"other" });
 expect(clean).toMatchObject({ GOWORK:"off", GOFLAGS:"", GOENV:"off" });
 for(const key of ["gowork","GoFlags","GoEnv","GoRoot","GoExperiment","GoCacheProg"]) expect(clean).not.toHaveProperty(key);
});
it.each(["go.work", "go.work.sum", "internal/cmd/safety_profile_baked_gen.go"])("rejects ignored build input %s", ignored => {
 expect(()=>assertSourceInputs("",`${ignored}\0`)).toThrow(/ignored/i);
});
it("accepts a clean checkout and precisely the expected extension changes", () => {
 expect(()=>assertSourceInputs("", "")).not.toThrow();
 expect(()=>assertSourceInputs(" M internal/cmd/calendar.go\n?? internal/cmd/calendar_ezra_event.go\n?? internal/cmd/calendar_ezra_event_test.go", "")).not.toThrow();
});
it("rejects unrelated visible changes alongside the extension", () => {
 expect(()=>assertSourceInputs(" M internal/cmd/calendar.go\n?? internal/cmd/other.go", "")).toThrow(/unrelated/);
});
