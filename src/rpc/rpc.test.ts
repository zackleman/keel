// Phase 11: the RPC contract + canonical RunProjection. A workflow driven through
// the RPC layer yields the same result as direct kernel use; the projection is
// golden-locked; events stream through subscribeEvents.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../agents/mock.ts";
import { SecretStore } from "../agents/secrets.ts";
import {
  type AgentHooks,
  type AgentInvocation,
  type AgentProvider,
  AgentProviderRegistry,
  type AgentResult,
} from "../agents/types.ts";
import { JournalStore } from "../journal/store.ts";
import type { AgentWorkspaceStatus, RunStatus } from "../journal/types.ts";
import { RUN_FINISHED_INLINE_OUTPUT_BYTES } from "../kernel/output.ts";
import { RealmKernel } from "../kernel/realm/realm-host.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import {
  WORKFLOW_SDK_ABI_VERSION,
  materializeWorkflowDefinition,
} from "../workflow-definitions/snapshot.ts";
import {
  classifyCloneSource,
  createRetainedCopy,
  createRetainedWorktree,
  retainedWorkspacePath,
} from "../workspace/worktree.ts";
import { normalizeEventCursorInput } from "./event-cursor.ts";
import { EventHub } from "./event-hub.ts";
import { InProcessKeel } from "./in-process.ts";
import { MAX_RUN_SUMMARY_PAGE_LIMIT } from "./projection.ts";

const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const onceUrl = captureWorkflowFile(new URL("agent-once.workflow.ts", FIX).pathname);
const reviewUrl = captureWorkflowFile(new URL("agent-review.workflow.ts", FIX).pathname);
const chainUrl = captureWorkflowFile(new URL("chain.workflow.ts", FIX).pathname);
const flakyUrl = captureWorkflowFile(new URL("flaky.workflow.ts", FIX).pathname);
const signalUrl = captureWorkflowFile(new URL("await-signal.workflow.ts", FIX).pathname);
const WORKFLOW_TEST_TIMEOUT_MS = 20_000;

class TestInProcessKeel extends InProcessKeel {
  override launchRun(req: Parameters<InProcessKeel["launchRun"]>[0]) {
    return super.launchRun({ ...req, target: req.target ?? process.cwd() });
  }
}

class FailsOnceRecordingProvider implements AgentProvider {
  readonly name = "recording";
  readonly calls: AgentInvocation[] = [];
  private failed = false;

  async generate(invocation: AgentInvocation): Promise<AgentResult> {
    this.calls.push(invocation);
    if (!this.failed) {
      this.failed = true;
      throw new Error("first failure");
    }
    return { text: "ok", transcript: [] };
  }
}

function keel(store: JournalStore, mock?: MockProvider): InProcessKeel {
  let id = 0;
  const kernel = new RealmKernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => 1,
    rng: () => 0.5,
    ...(mock ? { agents: new AgentProviderRegistry().register(mock) } : {}),
  });
  return new TestInProcessKeel(kernel, store);
}

const SECRET_ECHO_WORKFLOW = {
  source: `
    import { type Ctx, passthrough } from "@kcosr/keel";
    export default async function wf(ctx: Ctx, input: { label?: string } | null): Promise<string> {
      const label = input?.label ?? "default";
      await ctx.step("prefix", passthrough<string>(), label, (value) => value);
      return await ctx.agent({
        key: "secret",
        provider: "secret-echo",
        prompt: "echo " + label,
        capabilities: { secrets: ["TOKEN"] },
        environment: { secrets: ["TOKEN"] },
      });
    }
  `,
  name: "secret-echo",
};

function secretEchoApi(store: JournalStore): InProcessKeel {
  let id = 0;
  const provider: AgentProvider = {
    name: "secret-echo",
    async generate(invocation: AgentInvocation): Promise<AgentResult> {
      return {
        text: `${invocation.prompt}:${invocation.env?.TOKEN ?? "<missing>"}`,
        transcript: [],
      };
    },
  };
  const kernel = new RealmKernel(store, {
    idgen: () => `run_secret_${id++}`,
    clock: () => 1,
    rng: () => 0.5,
    agents: new AgentProviderRegistry().register(provider),
    secrets: new SecretStore(),
  });
  return new TestInProcessKeel(kernel, store);
}

function putDisplayableWorkflowDefinition(
  store: JournalStore,
  hash: string,
  source: string,
  createdAtMs: number,
): void {
  store.putWorkflowDefinition({
    hash,
    name: "displayable",
    kind: "source",
    code: source,
    sourceMap: null,
    manifestJson: JSON.stringify({
      format: "keel.workflow-definition.v1",
      entry: "entry.ts",
      modules: [{ path: "entry.ts", code: source }],
      externalImports: [],
      externalPackages: [],
      sourceRoot: "client-captured://source",
      runtime: {
        bunVersion: Bun.version,
        keelDefinitionAbi: 1,
        workflowSdkAbi: WORKFLOW_SDK_ABI_VERSION,
      },
    }),
    createdAtMs,
  });
}

function streamingKeel(store: JournalStore, provider: AgentProvider): InProcessKeel {
  const hub = new EventHub();
  const kernel = new RealmKernel(store, {
    idgen: () => "run_stream",
    clock: () => 1,
    rng: () => 0.5,
    agents: new AgentProviderRegistry().register(provider),
    liveEvent: (runId, type, payload, atMs) => hub.publishEphemeral(runId, type, payload, atMs),
  });
  return new TestInProcessKeel(kernel, store, hub);
}

function initGitRepo(repo: string): string {
  const g = (args: string[]) => execFileSync("git", args, { cwd: repo });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "app.js"), "const x = 1;\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function insertWorkspaceFixture(
  store: JournalStore,
  opts: {
    runId: string;
    agentKey: string;
    repo: string;
    baseCommit: string;
    workspacePath: string;
    runStatus: RunStatus;
    workspaceStatus: AgentWorkspaceStatus;
    activeTurn?: boolean;
    heartbeatAtMs?: number | null;
    runtimeOwnerId?: string | null;
    updatedAtMs?: number;
  },
): void {
  store.insertRun({
    runId: opts.runId,
    workflowName: "wf",
    definitionVersion: "wf_sha256_fixture",
    workflowRef: null,
    runTarget: opts.repo,
    status: opts.runStatus,
    parentRunId: null,
    tenantId: null,
    inputRef: "null",
    outputRef: null,
    errorJson: null,
    heartbeatAtMs: opts.heartbeatAtMs ?? null,
    runtimeOwnerId: opts.runtimeOwnerId ?? null,
    createdAtMs: 1,
    finishedAtMs: ["finished", "failed", "cancelled", "continued"].includes(opts.runStatus)
      ? 2
      : null,
  });
  store.insertAgentSession({
    runId: opts.runId,
    agentKey: opts.agentKey,
    identityHash: "identity",
    identityJson: "{}",
    currentSessionToken: null,
    latestCompletedTurnKey: null,
    latestCompletedAttempt: null,
    activeTurnKey: opts.activeTurn ? "turn" : null,
    activeTurnAttempt: opts.activeTurn ? 1 : null,
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  store.insertAgentWorkspace({
    runId: opts.runId,
    workspaceId: `ws_${opts.agentKey}`,
    mode: "worktree",
    ownerKind: "agent_session",
    key: opts.agentKey,
    lastAttempt: null,
    retentionPolicy: "retain",
    workspacePath: opts.workspacePath,
    sourceKind: "worktree-git",
    sourcePath: opts.repo,
    sourceUri: null,
    sourceBare: null,
    sourceMergeEligible: true,
    suppliedPath: null,
    sourceRef: "HEAD",
    resolvedRef: null,
    checkoutBranch: null,
    worktreeCheckoutKind: "detached",
    worktreeBranchOwned: false,
    baseCommit: opts.baseCommit,
    copyBaselinePath: null,
    creationErrorJson: null,
    workspaceIdentityJson: "{}",
    workspaceIdentityHash: `${opts.runId}-${opts.agentKey}`,
    owned: true,
    status: opts.workspaceStatus,
    failureSeen: false,
    lastTurnKey: opts.activeTurn ? "turn" : null,
    lastTurnAttempt: opts.activeTurn ? 1 : null,
    activeHolderKind: null,
    activeHolderKey: null,
    activeHolderAttempt: null,
    activeStartedAtMs: null,
    lastDiffEventSeq: null,
    lastErrorEventSeq: null,
    cleanupErrorJson: null,
    createdAtMs: 1,
    updatedAtMs: opts.updatedAtMs ?? 1,
    mergedAtMs: null,
    discardedAtMs: null,
    removedAtMs: null,
  });
}

describe("agent profile RPC", () => {
  test("manages catalog profiles with generation preconditions and programmatic source visibility", () => {
    const store = JournalStore.memory();
    const piProvider: AgentProvider = {
      name: "pi",
      async generate(): Promise<AgentResult> {
        return { text: "ok", transcript: [] };
      },
    };
    const codexProvider: AgentProvider = {
      name: "codex",
      async generate(): Promise<AgentResult> {
        return { text: "ok", transcript: [] };
      },
    };
    const registry = new AgentProviderRegistry()
      .register(new MockProvider())
      .register(piProvider)
      .register(codexProvider);
    const kernel = new RealmKernel(store, {
      idgen: () => "run_profiles",
      agents: registry,
      agentProfiles: { builtin: { provider: "mock", model: "fixed" } },
    });
    const api = new InProcessKeel(kernel, store, new EventHub(), {
      agents: registry,
      clock: () => 10,
    });

    expect(api.listAgentProfiles()).toMatchObject([{ name: "builtin", source: "programmatic" }]);
    const saved = api.putAgentProfile({
      name: "reviewer",
      config: { provider: "mock", model: "one", toolPolicy: "read-only" },
      createOnly: true,
    });
    expect(saved).toMatchObject({ name: "reviewer", source: "catalog", generation: 1 });
    expect(() =>
      api.putAgentProfile({
        name: "reviewer",
        config: { provider: "mock", model: "two" },
        ifGeneration: 2,
      }),
    ).toThrow(/generation precondition/);
    expect(() =>
      api.putAgentProfile({
        name: "pi-reviewer",
        config: { provider: "pi", toolPolicy: "read-only", allowTools: ["run"] },
        createOnly: true,
      }),
    ).toThrow(/pi provider tool "run" is not canonical; use "bash"/);
    const codexSaved = api.putAgentProfile({
      name: "codex-reviewer",
      config: {
        provider: "codex",
        toolPolicy: "read-only",
        providerConfig: { codex: { transport: { type: "stdio" }, serviceTier: "fast" } },
      },
      createOnly: true,
    });
    expect(codexSaved).toMatchObject({ name: "codex-reviewer", source: "catalog" });
    expect(api.checkAgentProfile({ name: "codex-reviewer" }).ok).toBe(true);
    expect(
      api.checkAgentProfile({
        config: {
          provider: "codex",
          providerConfig: { codex: { transport: { type: "stdio" }, serviceTier: "priority" } },
        },
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [
        {
          level: "error",
          message: expect.stringMatching(/providerConfig\.codex\.serviceTier/),
        },
      ],
    });
    expect(api.checkAgentProfile({ name: "reviewer" }).ok).toBe(true);
    expect(() => api.putAgentProfile({ name: "builtin", config: {} })).toThrow(/programmatic/);
    expect(api.deleteAgentProfile({ name: "reviewer", ifGeneration: 1 })).toEqual({
      name: "reviewer",
      deleted: true,
    });
  });
});

describe("settings RPC", () => {
  test("lists, validates, sets, checks, and unsets catalog settings", () => {
    const store = JournalStore.memory();
    const api = keel(store);

    const initial = api.getSetting("agent.defaultTimeoutMs");
    expect(initial).toMatchObject({
      key: "agent.defaultTimeoutMs",
      value: 3600000,
      isDefault: true,
      generation: null,
    });
    expect(api.getSetting("missing.setting")).toBeNull();

    const saved = api.putSetting({ key: "agent.defaultTimeoutMs", value: 7200000 });
    expect(saved).toMatchObject({
      key: "agent.defaultTimeoutMs",
      value: 7200000,
      isDefault: false,
      generation: 1,
    });
    expect(() =>
      api.putSetting({ key: "agent.defaultTimeoutMs", value: 1, ifGeneration: 2 }),
    ).toThrow(/generation precondition/);
    expect(api.checkSetting({ key: "agent.defaultTimeoutMs", value: -1 }).ok).toBe(false);
    expect(api.checkSetting({ key: "missing.setting", value: true }).ok).toBe(false);
    expect(api.checkSetting({ key: "agent.defaultOnFailure", value: "null" }).ok).toBe(false);
    expect(() => api.putSetting({ key: "agent.defaultOnFailure", value: "null" })).toThrow(
      /read-only/,
    );
    expect(api.deleteSetting({ key: "agent.defaultTimeoutMs", ifGeneration: 1 })).toEqual({
      key: "agent.defaultTimeoutMs",
      deleted: true,
    });
    expect(api.deleteSetting({ key: "agent.defaultTimeoutMs" })).toEqual({
      key: "agent.defaultTimeoutMs",
      deleted: false,
    });
  });
});

describe("saved workflow RPC", () => {
  test("previews workflow definitions without mutating saved workflow registry", () => {
    const store = JournalStore.memory();
    const api = keel(store);
    const preview = api.previewWorkflowDefinition({ source: chainUrl.source });
    expect(preview.definitionHash.startsWith("wf_sha256_")).toBe(true);
    expect(store.getWorkflowDefinition(preview.definitionHash)).not.toBeNull();
    expect(api.listSavedWorkflows()).toEqual([]);

    const saved = api.saveWorkflow({
      name: "review-loop",
      source: chainUrl.source,
      defaultTarget: process.cwd(),
    });
    expect(saved.definitionHash).toBe(preview.definitionHash);
    expect(api.getSavedWorkflow("review-loop")?.versions[0]?.definitionHash).toBe(
      preview.definitionHash,
    );
  });

  test("saves source, displays captured source, launches by saved ref, and schedules by hash", async () => {
    const store = JournalStore.memory();
    const api = keel(store);
    const saved = api.saveWorkflow({
      name: "review-loop",
      source: chainUrl.source,
      defaultInput: { n: 2 },
      defaultTarget: process.cwd(),
    });
    expect(saved.version).toBe(1);
    const source = api.getSavedWorkflowSource({ name: "review-loop", all: true });
    expect(
      source.files.some((file) => file.code.includes("export default async function chain")),
    ).toBe(true);
    const definitionSource = api.getWorkflowDefinitionSource({
      lookup: { kind: "definition", definitionHash: saved.definitionHash },
      all: true,
    });
    expect(definitionSource).toMatchObject({
      kind: "workflow-definition-source",
      lookup: { kind: "definition", definitionHash: saved.definitionHash },
      definitionHash: saved.definitionHash,
      definitionName: "review-loop",
    });
    expect(definitionSource.createdAtMs).toBeGreaterThan(0);
    expect(definitionSource.files).toEqual(source.files);
    expect(() =>
      api.getWorkflowDefinitionSource({
        lookup: { kind: "definition", definitionHash: saved.definitionHash },
        file: "missing.ts",
      }),
    ).toThrow(/workflow source file missing\.ts does not exist/);

    const unsaved = await api.launchRun({
      source: chainUrl.source,
      input: { n: 3 },
      target: process.cwd(),
      name: "ad-hoc",
    });
    const runSource = api.getWorkflowDefinitionSource({
      lookup: { kind: "run", runId: unsaved.runId },
    });
    expect(runSource.lookup).toEqual({ kind: "run", runId: unsaved.runId });
    expect(runSource.files).toHaveLength(1);
    expect(runSource.files[0]?.entry).toBe(true);
    expect((await api.waitForRun(unsaved.runId)).output).toBe(3);
    const launched = await api.launchSavedWorkflow({ ref: { name: "review-loop" } });
    const out = await api.waitForRun(launched.runId);
    expect(out.output).toBe(2);
    api.putSchedule({
      name: "hourly",
      savedRef: { name: "review-loop" },
      intervalMs: 60_000,
    });
    expect(() =>
      api.putSchedule({
        name: "bad",
        savedRef: { name: "review-loop" },
        workflowName: "ignored",
        intervalMs: 60_000,
      } as never),
    ).toThrow(/workflowName/);
    const row = store.db
      .query<{ workflow_ref: string }, [string]>(
        "SELECT workflow_ref FROM schedules WHERE name = ?",
      )
      .get("hourly");
    expect(row?.workflow_ref).toBe(saved.definitionHash);
    expect(api.setScheduleEnabled("hourly", false)).toEqual({
      name: "hourly",
      enabled: false,
    });
    expect(api.listSchedules()[0]?.enabled).toBe(false);
    expect(api.deleteSchedule("hourly")).toEqual({ name: "hourly", deleted: true });
    expect(api.getSchedule({ name: "hourly" })).toBeNull();

    api.saveWorkflow({
      name: "null-default",
      source:
        'import { passthrough } from "@kcosr/keel";\nexport default async (_ctx: unknown, input: unknown) => passthrough<unknown>().parse(input);\n',
      defaultInput: null,
      defaultTarget: process.cwd(),
    });
    const nullRun = await api.launchSavedWorkflow({ ref: { name: "null-default" } });
    expect((await api.waitForRun(nullRun.runId)).output).toBeNull();

    api.deprecateSavedWorkflowVersion({ name: "review-loop", version: 1, message: "audit" });
    api.setSavedWorkflowVersionEnabled("review-loop", 1, false);
    expect(
      api.getSavedWorkflowSource({ name: "review-loop", version: 1 }).files[0]?.code,
    ).toContain("export default async function chain");

    store.putWorkflowDefinition({
      hash: "wf_sha256_emptymodules",
      name: "legacy",
      kind: "source",
      code: "export default async () => 7;\n",
      sourceMap: null,
      manifestJson: JSON.stringify({
        format: "keel.workflow-definition.v1",
        entry: "entry.ts",
        modules: [],
        externalImports: [],
        externalPackages: [],
        sourceRoot: "client-captured://source",
        runtime: {
          bunVersion: Bun.version,
          keelDefinitionAbi: 1,
          workflowSdkAbi: 7,
        },
      }),
      createdAtMs: 1,
    });
    store.putSavedWorkflowVersion({
      name: "legacy-source",
      definitionHash: "wf_sha256_emptymodules",
      createdAtMs: 1,
    });
    expect(() => api.getSavedWorkflowSource({ name: "legacy-source" })).toThrow(
      /cannot display source: manifest modules must not be empty/,
    );
    expect(() =>
      api.getWorkflowDefinitionSource({
        lookup: { kind: "definition", definitionHash: "wf_sha256_emptymodules" },
      }),
    ).toThrow(/cannot display source: manifest modules must not be empty/);

    store.putWorkflowDefinition({
      hash: "wf_sha256_codeonly_rpc",
      name: "legacy-code",
      kind: "source",
      code: "export default async () => 8;\n",
      sourceMap: null,
      manifestJson: null,
      createdAtMs: 2,
    });
    store.insertRun({
      runId: "run_codeonly",
      workflowName: "legacy-code",
      definitionVersion: "wf_sha256_codeonly_rpc",
      workflowRef: null,
      runTarget: process.cwd(),
      status: "finished",
      parentRunId: null,
      tenantId: null,
      inputRef: null,
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      createdAtMs: 2,
      finishedAtMs: 2,
    });
    expect(() =>
      api.getWorkflowDefinitionSource({ lookup: { kind: "run", runId: "run_codeonly" } }),
    ).toThrow(/cannot display source: missing manifest_json/);
    expect(() =>
      api.getWorkflowDefinitionSource({ lookup: { kind: "run", runId: "run_missing" } }),
    ).toThrow(/run run_missing not found/);
    expect(() =>
      api.getWorkflowDefinitionSource({
        lookup: { kind: "definition", definitionHash: "wf_sha256_missing" },
      }),
    ).toThrow(/workflow definition wf_sha256_missing not found/);
  });

  test("schedule read projection joins definitions, run status, parse errors, and opt-in source", () => {
    const store = JournalStore.memory();
    const api = keel(store);
    putDisplayableWorkflowDefinition(
      store,
      "wf_sha256_schedule_available",
      "export default async () => 1;\n",
      100,
    );
    putDisplayableWorkflowDefinition(
      store,
      "wf_sha256_schedule_missing",
      "export default async () => 2;\n",
      100,
    );
    store.insertRun({
      runId: "run_last",
      workflowName: "displayable",
      definitionVersion: "wf_sha256_schedule_available",
      workflowRef: null,
      runTarget: process.cwd(),
      status: "failed",
      parentRunId: null,
      tenantId: null,
      inputRef: "null",
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      createdAtMs: 1,
      finishedAtMs: 2,
    });
    store.putSchedule({
      name: "available",
      workflowRef: "wf_sha256_schedule_available",
      inputJson: '{"n":1}',
      scheduleTarget: process.cwd(),
      intervalMs: 60_000,
      nextFireMs: 200,
    });
    store.advanceSchedule("available", 300, "run_last");
    store.putSchedule({
      name: "missing",
      workflowRef: "wf_sha256_schedule_missing",
      inputJson: null,
      scheduleTarget: null,
      intervalMs: 120_000,
      nextFireMs: 400,
    });
    store.disableScheduleWithError("missing", "{not-json", 500);
    store.db
      .query("DELETE FROM workflow_definitions WHERE hash = ?")
      .run("wf_sha256_schedule_missing");

    expect(api.listSchedules().map((schedule) => schedule.name)).toEqual(["available", "missing"]);
    expect(api.listSchedules({ includeDisabled: false }).map((schedule) => schedule.name)).toEqual([
      "available",
    ]);
    expect(api.listSchedules()[0]).toMatchObject({
      name: "available",
      definitionState: "available",
      workflowName: "displayable",
      workflowKind: "source",
      lastRunId: "run_last",
      lastRunStatus: "failed",
      lastError: { kind: "none" },
    });
    expect(api.listSchedules()[1]).toMatchObject({
      name: "missing",
      definitionState: "missing",
      workflowName: null,
      workflowKind: null,
      lastError: { kind: "parse-error", raw: "{not-json" },
    });

    const withoutSource = api.getSchedule({ name: "available" });
    expect(withoutSource).toMatchObject({ input: { n: 1 }, inputJson: '{"n":1}' });
    expect(withoutSource && "source" in withoutSource).toBe(false);
    expect(api.getSchedule({ name: "available", includeSource: true })?.source).toMatchObject({
      kind: "workflow-definition-source",
      definitionHash: "wf_sha256_schedule_available",
      files: [{ path: "entry.ts", code: "export default async () => 1;\n", entry: true }],
    });
    expect(api.getSchedule({ name: "missing", includeSource: true })?.source).toBeNull();
    expect(api.getSchedule({ name: "absent" })).toBeNull();
  });

  test("definition source display remains journal-backed across cache deletion and GC", async () => {
    const store = JournalStore.memory();
    const api = keel(store);
    const retainedHash = `wf_sha256_${"1".repeat(64)}`;
    const prunedHash = `wf_sha256_${"2".repeat(64)}`;
    const cacheHash = `wf_sha256_${"3".repeat(64)}`;
    const cacheRoot = mkdtempSync(join(tmpdir(), "keel-source-cache-delete-"));
    try {
      putDisplayableWorkflowDefinition(store, cacheHash, "export default async () => 9;\n", 1);
      materializeWorkflowDefinition(store, cacheHash, cacheRoot);
      rmSync(join(cacheRoot, cacheHash), { recursive: true, force: true });
      expect(
        api.getWorkflowDefinitionSource({
          lookup: { kind: "definition", definitionHash: cacheHash },
        }).files,
      ).toEqual([{ path: "entry.ts", code: "export default async () => 9;\n", entry: true }]);

      putDisplayableWorkflowDefinition(store, retainedHash, "export default async () => 10;\n", 1);
      putDisplayableWorkflowDefinition(store, prunedHash, "export default async () => 11;\n", 1);
      store.insertRun({
        runId: "run_retains_definition",
        workflowName: "retained",
        definitionVersion: retainedHash,
        workflowRef: null,
        runTarget: process.cwd(),
        status: "finished",
        parentRunId: null,
        tenantId: null,
        inputRef: null,
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 1,
        finishedAtMs: 1,
      });

      const gc = await api.gcDefinitions({ ttlMs: 0 });
      expect(gc.workflowDefinitionsRemoved).toBe(2);
      expect(() =>
        api.getWorkflowDefinitionSource({
          lookup: { kind: "definition", definitionHash: prunedHash },
        }),
      ).toThrow(`workflow definition ${prunedHash} not found`);
      expect(
        api.getWorkflowDefinitionSource({
          lookup: { kind: "run", runId: "run_retains_definition" },
        }).files,
      ).toEqual([{ path: "entry.ts", code: "export default async () => 10;\n", entry: true }]);
      expect(
        api.getWorkflowDefinitionSource({
          lookup: { kind: "definition", definitionHash: retainedHash },
        }).files,
      ).toEqual([{ path: "entry.ts", code: "export default async () => 10;\n", entry: true }]);
    } finally {
      store.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe("settings snapshots", () => {
  test("ctx.agent retry uses the original run settings snapshot", async () => {
    const store = JournalStore.memory();
    store.putDaemonSettingRow({
      key: "agent.defaultTimeoutMs",
      valueJson: "1234",
      nowMs: 1,
    });
    const provider = new FailsOnceRecordingProvider();
    let id = 0;
    const agents = new AgentProviderRegistry().register(provider);
    const kernel = new RealmKernel(store, {
      idgen: () => `run_settings_agent_${id++}`,
      clock: () => 1,
      rng: () => 0.5,
      agents,
    });
    const api = new TestInProcessKeel(kernel, store, new EventHub(), { agents });
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          return await ctx.agent({ key: "review", provider: "recording", prompt: "review" });
        }
      `,
      name: "settings-agent",
    };

    const launched = await api.launchRun({ ...workflow, input: null });
    await expect(api.waitForRun(launched.runId)).resolves.toMatchObject({ status: "failed" });
    expect(provider.calls.map((call) => call.timeoutMs)).toEqual([1234]);

    store.putDaemonSettingRow({
      key: "agent.defaultTimeoutMs",
      valueJson: "9999",
      nowMs: 2,
    });
    await api.retryRun(launched.runId);
    await expect(api.waitForRun(launched.runId)).resolves.toMatchObject({
      status: "finished",
      output: "ok",
    });
    expect(provider.calls.map((call) => call.timeoutMs)).toEqual([1234, 1234]);
  });
});

describe("RPC contract drives a workflow end-to-end", () => {
  test("in-process launchRun rejects missing or blank targets", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, { idgen: () => "run_missing_target" });
    const api = new InProcessKeel(kernel, store);

    await expect(api.launchRun({ ...chainUrl, input: null, name: "missing" })).rejects.toThrow(
      /launchRun requires target/,
    );
    await expect(
      api.launchRun({ ...chainUrl, input: null, name: "blank", target: "   " }),
    ).rejects.toThrow(/non-empty target/);
  });

  test(
    "launchRun → waitForRun → getRun returns the canonical projection",
    async () => {
      const store = JournalStore.memory();
      const mock = new MockProvider({
        responses: {
          "review:auth": { outputs: ['{"findings":[{"title":"a"}]}'] },
          "review:net": { outputs: ['{"findings":[{"title":"b"},{"title":"c"}]}'] },
        },
      });
      const api = keel(store, mock);

      const { runId } = await api.launchRun({
        ...reviewUrl,
        input: { domains: ["auth", "net"] },
        name: "review",
      });
      const outcome = await api.waitForRun(runId);
      expect(outcome.status).toBe("finished");

      const projection = api.getRun(runId);
      expect(projection?.status).toBe("finished");
      expect(projection?.workflowName).toBe("review");
      expect(projection?.phase).toBe("Review");
      expect(projection?.stats).toEqual({ steps: 1, agents: 2, checkpointCount: 0, artifacts: 0 });
      // nodes: one pure (count) + two effectful (review:auth, review:net)
      expect(projection?.nodes.map((n) => n.stableKey)).toEqual([
        "count",
        "review:auth",
        "review:net",
      ]);
      expect(projection?.nodes.every((n) => n.status === "completed")).toBe(true);

      const report = api.getRunReport(runId);
      expect(report?.workflowName).toBe("review");
      expect(report?.status).toBe("finished");
      expect(report?.stats).toEqual({ steps: 1, agents: 2, checkpointCount: 0, artifacts: 0 });
      expect(report?.nodes.map((n) => [n.stableKey, n.result])).toEqual([
        ["count", 3],
        ["review:auth", { findings: [{ title: "a" }] }],
        ["review:net", { findings: [{ title: "b" }, { title: "c" }] }],
      ]);
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test(
    "listRuns returns a bare array with run summary metadata in newest-first order",
    async () => {
      const store = JournalStore.memory();
      let id = 0;
      let nowMs = 1_000;
      const kernel = new RealmKernel(store, {
        idgen: () => `run_${id++}`,
        clock: () => nowMs,
        rng: () => 0.5,
      });
      const api = new TestInProcessKeel(kernel, store);

      await api.launchRun({ ...chainUrl, input: { n: 3 }, name: "c1" });
      await api.waitForRun("run_0");
      nowMs = 2_000;
      await api.launchRun({ ...chainUrl, input: { n: 2 }, name: "c2" });
      await api.waitForRun("run_1");
      nowMs = 3_000;
      api.forkRun("run_0", { newRunId: "run_0_fork" });

      const runs = api.listRuns();
      expect(Array.isArray(runs)).toBe(true);
      expect(runs).toEqual([
        {
          runId: "run_0_fork",
          workflowName: "c1",
          status: "running",
          runTarget: process.cwd(),
          createdAtMs: 3_000,
          finishedAtMs: null,
          parentRunId: "run_0",
        },
        {
          runId: "run_1",
          workflowName: "c2",
          status: "finished",
          runTarget: process.cwd(),
          createdAtMs: 2_000,
          finishedAtMs: 2_000,
          parentRunId: null,
        },
        {
          runId: "run_0",
          workflowName: "c1",
          status: "finished",
          runTarget: process.cwd(),
          createdAtMs: 1_000,
          finishedAtMs: 1_000,
          parentRunId: null,
        },
      ]);

      expect(api.listRunsPage({ limit: 2 })).toEqual({
        runs: runs.slice(0, 2),
        total: 3,
      });
      expect(() => api.listRunsPage({ limit: 0 })).toThrow(
        /listRunsPage limit must be a positive integer/,
      );
      expect(() => api.listRunsPage({ limit: MAX_RUN_SUMMARY_PAGE_LIMIT + 1 })).toThrow(
        `listRunsPage limit must be <= ${MAX_RUN_SUMMARY_PAGE_LIMIT}`,
      );
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );
});

describe("projection is golden-locked", () => {
  test(
    "a chain run produces the exact expected projection",
    async () => {
      const store = JournalStore.memory();
      const api = keel(store);
      await api.launchRun({ ...chainUrl, input: { n: 3 }, name: "chain" });
      await api.waitForRun("run_0");
      const p = api.getRun("run_0");
      const definitionVersion = p?.definitionVersion ?? "";
      expect(definitionVersion.startsWith("wf_sha256_")).toBe(true);
      expect(p).toEqual({
        runId: "run_0",
        workflowName: "chain",
        status: "finished",
        definitionVersion,
        runTarget: process.cwd(),
        parentRunId: null,
        createdAtMs: 1,
        finishedAtMs: 1,
        phase: null,
        error: null,
        nodes: [
          {
            stableKey: "s0",
            effectType: "pure",
            status: "completed",
            attempt: 1,
            startedAtMs: 1,
            dependsOn: [],
            artifactBacked: false,
            checkpoint: null,
          },
          {
            stableKey: "s1",
            effectType: "pure",
            status: "completed",
            attempt: 1,
            startedAtMs: 1,
            dependsOn: [],
            artifactBacked: false,
            checkpoint: null,
          },
          {
            stableKey: "s2",
            effectType: "pure",
            status: "completed",
            attempt: 1,
            startedAtMs: 1,
            dependsOn: [],
            artifactBacked: false,
            checkpoint: null,
          },
        ],
        stats: { steps: 3, agents: 0, checkpointCount: 0, artifacts: 0 },
      });
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );
});

describe("event subscription", () => {
  test(
    "subscribeEvents streams a run's events",
    async () => {
      const store = JournalStore.memory();
      const api = keel(store);
      const seen: { type: string; payload: unknown }[] = [];
      const { runId } = await api.launchRun({
        ...chainUrl,
        input: { n: 2 },
        name: "chain",
      });
      const attachLaunch = await api.launchRun({ ...onceUrl, input: null, name: "attach-cursor" });
      expect(attachLaunch.attachCursor).toEqual({
        kind: "after-seq",
        runId: attachLaunch.runId,
        seq: 0,
      });
      await api.waitForRun(attachLaunch.runId);
      const unsub = api.subscribeEvents({ runId: runId, cursor: { kind: "beginning" } }, (e) =>
        seen.push({ type: e.type, payload: e.payload }),
      );
      await api.waitForRun(runId);
      // give the poller a tick to drain
      await new Promise((r) => setTimeout(r, 60));
      unsub();
      expect(seen.map((e) => e.type)).toContain("run.started");
      expect(seen.map((e) => e.type)).toContain("run.finished");
      expect(seen.filter((e) => e.type === "step.completed").length).toBe(2);
      expect(seen.find((e) => e.type === "run.finished")?.payload).toEqual({ output: 2 });
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test(
    "forkRun attachCursor starts before forked run history",
    async () => {
      const store = JournalStore.memory();
      const api = keel(store);
      const { runId } = await api.launchRun({ ...chainUrl, input: { n: 1 }, name: "source" });
      await api.waitForRun(runId);

      const originalEventHighWater = store.eventHighWater.bind(store);
      store.eventHighWater = ((id: string) =>
        id === "run_forked" ? 12 : originalEventHighWater(id)) as JournalStore["eventHighWater"];
      const forked = api.forkRun(runId, { newRunId: "run_forked" });
      store.eventHighWater = originalEventHighWater as JournalStore["eventHighWater"];
      expect(forked.attachCursor).toEqual({ kind: "after-seq", runId: "run_forked", seq: 0 });

      const seen: string[] = [];
      const unsub = api.subscribeEvents({ runId: forked.runId, cursor: forked.attachCursor }, (e) =>
        seen.push(e.type),
      );
      unsub();

      expect(seen).toEqual(["run.forked"]);
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test(
    "agent deltas are live frames and finalized messages are durable rows",
    async () => {
      const store = JournalStore.memory();
      const provider = new ControlledStreamingProvider([
        { type: "text", data: '{"value":' },
        { type: "text", data: "1}" },
        {
          type: "tool_call",
          toolCallId: "call-1",
          data: { name: "read", args: { file: "a.ts" } },
        },
      ]);
      const api = streamingKeel(store, provider);
      const frames: { kind: string; type: string; payload: unknown }[] = [];

      const { runId } = await api.launchRun({ ...onceUrl, input: null, name: "once" });
      const unsub = api.subscribeEvents({ runId: runId, cursor: { kind: "beginning" } }, (e) =>
        frames.push({ kind: e.kind, type: e.type, payload: e.payload }),
      );
      provider.release();
      await api.waitForRun(runId);
      unsub();

      expect(frames).toContainEqual({
        kind: "ephemeral",
        type: "agent.event",
        payload: { key: "ask", event: { type: "text", data: '{"value":' } },
      });
      expect(frames).toContainEqual({
        kind: "durable",
        type: "agent.message",
        payload: { key: "ask", attempt: 1, text: '{"value":1}' },
      });
      expect(frames).toContainEqual({
        kind: "durable",
        type: "agent.tool_call",
        payload: {
          key: "ask",
          attempt: 1,
          toolCallId: "call-1",
          data: { name: "read", args: { file: "a.ts" } },
        },
      });
      expect(frames).not.toContainEqual({
        kind: "ephemeral",
        type: "agent.event",
        payload: {
          key: "ask",
          event: {
            type: "tool_call",
            toolCallId: "call-1",
            data: { name: "read", args: { file: "a.ts" } },
          },
        },
      });

      const durable = store.listEvents(runId).map((e) => ({
        type: e.type,
        payload: JSON.parse(e.payloadJson),
      }));
      expect(durable.some((e) => e.type === "agent.event")).toBe(false);
      expect(durable).toContainEqual({
        type: "agent.message",
        payload: { key: "ask", attempt: 1, text: '{"value":1}' },
      });
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test(
    "durable tool append failures fail the agent turn without ephemeral replacement",
    async () => {
      const store = JournalStore.memory();
      const appendEvent = store.appendEvent.bind(store);
      store.appendEvent = ((runId, type, payload, atMs) => {
        if (type === "agent.tool_call") throw new Error("append failed");
        return appendEvent(runId, type, payload, atMs);
      }) as JournalStore["appendEvent"];
      const provider = new ControlledStreamingProvider([
        { type: "tool_call", data: { name: "read", args: { file: "a.ts" } } },
      ]);
      const api = streamingKeel(store, provider);
      const frames: { kind: string; type: string; payload: unknown }[] = [];

      const { runId } = await api.launchRun({ ...onceUrl, input: null, name: "once" });
      const unsub = api.subscribeEvents({ runId: runId, cursor: { kind: "beginning" } }, (e) =>
        frames.push({ kind: e.kind, type: e.type, payload: e.payload }),
      );
      const outcome = await api.waitForRun(runId);
      unsub();

      expect(outcome.status).toBe("failed");
      expect(store.listEvents(runId).some((e) => e.type === "agent.tool_call")).toBe(false);
      expect(frames).not.toContainEqual({
        kind: "ephemeral",
        type: "agent.event",
        payload: {
          key: "ask",
          event: { type: "tool_call", data: { name: "read", args: { file: "a.ts" } } },
        },
      });
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test(
    "finalized tool rows are durable and backfilled while the turn is pending",
    async () => {
      const store = JournalStore.memory();
      const provider = new ControlledStreamingProvider(
        [
          {
            type: "tool_call",
            toolCallId: "call-pending",
            data: { name: "read", args: { file: "pending.ts" } },
          },
          {
            type: "tool_result",
            toolCallId: "call-pending",
            data: { output: "ok" },
          },
        ],
        '{"value":8}',
      );
      const api = streamingKeel(store, provider);
      const frames: { kind: string; type: string; payload: unknown }[] = [];

      const { runId } = await api.launchRun({ ...onceUrl, input: null, name: "once" });
      const unsub = api.subscribeEvents({ runId: runId, cursor: { kind: "beginning" } }, (e) =>
        frames.push({ kind: e.kind, type: e.type, payload: e.payload }),
      );
      await provider.waitForFirstEvent();

      const pendingToolRows = store.listEvents(runId).filter((e) => e.type === "agent.tool_call");
      expect(store.getJournalRow(runId, "ask", 1)?.status).toBe("pending");
      expect(pendingToolRows.map((e) => JSON.parse(e.payloadJson))).toEqual([
        {
          key: "ask",
          attempt: 1,
          toolCallId: "call-pending",
          data: { name: "read", args: { file: "pending.ts" } },
        },
      ]);
      expect(frames).toContainEqual({
        kind: "durable",
        type: "agent.tool_call",
        payload: {
          key: "ask",
          attempt: 1,
          toolCallId: "call-pending",
          data: { name: "read", args: { file: "pending.ts" } },
        },
      });

      const backfilled: { kind: string; type: string; payload: unknown }[] = [];
      const lateUnsub = api.subscribeEvents({ runId: runId, cursor: { kind: "beginning" } }, (e) =>
        backfilled.push({ kind: e.kind, type: e.type, payload: e.payload }),
      );
      lateUnsub();
      expect(backfilled).toContainEqual({
        kind: "durable",
        type: "agent.tool_call",
        payload: {
          key: "ask",
          attempt: 1,
          toolCallId: "call-pending",
          data: { name: "read", args: { file: "pending.ts" } },
        },
      });

      provider.release();
      await api.waitForRun(runId);
      unsub();
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test("subscribeEvents has no gap between durable backfill and live tail", () => {
    const store = JournalStore.memory();
    const hub = new EventHub();
    store.onEventAppended((event) => hub.publishDurable(event));
    store.appendEvent("r", "one", {}, 1);
    store.appendEvent("r", "two", {}, 2);

    const seen: string[] = [];
    const sub = hub.subscribe(store, { runId: "r", cursor: { kind: "beginning" } }, (event) => {
      seen.push(event.type);
      if (event.kind === "durable" && event.type === "one") {
        store.appendEvent("r", "three", {}, 3);
      }
    });
    sub.unsubscribe();

    expect(seen).toEqual(["one", "two", "three"]);
  });

  test("event cursor validation rejects malformed inputs", () => {
    expect(() => normalizeEventCursorInput(0)).toThrow("event cursor must be an object");
    expect(() => normalizeEventCursorInput({ kind: "after-seq", seq: -1 })).toThrow(
      "cursor seq must be a non-negative integer",
    );
    expect(() => normalizeEventCursorInput({ kind: "after-seq", seq: 1.5 })).toThrow(
      "cursor seq must be a non-negative integer",
    );
    expect(() =>
      normalizeEventCursorInput({ kind: "tail", count: Number.POSITIVE_INFINITY }),
    ).toThrow("tail count must be a non-negative integer");
    expect(() => normalizeEventCursorInput({ kind: "sideways" })).toThrow(
      "unknown event cursor kind sideways",
    );
  });

  test("event cursors select beginning, after-seq, tail, and now backfill windows", () => {
    const store = JournalStore.memory();
    const hub = new EventHub();
    store.onEventAppended((event) => hub.publishDurable(event));
    store.appendEvent("r", "one", {}, 1);
    store.appendEvent("r", "two", {}, 2);
    store.appendEvent("r", "three", {}, 3);

    const collect = (cursor: Parameters<EventHub["subscribe"]>[1]["cursor"]) => {
      const seen: string[] = [];
      const sub = hub.subscribe(store, { runId: "r", cursor }, (event) => seen.push(event.type));
      sub.unsubscribe();
      return { seen, cursor: sub.cursor };
    };

    expect(collect({ kind: "beginning" })).toEqual({
      seen: ["one", "two", "three"],
      cursor: { kind: "after-seq", runId: "r", seq: 3 },
    });
    expect(collect({ kind: "after-seq", seq: 1 }).seen).toEqual(["two", "three"]);
    expect(collect({ kind: "tail", count: 2 }).seen).toEqual(["two", "three"]);
    expect(collect({ kind: "tail", count: 0 })).toEqual({
      seen: [],
      cursor: { kind: "after-seq", runId: "r", seq: 3 },
    });
    expect(collect({ kind: "now" })).toEqual({
      seen: [],
      cursor: { kind: "after-seq", runId: "r", seq: 3 },
    });
  });

  test("now subscriptions cover setup-window durable events exactly once", () => {
    const store = JournalStore.memory();
    const hub = new EventHub();
    store.onEventAppended((event) => hub.publishDurable(event));
    store.appendEvent("r", "before", {}, 1);

    const originalListEvents = store.listEvents.bind(store);
    let injected = false;
    store.listEvents = ((runId: string, afterSeq?: number) => {
      if (!injected) {
        injected = true;
        store.appendEvent("r", "during-setup", {}, 2);
      }
      return originalListEvents(runId, afterSeq);
    }) as JournalStore["listEvents"];

    const seen: string[] = [];
    const sub = hub.subscribe(store, { runId: "r", cursor: { kind: "now" } }, (event) =>
      seen.push(event.type),
    );
    sub.unsubscribe();

    expect(seen).toEqual(["during-setup"]);
    expect(sub.cursor).toEqual({ kind: "after-seq", runId: "r", seq: 2 });
  });

  test("reconnecting from an empty-backfill cursor does not rewind skipped history", () => {
    const store = JournalStore.memory();
    const hub = new EventHub();
    store.onEventAppended((event) => hub.publishDurable(event));
    store.appendEvent("r", "one", {}, 1);
    store.appendEvent("r", "two", {}, 2);

    const firstSeen: string[] = [];
    const first = hub.subscribe(store, { runId: "r", cursor: { kind: "now" } }, (event) =>
      firstSeen.push(event.type),
    );
    first.unsubscribe();

    const secondSeen: string[] = [];
    const second = hub.subscribe(
      store,
      { runId: "r", cursor: { kind: "after-seq", seq: first.cursor.seq } },
      (event) => secondSeen.push(event.type),
    );
    store.appendEvent("r", "three", {}, 3);
    second.unsubscribe();

    expect(firstSeen).toEqual([]);
    expect(secondSeen).toEqual(["three"]);
  });

  test("caught-up and closed control frames carry resolved durable cursors", () => {
    const store = JournalStore.memory();
    const hub = new EventHub();
    seedReportRun(store, "closed");
    store.appendEvent("closed", "run.started", {}, 1);
    store.appendEvent("closed", "run.finished", {}, 2);

    const controls: string[] = [];
    const sub = hub.subscribe(
      store,
      { runId: "closed", cursor: { kind: "now" } },
      () => {
        throw new Error("now cursor should skip existing durable events");
      },
      (frame) => {
        if (frame.type === "caught-up") controls.push(`caught-up:${frame.cursor.seq}`);
        if (frame.type === "closed") controls.push(`closed:${frame.cursor.seq}:${frame.status}`);
      },
    );
    sub.unsubscribe();

    expect(controls).toEqual(["caught-up:2", "closed:2:finished"]);
  });

  test("closed status is recomputed after backfill restart events", () => {
    const store = JournalStore.memory();
    const hub = new EventHub();
    store.onEventAppended((event) => hub.publishDurable(event));
    seedReportRun(store, "restart");
    store.updateRun("restart", { status: "waiting-human", finishedAtMs: null });
    store.appendEvent("restart", "run.parked", { kind: "human" }, 1);

    const events: string[] = [];
    const controls: string[] = [];
    const sub = hub.subscribe(
      store,
      { runId: "restart", cursor: { kind: "beginning" } },
      (event) => {
        events.push(event.type);
        if (event.type === "run.parked") {
          store.updateRun("restart", { status: "running", finishedAtMs: null });
          store.appendEvent("restart", "run.resumed", {}, 2);
        }
      },
      (frame) => controls.push(frame.type),
    );
    sub.unsubscribe();

    expect(events).toEqual(["run.parked", "run.resumed"]);
    expect(controls).toEqual(["caught-up"]);
    expect(sub.closedStatus).toBeNull();
    expect(sub.cursor).toEqual({ kind: "after-seq", runId: "restart", seq: 2 });
  });

  test(
    "default in-process construction wires live agent frames",
    async () => {
      const store = JournalStore.memory();
      const provider = new ControlledStreamingProvider([{ type: "text", data: '{"value":4}' }]);
      const kernel = new RealmKernel(store, {
        idgen: () => "run_default_stream",
        clock: () => 1,
        rng: () => 0.5,
        agents: new AgentProviderRegistry().register(provider),
      });
      const api = new TestInProcessKeel(kernel, store);
      const frames: { kind: string; type: string; payload: unknown }[] = [];

      const { runId } = await api.launchRun({ ...onceUrl, input: null, name: "once" });
      const unsub = api.subscribeEvents({ runId: runId, cursor: { kind: "beginning" } }, (e) =>
        frames.push({ kind: e.kind, type: e.type, payload: e.payload }),
      );
      provider.release();
      await api.waitForRun(runId);
      unsub();

      expect(frames).toContainEqual({
        kind: "ephemeral",
        type: "agent.event",
        payload: { key: "ask", event: { type: "text", data: '{"value":4}' } },
      });
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test(
    "durable transcript preserves immediate tool rows before final text",
    async () => {
      const store = JournalStore.memory();
      const provider = new ControlledStreamingProvider(
        [
          { type: "text", data: "draft prose " },
          {
            type: "tool_call",
            toolCallId: "call-2",
            data: { name: "read", args: { file: "a.ts" } },
          },
          { type: "tool_result", toolCallId: "call-2", data: { output: "ok" } },
          { type: "text", data: "ignored live prose" },
        ],
        '{"value":3}',
      );
      const api = streamingKeel(store, provider);

      const { runId } = await api.launchRun({ ...onceUrl, input: null, name: "once" });
      provider.release();
      await api.waitForRun(runId);

      const agentEvents = store
        .listEvents(runId)
        .filter((e) => e.type.startsWith("agent."))
        .map((e) => ({ type: e.type, payload: JSON.parse(e.payloadJson) }));
      expect(agentEvents.map((e) => e.type)).toEqual([
        "agent.tool_call",
        "agent.tool_result",
        "agent.message",
      ]);
      expect(agentEvents).toContainEqual({
        type: "agent.message",
        payload: { key: "ask", attempt: 1, text: '{"value":3}' },
      });
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test(
    "oversized durable transcript payloads are omitted with byte lengths",
    async () => {
      const store = JournalStore.memory();
      const marker = "OVERSIZED_TRANSCRIPT_CONTENT";
      const oversized = marker.repeat(
        Math.ceil((RUN_FINISHED_INLINE_OUTPUT_BYTES + 512) / marker.length),
      );
      const callData = { name: "read", args: { content: oversized } };
      const resultData = { output: oversized };
      const finalText = `{"value":9}\n${oversized}`;
      const provider = new ControlledStreamingProvider(
        [
          { type: "tool_call", toolCallId: "large-call", data: callData },
          { type: "tool_result", toolCallId: "large-call", data: resultData },
        ],
        finalText,
      );
      const api = streamingKeel(store, provider);

      const { runId } = await api.launchRun({ ...onceUrl, input: null, name: "once" });
      provider.release();
      await api.waitForRun(runId);

      const events = store
        .listEvents(runId)
        .filter((e) => e.type.startsWith("agent."))
        .map((e) => ({ type: e.type, payload: JSON.parse(e.payloadJson) }));
      expect(events).toEqual([
        {
          type: "agent.tool_call",
          payload: {
            key: "ask",
            attempt: 1,
            toolCallId: "large-call",
            omitted: true,
            byteLength: Buffer.byteLength(JSON.stringify(callData), "utf8"),
          },
        },
        {
          type: "agent.tool_result",
          payload: {
            key: "ask",
            attempt: 1,
            toolCallId: "large-call",
            omitted: true,
            byteLength: Buffer.byteLength(JSON.stringify(resultData), "utf8"),
          },
        },
        {
          type: "agent.message",
          payload: {
            key: "ask",
            attempt: 1,
            omitted: true,
            byteLength: Buffer.byteLength(JSON.stringify(finalText), "utf8"),
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(marker);
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test(
    "durable transcript falls back to final text after empty text deltas",
    async () => {
      const store = JournalStore.memory();
      const provider = new ControlledStreamingProvider([{ type: "text", data: "" }], '{"value":5}');
      const api = streamingKeel(store, provider);

      const { runId } = await api.launchRun({ ...onceUrl, input: null, name: "once" });
      provider.release();
      await api.waitForRun(runId);

      expect(
        store
          .listEvents(runId)
          .filter((e) => e.type === "agent.message")
          .map((e) => JSON.parse(e.payloadJson)),
      ).toEqual([{ key: "ask", attempt: 1, text: '{"value":5}' }]);
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test(
    "late subscribers see only tail live deltas plus the full finalized message",
    async () => {
      const store = JournalStore.memory();
      const provider = new ControlledStreamingProvider([
        { type: "text", data: '{"value":' },
        { type: "text", data: "2}" },
      ]);
      const api = streamingKeel(store, provider);

      const { runId } = await api.launchRun({ ...onceUrl, input: null, name: "once" });
      await provider.waitForFirstEvent();

      const frames: { kind: string; type: string; payload: unknown }[] = [];
      const unsub = api.subscribeEvents({ runId: runId, cursor: { kind: "beginning" } }, (e) =>
        frames.push({ kind: e.kind, type: e.type, payload: e.payload }),
      );
      provider.release();
      await api.waitForRun(runId);
      unsub();

      expect(frames).not.toContainEqual({
        kind: "ephemeral",
        type: "agent.event",
        payload: { key: "ask", event: { type: "text", data: '{"value":' } },
      });
      expect(frames).toContainEqual({
        kind: "ephemeral",
        type: "agent.event",
        payload: { key: "ask", event: { type: "text", data: "2}" } },
      });
      expect(frames).toContainEqual({
        kind: "durable",
        type: "agent.message",
        payload: { key: "ask", attempt: 1, text: '{"value":2}' },
      });
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );
});

describe("workspace lifecycle operations", () => {
  test("clone source classification accepts user-less scp remotes", () => {
    expect(classifyCloneSource("gitserver:org/repo.git")).toMatchObject({
      repo: "gitserver:org/repo.git",
      sourceKind: "remote-git",
      sourceMergeEligible: false,
    });
    expect(classifyCloneSource("host:path")).toMatchObject({
      repo: "host:path",
      sourceKind: "remote-git",
      sourceMergeEligible: false,
    });
    expect(classifyCloneSource("gitserver:/srv/repo.git")).toMatchObject({
      repo: "gitserver:/srv/repo.git",
      sourceKind: "remote-git",
      sourceMergeEligible: false,
    });
    expect(() => classifyCloneSource("subdir/repo")).toThrow(/absolute path or remote git URL/);
    expect(() => classifyCloneSource("C:/repo")).toThrow(/absolute path or remote git URL/);
    expect(() => classifyCloneSource("C:\\repo")).toThrow(/absolute path or remote git URL/);
  });

  test("copy workspace diff and merge apply changes back to unchanged source", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-rpc-copy-"));
    const store = JournalStore.memory();
    try {
      const source = join(dir, "source");
      const workspace = join(dir, "store", "copy");
      const baseline = join(dir, "store", "copy-baseline");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "file.txt"), "base\n");
      mkdirSync(join(source, ".git"), { recursive: true });
      writeFileSync(join(source, ".git", "config"), "ignored\n");
      createRetainedCopy(source, workspace, baseline);
      writeFileSync(join(workspace, "file.txt"), "changed\n");
      writeFileSync(join(workspace, "added.txt"), "added\n");
      store.insertRun({
        runId: "r-copy",
        workflowName: "wf",
        definitionVersion: "wf_sha256_fixture",
        status: "finished",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 1,
        finishedAtMs: 2,
        runTarget: source,
      });
      store.insertAgentWorkspace({
        runId: "r-copy",
        workspaceId: "copy",
        mode: "copy",
        ownerKind: "workflow",
        key: "copy",
        lastAttempt: null,
        retentionPolicy: "retain",
        workspacePath: workspace,
        sourceKind: "local-copy",
        sourcePath: source,
        sourceUri: null,
        sourceBare: null,
        sourceMergeEligible: true,
        suppliedPath: source,
        sourceRef: null,
        resolvedRef: null,
        checkoutBranch: null,
        baseCommit: null,
        copyBaselinePath: baseline,
        creationErrorJson: null,
        workspaceIdentityJson: "{}",
        workspaceIdentityHash: "copy",
        owned: true,
        status: "pending_review",
        failureSeen: false,
        lastTurnKey: null,
        lastTurnAttempt: null,
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        lastDiffEventSeq: null,
        lastErrorEventSeq: null,
        cleanupErrorJson: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        mergedAtMs: null,
        discardedAtMs: null,
        removedAtMs: null,
      });
      const api = keel(store);
      const diff = api.getRunWorkspaceDiff("r-copy", "copy");
      expect(diff.diffKind).toBe("recursive-copy");
      expect(diff.modified).toContain("file.txt");
      expect(diff.added).toContain("added.txt");
      expect(api.mergeRunWorkspace("r-copy", "copy").status).toBe("merged");
      expect(readFileSync(join(source, "file.txt"), "utf8")).toBe("changed\n");
      expect(readFileSync(join(source, "added.txt"), "utf8")).toBe("added\n");
      expect(existsSync(join(source, ".git", "config"))).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copy merge rejects deleted directory when source subtree changed since baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-rpc-copy-conflict-"));
    const store = JournalStore.memory();
    try {
      const source = join(dir, "source");
      const workspace = join(dir, "store", "copy");
      const baseline = join(dir, "store", "copy-baseline");
      mkdirSync(join(source, "subdir"), { recursive: true });
      writeFileSync(join(source, "subdir", "base.txt"), "base\n");
      createRetainedCopy(source, workspace, baseline);
      rmSync(join(workspace, "subdir"), { recursive: true, force: true });
      writeFileSync(join(source, "subdir", "concurrent.txt"), "keep me\n");
      store.insertRun({
        runId: "r-copy-conflict",
        workflowName: "wf",
        definitionVersion: "wf_sha256_fixture",
        status: "finished",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 1,
        finishedAtMs: 2,
        runTarget: source,
      });
      store.insertAgentWorkspace({
        runId: "r-copy-conflict",
        workspaceId: "copy",
        mode: "copy",
        ownerKind: "workflow",
        key: "copy",
        lastAttempt: null,
        retentionPolicy: "retain",
        workspacePath: workspace,
        sourceKind: "local-copy",
        sourcePath: source,
        sourceUri: null,
        sourceBare: null,
        sourceMergeEligible: true,
        suppliedPath: source,
        sourceRef: null,
        resolvedRef: null,
        checkoutBranch: null,
        baseCommit: null,
        copyBaselinePath: baseline,
        creationErrorJson: null,
        workspaceIdentityJson: "{}",
        workspaceIdentityHash: "copy-conflict",
        owned: true,
        status: "pending_review",
        failureSeen: false,
        lastTurnKey: null,
        lastTurnAttempt: null,
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        lastDiffEventSeq: null,
        lastErrorEventSeq: null,
        cleanupErrorJson: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        mergedAtMs: null,
        discardedAtMs: null,
        removedAtMs: null,
      });
      const api = keel(store);
      expect(() => api.mergeRunWorkspace("r-copy-conflict", "copy")).toThrow(/source changed/);
      expect(readFileSync(join(source, "subdir", "concurrent.txt"), "utf8")).toBe("keep me\n");
      expect(store.getAgentWorkspace("r-copy-conflict", "copy")?.status).toBe("pending_review");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copy merge ignores nested git metadata while validating deleted directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-rpc-copy-nested-git-"));
    const store = JournalStore.memory();
    try {
      const source = join(dir, "source");
      const workspace = join(dir, "store", "copy");
      const baseline = join(dir, "store", "copy-baseline");
      mkdirSync(join(source, "subdir", "vendor", ".git"), { recursive: true });
      writeFileSync(join(source, "subdir", "base.txt"), "base\n");
      writeFileSync(join(source, "subdir", "vendor", ".git", "config"), "ignored\n");
      createRetainedCopy(source, workspace, baseline);
      rmSync(join(workspace, "subdir"), { recursive: true, force: true });
      store.insertRun({
        runId: "r-copy-nested-git",
        workflowName: "wf",
        definitionVersion: "wf_sha256_fixture",
        status: "finished",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 1,
        finishedAtMs: 2,
        runTarget: source,
      });
      store.insertAgentWorkspace({
        runId: "r-copy-nested-git",
        workspaceId: "copy",
        mode: "copy",
        ownerKind: "workflow",
        key: "copy",
        lastAttempt: null,
        retentionPolicy: "retain",
        workspacePath: workspace,
        sourceKind: "local-copy",
        sourcePath: source,
        sourceUri: null,
        sourceBare: null,
        sourceMergeEligible: true,
        suppliedPath: source,
        sourceRef: null,
        resolvedRef: null,
        checkoutBranch: null,
        baseCommit: null,
        copyBaselinePath: baseline,
        creationErrorJson: null,
        workspaceIdentityJson: "{}",
        workspaceIdentityHash: "copy-nested-git",
        owned: true,
        status: "pending_review",
        failureSeen: false,
        lastTurnKey: null,
        lastTurnAttempt: null,
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        lastDiffEventSeq: null,
        lastErrorEventSeq: null,
        cleanupErrorJson: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        mergedAtMs: null,
        discardedAtMs: null,
        removedAtMs: null,
      });
      const api = keel(store);
      expect(api.mergeRunWorkspace("r-copy-nested-git", "copy").status).toBe("merged");
      expect(existsSync(join(source, "subdir"))).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("local clone merge includes committed changes after base commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-rpc-clone-"));
    const store = JournalStore.memory();
    try {
      const repo = join(dir, "repo");
      const clone = join(dir, "clone");
      mkdirSync(repo, { recursive: true });
      const baseCommit = initGitRepo(repo);
      execFileSync("git", ["clone", repo, clone]);
      writeFileSync(join(clone, "committed.txt"), "committed\n");
      execFileSync("git", ["add", "-A"], { cwd: clone });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: clone });
      execFileSync("git", ["config", "user.name", "t"], { cwd: clone });
      execFileSync("git", ["commit", "-q", "-m", "agent commit"], { cwd: clone });
      writeFileSync(join(clone, "unstaged.txt"), "unstaged\n");
      writeFileSync(join(clone, "pre-staged.txt"), "pre-staged\n");
      execFileSync("git", ["add", "pre-staged.txt"], { cwd: clone });
      store.insertRun({
        runId: "r-clone",
        workflowName: "wf",
        definitionVersion: "wf_sha256_fixture",
        status: "finished",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 1,
        finishedAtMs: 2,
        runTarget: repo,
      });
      store.insertAgentWorkspace({
        runId: "r-clone",
        workspaceId: "clone",
        mode: "clone",
        ownerKind: "workflow",
        key: "clone",
        lastAttempt: null,
        retentionPolicy: "retain",
        workspacePath: clone,
        sourceKind: "local-clone-git",
        sourcePath: repo,
        sourceUri: repo,
        sourceBare: false,
        sourceMergeEligible: true,
        suppliedPath: null,
        sourceRef: null,
        resolvedRef: "master",
        checkoutBranch: "master",
        baseCommit,
        copyBaselinePath: null,
        creationErrorJson: null,
        workspaceIdentityJson: "{}",
        workspaceIdentityHash: "clone",
        owned: true,
        status: "pending_review",
        failureSeen: false,
        lastTurnKey: null,
        lastTurnAttempt: null,
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        lastDiffEventSeq: null,
        lastErrorEventSeq: null,
        cleanupErrorJson: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        mergedAtMs: null,
        discardedAtMs: null,
        removedAtMs: null,
      });
      const api = keel(store);
      const diff = api.getRunWorkspaceDiff("r-clone", "clone");
      expect(diff.mode).toBe("clone");
      expect(diff.added).toContain("committed.txt");
      expect(diff.added).toContain("unstaged.txt");
      expect(diff.added).toContain("pre-staged.txt");
      expect(
        execFileSync("git", ["diff", "--cached", "--name-only"], {
          cwd: clone,
          encoding: "utf8",
        })
          .trim()
          .split("\n"),
      ).toEqual(["pre-staged.txt"]);
      expect(api.mergeRunWorkspace("r-clone", "clone").status).toBe("merged");
      expect(readFileSync(join(repo, "committed.txt"), "utf8")).toBe("committed\n");
      expect(readFileSync(join(repo, "unstaged.txt"), "utf8")).toBe("unstaged\n");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("worktree diff and merge include commits after base commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-rpc-worktree-"));
    const store = JournalStore.memory();
    try {
      const repo = join(dir, "repo");
      const worktree = join(dir, "worktree");
      mkdirSync(repo, { recursive: true });
      const baseCommit = initGitRepo(repo);
      createRetainedWorktree(repo, worktree, baseCommit);
      writeFileSync(join(worktree, "committed.txt"), "committed\n");
      execFileSync("git", ["add", "-A"], { cwd: worktree });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: worktree });
      execFileSync("git", ["config", "user.name", "t"], { cwd: worktree });
      execFileSync("git", ["commit", "-q", "-m", "agent commit"], { cwd: worktree });
      writeFileSync(join(worktree, "unstaged.txt"), "unstaged\n");
      store.insertRun({
        runId: "r-worktree",
        workflowName: "wf",
        definitionVersion: "wf_sha256_fixture",
        status: "finished",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 1,
        finishedAtMs: 2,
        runTarget: repo,
      });
      store.insertAgentWorkspace({
        runId: "r-worktree",
        workspaceId: "wt",
        mode: "worktree",
        ownerKind: "workflow",
        key: "wt",
        lastAttempt: null,
        retentionPolicy: "retain",
        workspacePath: worktree,
        sourceKind: "worktree-git",
        sourcePath: repo,
        sourceUri: null,
        sourceBare: null,
        sourceMergeEligible: true,
        suppliedPath: null,
        sourceRef: "HEAD",
        resolvedRef: "HEAD",
        checkoutBranch: null,
        worktreeCheckoutKind: "detached",
        worktreeBranchOwned: false,
        baseCommit,
        copyBaselinePath: null,
        creationErrorJson: null,
        workspaceIdentityJson: "{}",
        workspaceIdentityHash: "worktree",
        owned: true,
        status: "pending_review",
        failureSeen: false,
        lastTurnKey: null,
        lastTurnAttempt: null,
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        lastDiffEventSeq: null,
        lastErrorEventSeq: null,
        cleanupErrorJson: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        mergedAtMs: null,
        discardedAtMs: null,
        removedAtMs: null,
      });
      const api = keel(store);
      const diff = api.getRunWorkspaceDiff("r-worktree", "wt");
      expect(diff.mode).toBe("worktree");
      expect(diff.added).toContain("committed.txt");
      expect(diff.added).toContain("unstaged.txt");
      expect(api.mergeRunWorkspace("r-worktree", "wt").status).toBe("merged");
      expect(readFileSync(join(repo, "committed.txt"), "utf8")).toBe("committed\n");
      expect(readFileSync(join(repo, "unstaged.txt"), "utf8")).toBe("unstaged\n");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("merge, discard, and GC enforce lifecycle guards and are idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-rpc-workspace-"));
    const store = JournalStore.memory();
    try {
      const repo = join(dir, "repo");
      const workspaceStore = join(dir, "store");
      mkdirSync(repo, { recursive: true });
      mkdirSync(workspaceStore, { recursive: true });
      const baseCommit = initGitRepo(repo);
      const api = keel(store);

      const nonTerminalPath = retainedWorkspacePath(workspaceStore, "r-running", "agent");
      createRetainedWorktree(repo, nonTerminalPath, baseCommit);
      insertWorkspaceFixture(store, {
        runId: "r-running",
        agentKey: "agent",
        repo,
        baseCommit,
        workspacePath: nonTerminalPath,
        runStatus: "running",
        workspaceStatus: "pending_review",
      });
      expect(api.getRunWorkspace("r-running", "ws_agent")?.mergeSupported).toBe(false);
      expect(() => api.mergeRunWorkspace("r-running", "ws_agent")).toThrow(/while run is running/);
      expect(() => api.discardRunWorkspace("r-running", "ws_agent")).toThrow(
        /while run is running/,
      );
      store.deleteAgentWorkspace("r-running", "ws_agent");
      rmSync(nonTerminalPath, { recursive: true, force: true });

      const activePath = retainedWorkspacePath(workspaceStore, "r-active", "agent");
      createRetainedWorktree(repo, activePath, baseCommit);
      insertWorkspaceFixture(store, {
        runId: "r-active",
        agentKey: "agent",
        repo,
        baseCommit,
        workspacePath: activePath,
        runStatus: "finished",
        workspaceStatus: "pending_review",
        activeTurn: true,
      });
      expect(() => api.discardRunWorkspace("r-active", "ws_agent")).toThrow(/turn is active/);
      store.deleteAgentWorkspace("r-active", "ws_agent");
      rmSync(activePath, { recursive: true, force: true });

      const mergePath = retainedWorkspacePath(workspaceStore, "r-merge", "agent");
      createRetainedWorktree(repo, mergePath, baseCommit);
      writeFileSync(join(mergePath, "merged.txt"), "merged\n");
      insertWorkspaceFixture(store, {
        runId: "r-merge",
        agentKey: "agent",
        repo,
        baseCommit,
        workspacePath: mergePath,
        runStatus: "finished",
        workspaceStatus: "pending_review",
      });
      expect(api.mergeRunWorkspace("r-merge", "ws_agent").status).toBe("merged");
      expect(readFileSync(join(repo, "merged.txt"), "utf8")).toBe("merged\n");
      expect(() => api.mergeRunWorkspace("r-merge", "ws_agent")).toThrow(/status merged/);
      expect(() => api.discardRunWorkspace("r-merge", "ws_agent")).toThrow(/status merged/);

      const discardPath = retainedWorkspacePath(workspaceStore, "r-discard", "agent");
      createRetainedWorktree(repo, discardPath, baseCommit);
      insertWorkspaceFixture(store, {
        runId: "r-discard",
        agentKey: "agent",
        repo,
        baseCommit,
        workspacePath: discardPath,
        runStatus: "finished",
        workspaceStatus: "pending_review",
      });
      expect(api.discardRunWorkspace("r-discard", "ws_agent").status).toBe("discarded");
      expect(api.getRunWorkspace("r-discard", "ws_agent")?.diffSupported).toBe(false);
      expect(api.getRunWorkspace("r-discard", "ws_agent")?.discardSupported).toBe(false);
      expect(existsSync(discardPath)).toBe(false);
      expect(() => api.mergeRunWorkspace("r-discard", "ws_agent")).toThrow(/status discarded/);
      expect(() => api.discardRunWorkspace("r-discard", "ws_agent")).toThrow(/status discarded/);

      const pendingPath = retainedWorkspacePath(workspaceStore, "r-pending", "agent");
      createRetainedWorktree(repo, pendingPath, baseCommit);
      insertWorkspaceFixture(store, {
        runId: "r-pending",
        agentKey: "agent",
        repo,
        baseCommit,
        workspacePath: pendingPath,
        runStatus: "finished",
        workspaceStatus: "pending_review",
      });
      const diffErrorPath = retainedWorkspacePath(workspaceStore, "r-diff-error", "agent");
      createRetainedWorktree(repo, diffErrorPath, baseCommit);
      insertWorkspaceFixture(store, {
        runId: "r-diff-error",
        agentKey: "agent",
        repo,
        baseCommit,
        workspacePath: diffErrorPath,
        runStatus: "finished",
        workspaceStatus: "diff_error",
      });

      const diffErrorMergePath = retainedWorkspacePath(
        workspaceStore,
        "r-diff-error-merge",
        "agent",
      );
      createRetainedWorktree(repo, diffErrorMergePath, baseCommit);
      writeFileSync(join(diffErrorMergePath, "diff-error-merged.txt"), "merged from diff_error\n");
      insertWorkspaceFixture(store, {
        runId: "r-diff-error-merge",
        agentKey: "agent",
        repo,
        baseCommit,
        workspacePath: diffErrorMergePath,
        runStatus: "finished",
        workspaceStatus: "diff_error",
      });
      expect(api.mergeRunWorkspace("r-diff-error-merge", "ws_agent").status).toBe("merged");
      expect(readFileSync(join(repo, "diff-error-merged.txt"), "utf8")).toBe(
        "merged from diff_error\n",
      );

      const firstGc = api.gcWorkspaces({ olderThanMs: 0 });
      expect(firstGc.removed.map((w) => w.runId).sort()).toEqual(["r-diff-error-merge", "r-merge"]);
      expect(store.getAgentWorkspaceByKey("r-merge", "agent_session", "agent")).toBeNull();
      expect(store.getAgentWorkspaceByKey("r-discard", "agent_session", "agent")).toBeNull();
      expect(store.getAgentWorkspaceByKey("r-pending", "agent_session", "agent")?.status).toBe(
        "pending_review",
      );
      expect(store.getAgentWorkspaceByKey("r-diff-error", "agent_session", "agent")?.status).toBe(
        "diff_error",
      );
      expect(api.gcWorkspaces({ olderThanMs: 0 }).removed).toEqual([]);

      const pendingGc = api.gcWorkspaces({ olderThanMs: 0, includePending: true });
      expect(pendingGc.removed.map((w) => w.runId)).toEqual(["r-pending"]);
      expect(store.getAgentWorkspaceByKey("r-pending", "agent_session", "agent")).toBeNull();

      const liveCreatingPath = retainedWorkspacePath(workspaceStore, "r-creating-live", "agent");
      createRetainedWorktree(repo, liveCreatingPath, baseCommit);
      insertWorkspaceFixture(store, {
        runId: "r-creating-live",
        agentKey: "agent",
        repo,
        baseCommit,
        workspacePath: liveCreatingPath,
        runStatus: "running",
        workspaceStatus: "creating",
        runtimeOwnerId: "daemon_a",
        heartbeatAtMs: 10_000,
      });
      const longWindowKernel = new RealmKernel(store, {
        idgen: () => "run_unused",
        clock: () => 50_000,
        rng: () => 0.5,
      });
      const longWindowApi = new TestInProcessKeel(longWindowKernel, store, new EventHub(), {
        clock: () => 50_000,
        ownerStaleWindowMs: 60_000,
      });
      expect(longWindowApi.gcWorkspaces({ olderThanMs: 0 }).removed).toEqual([]);
      expect(
        store.getAgentWorkspaceByKey("r-creating-live", "agent_session", "agent")?.status,
      ).toBe("creating");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class ControlledStreamingProvider implements AgentProvider {
  readonly name = "pi";
  readonly supportsSessions = true;
  private firstEvent: Promise<void>;
  private resolveFirstEvent!: () => void;
  private releaseStream: Promise<void>;
  private resolveRelease!: () => void;

  constructor(
    private readonly events: AgentResult["transcript"],
    private readonly finalText?: string,
  ) {
    this.firstEvent = new Promise((resolve) => {
      this.resolveFirstEvent = resolve;
    });
    this.releaseStream = new Promise((resolve) => {
      this.resolveRelease = resolve;
    });
  }

  async generate(_invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    const [first, ...rest] = this.events;
    if (first) {
      hooks.onEvent?.(first);
      this.resolveFirstEvent();
    }
    await this.releaseStream;
    for (const event of rest) hooks.onEvent?.(event);
    return {
      text:
        this.finalText ??
        this.events
          .filter((event) => event.type === "text" && typeof event.data === "string")
          .map((event) => event.data)
          .join(""),
      transcript: this.events,
    };
  }

  waitForFirstEvent(): Promise<void> {
    return this.firstEvent;
  }

  release(): void {
    this.resolveRelease();
  }
}

describe("run report result policy", () => {
  test("includes small artifacts and omits large outputs/results", () => {
    const store = JournalStore.memory();
    seedReportRun(store, "run_report", {
      outputRef: JSON.stringify("x".repeat(9000)),
    });
    store.putArtifact("small_result", new TextEncoder().encode(JSON.stringify({ ok: true })), 1);
    store.putArtifact(
      "large_result",
      new TextEncoder().encode(JSON.stringify("y".repeat(9000))),
      1,
    );
    store.putJournalRow({
      runId: "run_report",
      stableKey: "small",
      effectType: "pure",
      status: "completed",
      version: "v1",
      inputHash: "h1",
      resultArtifact: "small_result",
    });
    store.putJournalRow({
      runId: "run_report",
      stableKey: "large",
      effectType: "effectful",
      status: "completed",
      version: "v1",
      inputHash: "h2",
      resultArtifact: "large_result",
    });

    const report = keel(store).getRunReport("run_report");
    expect(report?.output).toBeUndefined();
    expect(report?.outputOmitted).toBe(true);
    expect(report?.outputByteLength).toBeGreaterThan(8192);
    expect(report?.nodes.find((n) => n.stableKey === "small")?.result).toEqual({ ok: true });
    const large = report?.nodes.find((n) => n.stableKey === "large");
    expect(large?.result).toBeUndefined();
    expect(large?.resultOmitted).toBe(true);
    expect(large?.resultByteLength).toBeGreaterThan(8192);
  });

  test("fails clearly when a journal result artifact is missing", () => {
    const store = JournalStore.memory();
    seedReportRun(store, "run_missing_artifact");
    store.putJournalRow({
      runId: "run_missing_artifact",
      stableKey: "missing",
      effectType: "pure",
      status: "completed",
      version: "v1",
      inputHash: "h1",
      resultArtifact: "does_not_exist",
    });

    expect(() => keel(store).getRunReport("run_missing_artifact")).toThrow(
      "journal result artifact does_not_exist is missing",
    );
  });
});

describe("lifecycle start methods", () => {
  test(
    "retryRun starts work and waitForRun observes the terminal outcome",
    async () => {
      const store = JournalStore.memory();
      const mock = new MockProvider({
        responses: {
          flaky: { outputs: ['{"ok":true}'], throwOnce: true },
        },
      });
      const api = keel(store, mock);

      const { runId } = await api.launchRun({ ...flakyUrl, input: null, name: "flaky" });
      expect((await api.waitForRun(runId)).status).toBe("failed");

      const started = await api.retryRun(runId);
      expect(started).toMatchObject({
        runId,
        status: "running",
        attachCursor: { kind: "after-seq", runId, seq: 3 },
      });
      expect(await api.waitForRun(runId)).toMatchObject({
        runId,
        status: "finished",
        output: "done:true",
      });
      const attachedEvents: string[] = [];
      const unsub = api.subscribeEvents({ runId, cursor: started.attachCursor }, (event) =>
        attachedEvents.push(event.type),
      );
      unsub();
      expect(attachedEvents).toContain("run.retry");
      expect(attachedEvents).toContain("run.finished");
      expect(attachedEvents).not.toContain("run.failed");
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test("saved workflow launch and lifecycle restarts accept fresh runSecrets", async () => {
    {
      const store = JournalStore.memory();
      const api = secretEchoApi(store);
      api.saveWorkflow({
        name: "secret-echo",
        source: SECRET_ECHO_WORKFLOW.source,
        defaultTarget: process.cwd(),
      });
      const launched = await api.launchSavedWorkflow({
        ref: { name: "secret-echo" },
        input: { label: "saved" },
        runSecrets: { TOKEN: "saved-secret" },
      });
      expect(await api.waitForRun(launched.runId)).toMatchObject({
        status: "finished",
        output: "echo saved:saved-secret",
      });
    }

    {
      const store = JournalStore.memory();
      const api = secretEchoApi(store);
      const launched = await api.launchRun({
        source: SECRET_ECHO_WORKFLOW.source,
        input: { label: "retry" },
        target: process.cwd(),
      });
      expect((await api.waitForRun(launched.runId)).status).toBe("failed");
      await api.retryRun(launched.runId, { runSecrets: { TOKEN: "retry-secret" } });
      expect(await api.waitForRun(launched.runId)).toMatchObject({
        status: "finished",
        output: "echo retry:retry-secret",
      });
    }

    {
      const store = JournalStore.memory();
      const api = secretEchoApi(store);
      const launched = await api.launchRun({
        source: SECRET_ECHO_WORKFLOW.source,
        input: { label: "rewind" },
        target: process.cwd(),
        runSecrets: { TOKEN: "old-secret" },
      });
      expect(await api.waitForRun(launched.runId)).toMatchObject({
        status: "finished",
        output: "echo rewind:old-secret",
      });
      await api.rewindRun(launched.runId, "prefix", { runSecrets: { TOKEN: "rewind-secret" } });
      expect(await api.waitForRun(launched.runId)).toMatchObject({
        status: "finished",
        output: "echo rewind:rewind-secret",
      });
    }

    {
      const store = JournalStore.memory();
      const api = secretEchoApi(store);
      const launched = await api.launchRun({
        source: SECRET_ECHO_WORKFLOW.source,
        input: { label: "rerun-old" },
        target: process.cwd(),
        runSecrets: { TOKEN: "old-secret" },
      });
      expect(await api.waitForRun(launched.runId)).toMatchObject({
        status: "finished",
        output: "echo rerun-old:old-secret",
      });
      await api.rerunRun(launched.runId, {
        input: { label: "rerun-new" },
        runSecrets: { TOKEN: "rerun-secret" },
      });
      expect(await api.waitForRun(launched.runId)).toMatchObject({
        status: "finished",
        output: "echo rerun-new:rerun-secret",
      });
    }
  });

  test(
    "retryRun precondition errors reject without fake failed outcome",
    async () => {
      const store = JournalStore.memory();
      const api = keel(store);
      const { runId } = await api.launchRun({ ...chainUrl, input: { n: 2 }, name: "ok" });
      expect((await api.waitForRun(runId)).status).toBe("finished");

      await expect(api.retryRun(runId)).rejects.toThrow("retry needs a failed run (is finished)");
      expect(api.getRun(runId)?.status).toBe("finished");
      expect((await api.waitForRun(runId)).status).toBe("finished");
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );

  test("waitForRun reports interrupted after interrupting a parked run", async () => {
    const store = JournalStore.memory();
    const api = keel(store);
    const { runId } = await api.launchRun({ ...signalUrl, input: null, name: "signal" });
    expect((await api.waitForRun(runId)).status).toBe("waiting-signal");

    await expect(api.interruptRun(runId, "inspect")).resolves.toEqual({
      runId,
      status: "interrupted",
    });
    expect(api.getRun(runId)?.status).toBe("interrupted");
    expect((await api.waitForRun(runId)).status).toBe("interrupted");
  });

  test("interruptRun parks a running row and only resume can leave interrupted", async () => {
    const store = JournalStore.memory();
    store.insertRun({
      runId: "run_interrupt",
      workflowName: "interrupt",
      definitionVersion:
        "wf_sha256_0000000000000000000000000000000000000000000000000000000000000000",
      workflowRef: null,
      status: "running",
      parentRunId: null,
      tenantId: null,
      inputRef: null,
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      createdAtMs: 1,
    });
    const api = keel(store);

    await expect(api.interruptRun("run_interrupt", "inspect kc_run_secretValue")).resolves.toEqual({
      runId: "run_interrupt",
      status: "interrupted",
    });
    expect(api.getRun("run_interrupt")?.status).toBe("interrupted");
    expect(api.getBlockage("run_interrupt")).toMatchObject({
      reason: "interrupted",
      interrupted: { reason: "inspect «redacted-capability»", previousStatus: "running" },
    });
    await expect(api.retryRun("run_interrupt")).rejects.toThrow(
      "retry needs a failed run (is interrupted)",
    );
    await expect(api.rerunRun("run_interrupt")).rejects.toThrow(/resume it first/);
    await expect(api.rewindRun("run_interrupt", "step")).rejects.toThrow(/resume it first/);
  });

  test(
    "rewindRun to an unknown step rejects without starting work",
    async () => {
      const store = JournalStore.memory();
      const api = keel(store);
      const { runId } = await api.launchRun({ ...chainUrl, input: { n: 2 }, name: "ok" });
      expect((await api.waitForRun(runId)).status).toBe("finished");

      await expect(api.rewindRun(runId, "missing")).rejects.toThrow(
        'cannot rewind to unknown step "missing"',
      );
      expect(api.getRun(runId)?.status).toBe("finished");
    },
    WORKFLOW_TEST_TIMEOUT_MS,
  );
});

function seedReportRun(
  store: JournalStore,
  runId: string,
  opts: { outputRef?: string | null } = {},
): void {
  store.insertRun({
    runId,
    workflowName: "report",
    definitionVersion: "wf_sha256_0000000000000000000000000000000000000000000000000000000000000000",
    workflowRef: null,
    status: "finished",
    parentRunId: null,
    tenantId: null,
    inputRef: null,
    outputRef: opts.outputRef ?? null,
    errorJson: null,
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    createdAtMs: 1,
    finishedAtMs: 1,
  });
}
