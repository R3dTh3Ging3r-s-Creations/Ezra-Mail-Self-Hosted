import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvConfig } from "@next/env";
import { z } from "zod";
import {
  addMessageContext,
  createReplyDraft,
  getEmailDashboard,
  recordFeedback,
  requestSendApproval,
  saveContinuityCheckpoint,
  switchModel,
} from "../src/lib/email/service";

loadEnvConfig(process.cwd());

async function main() {
  const server = new McpServer({
    name: "ezra-email",
    version: "1.0.0",
  });

  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });

  server.registerTool("email.get_pending", {}, async () => {
    const state = await getEmailDashboard();
    return text(state.inbox.filter((item) => item.attention !== "suppress"));
  });

  server.registerTool(
    "email.get_thread",
    { inputSchema: { messageId: z.string() } },
    async ({ messageId }) => {
      const state = await getEmailDashboard();
      return text(state.inbox.find((item) => item.id === messageId) || null);
    },
  );

  server.registerTool(
    "email.add_context",
    { inputSchema: { messageId: z.string(), content: z.string().min(1).max(20_000) } },
    async ({ messageId, content }) => {
      await addMessageContext(messageId, content, "mcp");
      return text({ ok: true });
    },
  );

  server.registerTool(
    "email.create_draft",
    { inputSchema: { messageId: z.string(), context: z.string().max(20_000).optional() } },
    async ({ messageId, context }) => text(await createReplyDraft(messageId, context, "mcp")),
  );

  server.registerTool(
    "email.request_send",
    {
      description:
        "Creates a pending approval for an exact draft. This never sends email; a separate human approval is required.",
      inputSchema: { draftId: z.string() },
    },
    async ({ draftId }) => text(await requestSendApproval(draftId, "mcp")),
  );

  server.registerTool(
    "email.record_feedback",
    {
      inputSchema: {
        messageId: z.string(),
        value: z.enum(["interrupt", "digest", "suppress"]),
      },
    },
    async ({ messageId, value }) => {
      await recordFeedback(messageId, value, "mcp");
      return text({ ok: true });
    },
  );

  server.registerTool(
    "email.save_checkpoint",
    {
      description:
        "Save a structured pre-compaction continuity checkpoint. Do not include raw email bodies, secrets, authentication codes, hidden reasoning, or transient triage details.",
      inputSchema: {
        summary: z.string().min(1).max(1200),
        durablePreferences: z.array(z.string().min(1).max(400)).max(12).default([]),
        decisions: z.array(z.string().min(1).max(400)).max(12).default([]),
        unresolved: z.array(z.string().min(1).max(400)).max(12).default([]),
        corrections: z.array(z.string().min(1).max(400)).max(12).default([]),
        actionBoundaries: z.array(z.string().min(1).max(400)).max(12).default([]),
      },
    },
    async (checkpoint) => text(await saveContinuityCheckpoint(checkpoint, "mcp")),
  );

  server.registerTool(
    "email.switch_model",
    {
      inputSchema: {
        model: z.enum(["qwen3:8b-maxctx", "qwen3.5:9b-maxctx", "qwen3:14b-maxctx"]),
      },
    },
    async ({ model }) => text({ model: await switchModel(model, "mcp") }),
  );

  await server.connect(new StdioServerTransport());
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
