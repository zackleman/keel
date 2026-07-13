// Commit 10: named agent profiles — the profile resolves into the agent before
// versioning, so the RESOLVED fields drive provider selection and the version
// hash; changing the profile config re-runs the step, renaming it does not.

import { describe, expect, test } from "bun:test";
import {
  checkAgentProfileConfig,
  normalizeAgentProfileConfig,
  resolveProfile,
} from "../agents/profiles.ts";
import { resolveSelectedProviderConfig } from "../agents/provider-config.ts";
import type { AgentInvocation, AgentProvider, AgentResult } from "../agents/types.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { JournalStore } from "../journal/store.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { snapshotWorkflowSource } from "../workflow-definitions/snapshot.ts";
import { RealmKernel } from "./realm/realm-host.ts";

const profiledUrl = captureWorkflowFile(
  new URL("./realm/fixtures/profiled.workflow.ts", import.meta.url).pathname,
);

describe("resolveProfile", () => {
  test("inherits profile fields, explicit spec wins, unknown profile throws", () => {
    const profiles = {
      reviewer: {
        provider: "pi",
        model: "opus",
        reasoning: "high",
        toolPolicy: "read-only" as const,
        environment: { vars: { MODE: "review" }, secrets: ["TOKEN"] },
      },
    };
    const resolved = resolveProfile(
      { key: "k", prompt: "p", profile: "reviewer" },
      profiles,
    ) as Record<string, unknown>;
    expect(resolved).toEqual({
      key: "k",
      prompt: "p",
      provider: "pi",
      model: "opus",
      reasoning: "high",
      toolPolicy: "read-only",
      environment: { vars: { MODE: "review" }, secrets: ["TOKEN"] },
    });
    // explicit field wins over the profile
    expect(
      resolveProfile({ key: "k", prompt: "p", profile: "reviewer", model: "haiku" }, profiles)
        .model,
    ).toBe("haiku");
    expect(
      resolveProfile(
        { key: "k", prompt: "p", profile: "reviewer", environment: { vars: { MODE: "local" } } },
        profiles,
      ).environment,
    ).toEqual({ vars: { MODE: "local" } });
    // unknown profile fails loud
    expect(() => resolveProfile({ key: "k", prompt: "p", profile: "nope" }, profiles)).toThrow(
      /unknown agent profile/,
    );
    expect(() =>
      resolveProfile(
        { key: "k", prompt: "p", profile: "old" },
        { old: { target: "/tmp" } as never },
      ),
    ).toThrow(/no longer accepts target/);
  });

  test("provider config uses selected-provider replacement semantics", () => {
    const profileProviderConfig = {
      codex: { transport: { type: "uds", path: "/tmp/codex.sock" }, effort: "high" },
      pi: { mode: "profile-pi" },
    };
    const inherited = resolveSelectedProviderConfig({
      context: 'ctx.agent("review")',
      selectedProvider: "codex",
      profileName: "reviewer",
      profileProviderConfig,
    });
    expect(inherited).toEqual(profileProviderConfig.codex);

    const replaced = resolveSelectedProviderConfig({
      context: 'ctx.agent("review")',
      selectedProvider: "codex",
      explicitProviderConfig: { codex: { transport: { type: "stdio" } } },
      profileName: "reviewer",
      profileProviderConfig,
    });
    expect(replaced).toEqual({ transport: { type: "stdio" } });

    const unselectedDoesNotBlock = resolveSelectedProviderConfig({
      context: 'ctx.agent("review")',
      selectedProvider: "codex",
      explicitProviderConfig: { pi: { mode: "unused" } },
      profileName: "reviewer",
      profileProviderConfig,
    });
    expect(unselectedDoesNotBlock).toEqual(profileProviderConfig.codex);
  });

  test("codex profile support is validated by capability shape", () => {
    const registry = new AgentProviderRegistry().register({
      name: "codex",
      async generate(): Promise<AgentResult> {
        return { text: "ok", transcript: [] };
      },
    });
    const check = (config: Record<string, unknown>) =>
      checkAgentProfileConfig(config, { providerRegistry: registry });

    expect(check({ provider: "codex", toolPolicy: "read-only" }).ok).toBe(true);
    expect(check({ provider: "codex", toolPolicy: "workspace-write" }).ok).toBe(true);
    expect(
      check({
        provider: "codex",
        capabilities: { fs: "workspace-write", shell: true, network: ["*"], secrets: [] },
      }).ok,
    ).toBe(true);

    const none = check({ provider: "codex", toolPolicy: "none" });
    expect(none.ok).toBe(false);
    expect(none.diagnostics[0]?.message).toMatch(/no-tools capability shapes/);
    expect(none.diagnostics[0]?.message).toBe(
      'profile provider "codex": codex provider does not support no-tools capability shapes; Codex app-server has no verified no-tools mapping',
    );

    const toolEdit = check({ provider: "codex", toolPolicy: "read-only", allowTools: ["bash"] });
    expect(toolEdit.ok).toBe(false);
    expect(toolEdit.diagnostics[0]?.message).toMatch(/allowTools or denyTools/);

    const unsupported = check({
      provider: "codex",
      capabilities: { fs: "workspace-write", shell: true, network: "none", secrets: [] },
    });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.diagnostics[0]?.message).toMatch(/fs=workspace-write/);
  });

  test("known provider profiles reject non-canonical native tool names", () => {
    const provider = (name: string): AgentProvider => ({
      name,
      async generate(): Promise<AgentResult> {
        return { text: "ok", transcript: [] };
      },
    });
    const registry = new AgentProviderRegistry()
      .register(provider("pi"))
      .register(provider("claude"))
      .register(provider("custom"));
    const check = (config: Record<string, unknown>) =>
      checkAgentProfileConfig(config, { providerRegistry: registry });

    const piAlias = check({ provider: "pi", toolPolicy: "read-only", allowTools: ["run"] });
    expect(piAlias.ok).toBe(false);
    expect(piAlias.diagnostics[0]?.message).toMatch(
      /profile provider "pi": pi provider tool "run" is not canonical; use "bash"/,
    );

    const claudeAlias = check({
      provider: "claude",
      toolPolicy: "read-only",
      denyTools: ["search"],
    });
    expect(claudeAlias.ok).toBe(false);
    expect(claudeAlias.diagnostics[0]?.message).toMatch(
      /profile provider "claude": claude provider tool "search" is not canonical; use "WebSearch"/,
    );

    expect(check({ provider: "custom", toolPolicy: "read-only", allowTools: ["run"] }).ok).toBe(
      true,
    );
  });

  test("profile normalization stores structurally valid codex configs without support checks", () => {
    const normalized = normalizeAgentProfileConfig({
      provider: "codex",
      toolPolicy: "none",
    });
    expect(normalized).toEqual({ provider: "codex", toolPolicy: "none" });
  });

  test("profile normalization accepts environment and still rejects top-level secrets", () => {
    expect(
      normalizeAgentProfileConfig({
        provider: "pi",
        capabilities: { secrets: ["TOKEN"] },
        environment: { vars: { MODE: "review" }, secrets: ["TOKEN"] },
      }),
    ).toEqual({
      provider: "pi",
      capabilities: { secrets: ["TOKEN"] },
      environment: { vars: { MODE: "review" }, secrets: ["TOKEN"] },
    });
    expect(() => normalizeAgentProfileConfig({ provider: "pi", secrets: ["TOKEN"] })).toThrow(
      /profile\.secrets is not allowed/,
    );
  });
});

describe("profiles through the realm", () => {
  /** records which provider name it was invoked under. */
  function recordingProvider(name: string, seen: string[]): AgentProvider {
    return {
      name,
      async generate(_inv: AgentInvocation): Promise<AgentResult> {
        seen.push(name);
        return { text: "ok", transcript: [] };
      },
    };
  }

  test("an agent resolves its provider/model from the named profile", async () => {
    const store = JournalStore.memory();
    const seen: string[] = [];
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(recordingProvider("reviewerProvider", seen)),
      agentProfiles: { reviewer: { provider: "reviewerProvider", model: "opus" } },
    });
    const handle = await kernel.run<string>(profiledUrl, null, {
      name: "p",
      target: process.cwd(),
    });
    expect(handle.status).toBe("finished");
    expect(seen).toEqual(["reviewerProvider"]); // provider came from the profile
  });

  test("invalid profile provider config fails with a path before realm transmission", () => {
    expect(
      () =>
        new RealmKernel(JournalStore.memory(), {
          idgen: () => "r",
          agents: new AgentProviderRegistry().register(recordingProvider("p", [])),
          agentProfiles: {
            reviewer: { provider: "p", providerConfig: { p: { bad: () => null } } as never },
          },
        }),
    ).toThrow(/agent profile "reviewer" providerConfig\.p\.bad/);
  });

  test("missing run profile snapshot set fails the run terminally", async () => {
    const store = JournalStore.memory();
    const { snapshot } = snapshotWorkflowSource(
      store,
      "export default async function workflow() { return 'ok'; }",
      { name: "missing-snapshot", nowMs: 1 },
    );
    store.insertRun({
      runId: "missing_snapshot",
      workflowName: "missing-snapshot",
      definitionVersion: snapshot.hash,
      workflowRef: "stdin",
      runTarget: process.cwd(),
      status: "running",
      parentRunId: null,
      tenantId: null,
      inputRef: "null",
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      launchAuthorityJson: null,
      createdAtMs: 1,
    });
    const kernel = new RealmKernel(store, { idgen: () => "unused" });

    await expect(kernel.startResume("missing_snapshot").done).rejects.toThrow(
      /missing agent profile snapshot set/,
    );
    expect(store.getRun("missing_snapshot")?.status).toBe("failed");
    expect(store.getRun("missing_snapshot")?.errorJson).toContain("ProfileSnapshotIntegrityError");
  });

  test("changing a profile's config changes the agent step version (re-runs)", async () => {
    // version hash with the profile resolving to model A vs model B
    const v = (model: string) => {
      const store = JournalStore.memory();
      const seen: string[] = [];
      return new RealmKernel(store, {
        idgen: () => "r",
        agents: new AgentProviderRegistry().register(recordingProvider("p", seen)),
        agentProfiles: { reviewer: { provider: "p", model } },
      })
        .run(profiledUrl, null, { name: "p", target: process.cwd() })
        .then(() => store.getJournalRow("r", "review", 1)?.version ?? "");
    };
    const [vA, vB] = await Promise.all([v("opus"), v("haiku")]);
    expect(vA).not.toBe(vB); // resolved model is part of the version
  });
});
