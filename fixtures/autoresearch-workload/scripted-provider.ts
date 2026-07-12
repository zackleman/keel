import { appendFileSync } from "node:fs";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
} from "../../src/agents/types.ts";

export interface ScriptedWorkloadProviderOptions {
  callLog?: string;
  slowKey?: string;
  slowMs?: number;
}

export class ScriptedWorkloadProvider implements AgentProvider {
  readonly name = "mock";
  private readonly calls = new Map<string, number>();

  constructor(private readonly options: ScriptedWorkloadProviderOptions = {}) {}

  async generate(invocation: AgentInvocation, _hooks: AgentHooks): Promise<AgentResult> {
    const call = (this.calls.get(invocation.key) ?? 0) + 1;
    this.calls.set(invocation.key, call);
    const output = scriptedOutput(invocation.key);
    if (this.options.callLog) {
      appendFileSync(
        this.options.callLog,
        `${JSON.stringify({ key: invocation.key, call, prompt: invocation.prompt, output })}\n`,
      );
    }
    const slowMs = this.options.slowMs ?? 0;
    if (invocation.key === this.options.slowKey && slowMs > 0) {
      await Bun.sleep(slowMs);
    }
    return { text: output, transcript: [] };
  }
}

function scriptedOutput(key: string): string {
  switch (key) {
    case "setup":
      return JSON.stringify({ baselineScore: 0, hypothesis: "reduce validation loss" });
    case "experiment:0":
      return JSON.stringify({ score: 10, candidate: "candidate-a", summary: "first gain" });
    case "experiment:1":
      return "not-json";
    case "experiment:2":
      return JSON.stringify({ score: 12, candidate: "candidate-c", summary: "late gain" });
    case "recorder":
      return JSON.stringify({ summary: "recorded autoresearch history" });
    default:
      throw new Error(`scripted workload provider has no response for "${key}"`);
  }
}
