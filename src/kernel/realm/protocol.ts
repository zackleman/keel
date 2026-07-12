// Realm bridge protocol (DESIGN.md §6).
//
// The workflow body runs in a Worker (the realm); the journal lives on the host.
// Awaitable effects (step) use async postMessage RPC so Promise.all fan-out can
// have many in flight. The two synchronous number sources (now/random) use a
// SharedArrayBuffer + Atomics handshake so a sync `ctx.now()` can block briefly
// for the host's reply. log/phase are fire-and-forget.

import type { Capabilities, ToolPolicy } from "../../agents/capabilities.ts";
import type { NormalizedAgentEnvironment } from "../../agents/environment.ts";
import type { ProviderConfigValue } from "../../agents/types.ts";
import type { InputDep, WorkspaceRetention } from "../../journal/types.ts";
import type { WorkflowVisibleSettings } from "../../settings/catalog.ts";
import type { NormalizedCheckpoint } from "../checkpoint.ts";
import type { CommandResult, NormalizedWorkflowCommandSpec } from "../command.ts";
import type {
  CompletionCheckResult,
  NormalizedCompletionCheckEffectSpec,
} from "../completion-check.ts";
import type { NormalizedSpawn } from "../spawn.ts";
import type { NormalizedStateWrite } from "../state.ts";

/** SAB layout: Int32 control[0] is the ambient handshake flag; Float64 holds
 * the returned number. */
export const SAB_BYTES = 64;
export const CONTROL_WORDS = 4; // 16 bytes
export const VALUE_OFFSET = 16; // Float64 at byte 16

// ---- worker -> host -------------------------------------------------------

export type WorkerRequest =
  | {
      type: "step-begin";
      id: number;
      key: string;
      inputs: unknown;
      version: string;
      deps: InputDep[] | null;
    }
  | {
      type: "workspace";
      id: number;
      spec: {
        key: string;
        mode?: string | null;
        path?: string | null;
        repo?: string | null;
        ref?: string | null;
        retention?: WorkspaceRetention | null;
        branch?: boolean | null;
        setup?: unknown;
      };
    }
  | {
      type: "agent";
      id: number;
      key: string;
      prompt: string;
      provider: string;
      providerConfig: ProviderConfigValue | null;
      model: string | null;
      reasoning: string | null;
      toolPolicy: ToolPolicy;
      allowTools: string[];
      denyTools: string[];
      workspaceId: string;
      setupIdentityHash: string | null;
      capabilities: Capabilities | null;
      environment: NormalizedAgentEnvironment;
      version: string;
      inputs: unknown;
      jsonSchema: unknown;
      maxRetries: number;
      lenient: boolean;
      onFailure: "throw" | "null";
      timeoutMs: number;
      stallRetries: number;
      deps: InputDep[] | null;
    }
  | {
      type: "agent-turn";
      id: number;
      agentKey: string;
      turnKey: string;
      stableKey: string;
      identityHash: string;
      identityJson: string;
      prompt: string;
      provider: string;
      providerConfig: ProviderConfigValue | null;
      model: string | null;
      reasoning: string | null;
      toolPolicy: ToolPolicy;
      allowTools: string[];
      denyTools: string[];
      workspaceId: string;
      setupIdentityHash: string | null;
      capabilities: Capabilities | null;
      environment: NormalizedAgentEnvironment;
      version: string;
      inputs: unknown;
      jsonSchema: unknown;
      maxRetries: number;
      lenient: boolean;
      onFailure: "throw" | "null";
      timeoutMs: number;
      stallRetries: number;
      deps: InputDep[] | null;
    }
  | {
      type: "command";
      id: number;
      command: NormalizedWorkflowCommandSpec;
      version: string;
      inputs: unknown;
      deps: InputDep[] | null;
    }
  | {
      type: "completion-check";
      id: number;
      completionCheck: NormalizedCompletionCheckEffectSpec;
      version: string;
      inputs: unknown;
      deps: InputDep[] | null;
    }
  | {
      type: "checkpoint";
      id: number;
      checkpoint: NormalizedCheckpoint;
      version: string;
    }
  | {
      type: "drain-signals";
      id: number;
      key: string;
      name: string;
      inputs: unknown;
      version: string;
    }
  | {
      type: "spawn";
      id: number;
      spawn: NormalizedSpawn;
      version: string;
    }
  | {
      type: "wait-run";
      id: number;
      key: string;
      childRunId: string;
      inputs: unknown;
      version: string;
    }
  | {
      type: "state-write";
      id: number;
      state: NormalizedStateWrite;
      version: string;
    }
  | {
      type: "step-commit";
      id: number;
      key: string;
      attempt: number;
      version: string;
      inputHash: string;
      startedAtMs: number;
      value: unknown;
      deps: InputDep[] | null;
    }
  | {
      type: "step-fail";
      id: number;
      key: string;
      attempt: number;
      version: string;
      inputHash: string;
      startedAtMs: number;
      error: { name: string; message: string };
    }
  | { type: "ambient"; kind: "now" | "random" }
  | {
      // park-readiness probe for a durable wait (timer/signal/human, §16/§17).
      type: "park-check";
      id: number;
      kind: "timer" | "signal" | "human";
      key: string;
      durationMs: number | null;
      payload: unknown;
    }
  | { type: "log"; message: string; data: unknown }
  | { type: "phase"; title: string }
  | { type: "result"; output: unknown }
  | { type: "continue"; input: unknown }
  | {
      // the body unwound on a park; the host persists the wait and suspends.
      type: "parked";
      kind: "timer" | "signal" | "human";
      key: string;
      until: number | null;
    }
  | { type: "error"; error: { name: string; message: string } }
  | { type: "ready" };

/** park-check reply payload. */
export interface ParkCheckReply {
  ready: boolean;
  /** Resolved value when ready (e.g. a signal payload); undefined for timers. */
  value?: unknown;
  /** Fire time (timers) for the parked record. */
  until?: number | null;
}

// ---- host -> worker -------------------------------------------------------

export type StepBeginReply =
  | { action: "replay"; value: unknown; contentHash: string }
  | { action: "execute"; attempt: number; inputHash: string; startedAtMs: number };

export type HostReply =
  | {
      type: "init";
      workflowUrl: string;
      input: unknown;
      sab: SharedArrayBuffer;
      moduleHelpers: Record<string, string>;
      agentProfiles: Record<string, unknown>;
      workflowSettings: WorkflowVisibleSettings;
      runId: string;
      runTarget: string | null;
    }
  | { type: "rpc-reply"; id: number; payload: unknown }
  | { type: "rpc-error"; id: number; error: { name: string; message: string } };

export interface CommandReply {
  ok: boolean;
  result?: CommandResult;
  contentHash?: string;
  error?: { name: string; message: string };
}

export interface CompletionCheckReply {
  ok: boolean;
  result?: CompletionCheckResult;
  contentHash?: string;
  error?: { name: string; message: string };
}
