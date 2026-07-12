import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadMcpCredential } from "./auth.ts";
import { DEFAULT_MCP_PAGE_LIMIT, MAX_MCP_PAGE_LIMIT, SupervisorTools } from "./tools.ts";

const runIdSchema = z.string().min(1).describe("Keel run ID");
const afterSeqSchema = z.number().int().nonnegative().optional();
const limitSchema = z.number().int().min(1).max(MAX_MCP_PAGE_LIMIT).default(DEFAULT_MCP_PAGE_LIMIT);

export function createSupervisorMcpServer(tools: SupervisorTools): McpServer {
  const server = new McpServer(
    { name: "keel-supervisor", version: "0.0.0" },
    {
      instructions:
        "Poll watch_run for compact status, use tail_checkpoints with a persisted nextCursor for progress, and use send_signal to steer a waiting or supervised workflow.",
    },
  );

  server.registerTool(
    "list_runs",
    {
      description: "List the newest Keel runs in a bounded page. Requires admin authority.",
      inputSchema: { limit: limitSchema, children_of: runIdSchema.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, children_of }) => result(await tools.listRuns(limit, children_of)),
  );
  server.registerTool(
    "watch_run",
    {
      description: "Get a compact run status, phase, and blockage summary for polling.",
      inputSchema: { runId: runIdSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => result(await tools.watchRun(runId)),
  );
  server.registerTool(
    "get_run_detail",
    {
      description: "Get the canonical RunProjection, optionally with its journaled result report.",
      inputSchema: { runId: runIdSchema, includeReport: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    async ({ runId, includeReport }) => result(await tools.getRunDetail(runId, includeReport)),
  );
  server.registerTool(
    "get_state",
    {
      description: "Get the current materialized run-scoped state, optionally for one namespace.",
      inputSchema: { runId: runIdSchema, namespace: z.string().min(1).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ runId, namespace }) => result(await tools.getState(runId, namespace)),
  );
  server.registerTool(
    "get_run_blockage",
    {
      description: "Explain what a run is waiting on. Human waits include an approvalId.",
      inputSchema: { runId: runIdSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => result(await tools.getRunBlockage(runId)),
  );
  server.registerTool(
    "tail_checkpoints",
    {
      description: "Read a bounded durable checkpoint-event page after a sequence cursor.",
      inputSchema: { runId: runIdSchema, afterSeq: afterSeqSchema, limit: limitSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ runId, afterSeq, limit }) =>
      result(await tools.tailCheckpoints(runId, afterSeq, limit)),
  );
  server.registerTool(
    "tail_events",
    {
      description: "Read a bounded page of durable run events, optionally filtered by type.",
      inputSchema: {
        runId: runIdSchema,
        afterSeq: afterSeqSchema,
        types: z.array(z.string().min(1)).optional(),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ runId, afterSeq, types, limit }) =>
      result(await tools.tailEvents(runId, afterSeq, types, limit)),
  );
  server.registerTool(
    "send_signal",
    {
      description: "Durably deliver a named signal and acknowledge any accepted wake.",
      inputSchema: { runId: runIdSchema, name: z.string().min(1), payload: z.unknown() },
    },
    async ({ runId, name, payload }) => result(await tools.sendSignal(runId, name, payload)),
  );
  server.registerTool(
    "decide_approval",
    {
      description: "Approve or deny the approvalId returned by get_run_blockage. Requires admin.",
      inputSchema: {
        approvalId: z.string().min(1),
        decision: z.enum(["approved", "denied"]),
        note: z.string().optional(),
      },
    },
    async ({ approvalId, decision, note }) =>
      result(await tools.decideApproval(approvalId, decision, note)),
  );
  server.registerTool(
    "interrupt_run",
    {
      description: "Interrupt a non-terminal run until it is explicitly resumed.",
      inputSchema: { runId: runIdSchema },
    },
    async ({ runId }) => result(await tools.interruptRun(runId)),
  );
  server.registerTool(
    "resume_run",
    {
      description: "Resume an interrupted or otherwise resumable run.",
      inputSchema: { runId: runIdSchema },
    },
    async ({ runId }) => result(await tools.resumeRun(runId)),
  );
  server.registerTool(
    "launch_saved_workflow",
    {
      description: "Launch a saved workflow by name or name@version and return only its run ID.",
      inputSchema: { ref: z.string().min(1), input: z.unknown().optional() },
    },
    async ({ ref, input }) => result(await tools.launchSavedWorkflow(ref, input)),
  );
  server.registerTool(
    "wait_for_run",
    {
      description: "Wait until a run reaches its next terminal or parked outcome.",
      inputSchema: { runId: runIdSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => result(await tools.waitForRun(runId)),
  );

  return server;
}

export async function runMcpServer(opts: { socketPath: string }): Promise<void> {
  const tools = await SupervisorTools.connect({
    socketPath: opts.socketPath,
    credential: loadMcpCredential(),
  });
  const server = createSupervisorMcpServer(tools);
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
    await new Promise<void>((resolve) => {
      const serverOnClose = transport.onclose;
      transport.onclose = () => {
        serverOnClose?.();
        resolve();
      };
    });
  } finally {
    tools.close();
  }
}

function result(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
