import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createAgentHttpClient} from "../../../src/lib/email/agent-http-client";
import {createAgentKeyMcpServer} from "../../../src/lib/email/agent-key-mcp";
import {loadLinuxAgentRuntime} from "./agent-linux-runtime";
async function main(){
 if(process.argv.length!==2)throw new Error();
 const runtime=await loadLinuxAgentRuntime({platform:process.platform,uid:process.getuid?.(),execPath:process.execPath,entryPath:process.argv[1],environment:process.env});
 await createAgentKeyMcpServer(createAgentHttpClient(runtime)).connect(new StdioServerTransport());
}
main().catch(()=>{process.stderr.write("Linux scoped MCP startup refused. Verify the sealed release, profile and service credentials.\n");process.exitCode=1;});