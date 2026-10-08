import { act,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { AgentAccessSettings } from "@/components/ezra/AgentAccessSettings";
const mocks=vi.hoisted(()=>({api:vi.fn(),post:vi.fn(),confirmGrantReview:vi.fn()}));
vi.mock("@/components/ezra/api",()=>mocks);
const account={accountId:"ms",provider:"microsoft",expectedEmail:"owner@hotmail.test"};
describe("owner agent access controls",()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.api.mockImplementation(async(url:string)=>url.endsWith("resources")?{accounts:[{account,availableScopes:["accounts.read","mail.read","calendar.read","calendar.create"],unavailable:["Conditional writes await provider checks."]}]}:{grants:[]});mocks.post.mockImplementation(async(url:string)=>url.endsWith("resources")?{resources:[{title:"Primary calendar",target:{account,kind:"calendar",id:"exact-calendar"}}]}:url.endsWith("review")?{reviewHash:"a".repeat(64)}:{grant:{keyId:"new"},secret:"fake-once-only"});mocks.confirmGrantReview.mockResolvedValue("receipt");});
 it("defaults to seven days and no write authority; resources are deliberate",async()=>{render(<AgentAccessSettings/>);await screen.findByText("owner@hotmail.test");expect(screen.getByLabelText("Key lifetime")).toHaveValue("7");expect(Array.from((screen.getByLabelText("Key lifetime") as HTMLSelectElement).options).map(o=>o.value)).toEqual(["1","7","30"]);expect(screen.getByLabelText("calendar.create")).not.toBeChecked();expect(mocks.post).not.toHaveBeenCalled();expect(screen.getByText("Conditional writes await provider checks.")).toBeInTheDocument();});
 it("changed selection invalidates review and navigation clears the once-only secret",async()=>{render(<AgentAccessSettings/>);fireEvent.click(await screen.findByLabelText("owner@hotmail.test"));fireEvent.click(screen.getByText("Load calendars"));fireEvent.click(await screen.findByLabelText(/Primary calendar/));fireEvent.click(screen.getByText("Review access"));await screen.findByText("Issue key with passkey");fireEvent.change(screen.getByLabelText("Key label"),{target:{value:"Changed"}});expect(screen.queryByText("Issue key with passkey")).not.toBeInTheDocument();fireEvent.click(screen.getByText("Review access"));fireEvent.click(await screen.findByText("Issue key with passkey"));await screen.findByDisplayValue("fake-once-only");window.dispatchEvent(new Event("ezra:before-navigate"));await waitFor(()=>expect(screen.queryByDisplayValue("fake-once-only")).not.toBeInTheDocument());});
 it("keeps selections and shows an actionable review error before a deliberate retry",async()=>{
  mocks.post.mockRejectedValueOnce(Object.assign(new Error("access_denied"),{status:403}));
  render(<AgentAccessSettings/>);
  fireEvent.click(await screen.findByLabelText("owner@hotmail.test"));
  fireEvent.click(screen.getByText("Review access"));
  expect(await screen.findByRole("alert")).toHaveTextContent("configured owner/passkey address");
  expect(screen.getByLabelText("owner@hotmail.test")).toBeChecked();
  expect(screen.queryByText("Issue key with passkey")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Review access"));
  expect(await screen.findByRole("region",{name:"Exact access review"})).toHaveFocus();
  expect(mocks.confirmGrantReview).not.toHaveBeenCalled();
 });
 it("ignores a pending review result after navigation and permits a new review",async()=>{
  let finish!:(value:{reviewHash:string})=>void;
  mocks.post.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  render(<AgentAccessSettings/>);
  fireEvent.click(await screen.findByLabelText("owner@hotmail.test"));
  fireEvent.click(screen.getByText("Review access"));
  expect(screen.getByRole("status")).toHaveTextContent("Preparing access review");
  act(()=>window.dispatchEvent(new Event("ezra:before-navigate")));
  await act(async()=>finish({reviewHash:"b".repeat(64)}));
  expect(screen.queryByText("Issue key with passkey")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Review access"));
  expect(await screen.findByText("Issue key with passkey")).toBeInTheDocument();
  expect(mocks.confirmGrantReview).not.toHaveBeenCalled();
 });
 it("does not restore a stale error after leaving and reopening access",async()=>{
  let reject!:(error:Error)=>void;
  mocks.post.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  render(<AgentAccessSettings/>);
  fireEvent.click(await screen.findByLabelText("owner@hotmail.test"));
  fireEvent.click(screen.getByText("Review access"));
  act(()=>window.dispatchEvent(new Event("ezra:before-navigate")));
  await act(async()=>reject(new Error("interrupted")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Review access"));
  expect(await screen.findByText("Issue key with passkey")).toBeInTheDocument();
 });

 it("does not restore an initial catalogue error after navigation",async()=>{
  let reject!:(error:Error)=>void;
  mocks.api.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  render(<AgentAccessSettings/>);
  act(()=>window.dispatchEvent(new Event("ezra:before-navigate")));
  await act(async()=>reject(new Error("interrupted initial load")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mocks.post).not.toHaveBeenCalled();
 });

 async function issueSyntheticKey(){
  render(<AgentAccessSettings/>);
  fireEvent.click(await screen.findByLabelText("owner@hotmail.test"));
  fireEvent.click(screen.getByText("Review access"));
  fireEvent.click(await screen.findByText("Issue key with passkey"));
  await screen.findByLabelText("Once-only agent key");
  await waitFor(()=>expect(screen.queryByText("Completing request...")).not.toBeInTheDocument());
 }
 afterEach(()=>vi.unstubAllGlobals());
 it("copies only the once-only key after an owner click while retaining masking",async()=>{
  const writeText=vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator",{clipboard:{writeText}});
  await issueSyntheticKey();
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Once-only agent key")).toHaveAttribute("type","password");
  const requests=mocks.post.mock.calls.length;
  fireEvent.click(screen.getByRole("button",{name:"Copy key"}));
  expect(await screen.findByText(/Key copied/)).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledExactlyOnceWith("fake-once-only");
  expect(mocks.post).toHaveBeenCalledTimes(requests);
  expect(screen.getByLabelText("Once-only agent key")).toHaveAttribute("type","password");
  fireEvent.click(screen.getByRole("button",{name:"Dismiss key"}));
  expect(screen.queryByLabelText("Once-only agent key")).not.toBeInTheDocument();
  expect(screen.queryByText(/Key copied/)).not.toBeInTheDocument();
 });
 it("keeps the masked key after clipboard failure and allows an explicit retry",async()=>{
  const writeText=vi.fn().mockRejectedValueOnce(new Error("sensitive browser failure")).mockResolvedValueOnce(undefined);
  vi.stubGlobal("navigator",{clipboard:{writeText}});
  await issueSyntheticKey();
  fireEvent.click(screen.getByRole("button",{name:"Copy key"}));
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not copy/i);
  expect(screen.queryByText(/sensitive browser failure/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("Once-only agent key")).toHaveValue("fake-once-only");
  fireEvent.click(screen.getByRole("button",{name:"Copy key"}));
  expect(await screen.findByText(/Key copied/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
 });
 it("reports unavailable clipboard access without clearing the once-only key",async()=>{
  vi.stubGlobal("navigator",{});
  await issueSyntheticKey();
  fireEvent.click(screen.getByRole("button",{name:"Copy key"}));
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not copy/i);
  expect(screen.getByLabelText("Once-only agent key")).toHaveValue("fake-once-only");
 });
 it.each(["ezra:before-navigate","pagehide","dismiss"])("ignores pending clipboard completion after %s",async(event)=>{
  let finish!:()=>void;
  let fail!:(error:Error)=>void;
  const writeText=vi.fn(()=>new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;}));
  vi.stubGlobal("navigator",{clipboard:{writeText}});
  await issueSyntheticKey();
  fireEvent.click(screen.getByRole("button",{name:"Copy key"}));
  expect(screen.getByRole("button",{name:/Copying/})).toBeDisabled();
  if(event==="dismiss")fireEvent.click(screen.getByRole("button",{name:"Dismiss key"}));
  else act(()=>window.dispatchEvent(new Event(event)));
  expect(screen.queryByLabelText("Once-only agent key")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Review access"));
  fireEvent.click(await screen.findByText("Issue key with passkey"));
  await screen.findByLabelText("Once-only agent key");
  await act(async()=>event==="pagehide"?fail(new Error("old copy failed")):finish());
  expect(screen.queryByText(/Key copied/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Could not copy/)).not.toBeInTheDocument();
  expect(screen.getByRole("button",{name:"Copy key"})).toBeEnabled();
 });
});
