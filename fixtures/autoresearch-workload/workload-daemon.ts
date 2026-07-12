import { AgentProviderRegistry } from "../../src/agents/types.ts";
import { KeelDaemon } from "../../src/daemon/server.ts";
import { ScriptedWorkloadProvider } from "./scripted-provider.ts";

const socketPath = process.env.KEEL_SOCKET;
const dbPath = process.env.KEEL_DB;
if (!socketPath || !dbPath) throw new Error("KEEL_SOCKET and KEEL_DB are required");

const provider = new ScriptedWorkloadProvider({
  ...(process.env.KEEL_CALL_LOG ? { callLog: process.env.KEEL_CALL_LOG } : {}),
  ...(process.env.KEEL_SLOW_KEY ? { slowKey: process.env.KEEL_SLOW_KEY } : {}),
  slowMs: Number(process.env.KEEL_SLOW_MS ?? "0"),
});
const daemon = new KeelDaemon({
  socketPath,
  dbPath,
  agents: new AgentProviderRegistry().register(provider),
  ...(process.env.KEEL_ADMIN_TOKEN ? { adminToken: process.env.KEEL_ADMIN_TOKEN } : {}),
  heartbeatMs: 100,
  superviseMs: 25,
});
await daemon.start();
process.stdout.write(`READY ${daemon.ownerId}\n`);
process.on("SIGTERM", () => {
  daemon.stop();
  process.exit(0);
});
await new Promise(() => {});
