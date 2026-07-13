import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "../../agents/secrets.ts";
import type { AgentInvocation, AgentProvider, AgentResult } from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { authorityForCeilingProfile } from "../../policy/launch-authority.ts";
import { RealmKernel } from "./realm-host.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

type TestKernelOptions = NonNullable<ConstructorParameters<typeof RealmKernel>[1]>;

function kernel(
  store: JournalStore,
  provider: AgentProvider,
  opts: Omit<TestKernelOptions, "idgen" | "agents"> = {},
): RealmKernel {
  return new RealmKernel(store, {
    ...opts,
    idgen: () => "run_workspace_setup",
    agents: new AgentProviderRegistry().register(provider),
  });
}

describe("workspace setup commands", () => {
  test("rejects setup capabilities outside the run launch-authority ceiling", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-ceiling-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-ceiling",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<void> {
          await ctx.workspace({
            key: "prepared",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                {
                  key: "write",
                  command: "/bin/sh",
                  args: ["-c", "printf escaped > escaped.txt"],
                },
              ],
            },
          });
        }
      `,
    };

    const launched = kernel(store, provider).launch<void>(
      workflow,
      { workspace },
      {
        target: workspace,
        launchAuthority: authorityForCeilingProfile("untrusted-default"),
      },
    );

    await expect(launched.done).rejects.toThrow(/exceeds launch-authority ceiling/);
    expect(existsSync(join(workspace, "escaped.txt"))).toBe(false);
  });

  test("runs setup before an agent uses the workspace", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-");
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "reader",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        invocation = inv;
        return {
          text: readFileSync(join(inv.cwd ?? "", "generated.txt"), "utf8"),
          transcript: [],
        };
      },
    };
    const workflow = {
      name: "workspace-setup-agent",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const workspace = await ctx.workspace({
            key: "prepared",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                {
                  key: "generate",
                  command: "/bin/sh",
                  args: ["-c", "printf prepared > generated.txt"],
                },
              ],
            },
          });
          return await ctx.agent({ key: "inspect", provider: "reader", prompt: "read", workspace });
        }
      `,
    };

    const result = await kernel(store, provider).run<string>(
      workflow,
      { workspace },
      { target: workspace },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toBe("prepared");
    expect(invocation?.cwd).toBe(workspace);
    expect(store.getAgentWorkspace("run_workspace_setup", "prepared")).toMatchObject({
      setupStatus: "completed",
      activeHolderKind: null,
    });
    expect(
      store.getLatestAttempt("run_workspace_setup", "workspace.setup.prepared.generate"),
    ).toMatchObject({
      effectType: "workspace_setup",
      status: "completed",
    });
    expect(store.listEvents("run_workspace_setup").map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace.setup.started",
        "workspace.setup.command.started",
        "workspace.setup.command.completed",
        "workspace.setup.completed",
      ]),
    );
  });

  test("reuses completed setup for repeated workspace resolution", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-reuse-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-reuse",
      source: `
        import { type Ctx } from "@kcosr/keel";
        const spec = (workspace: string) => ({
          key: "prepared",
          mode: "direct" as const,
          path: workspace,
          setup: {
            capabilities: { fs: "workspace-write" as const, shell: true, network: "none" as const },
            commands: [
              {
                key: "append",
                command: "/bin/sh",
                args: ["-c", "printf run >> count.txt"],
              },
            ],
          },
        });
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const workspace = await ctx.workspace(spec(input.workspace));
          await ctx.workspace(spec(input.workspace));
          const read = await ctx.command({
            key: "read-count",
            workspace,
            cwd: ".",
            mode: "argv",
            argv: ["/bin/sh", "-c", "cat count.txt"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          return read.stdout.text;
        }
      `,
    };

    const result = await kernel(store, provider).run<string>(
      workflow,
      { workspace },
      { target: workspace },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toBe("run");
  });

  test("shares one setup execution across parallel workspace resolution", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-parallel-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-parallel",
      source: `
        import { type Ctx } from "@kcosr/keel";
        const spec = (workspace: string) => ({
          key: "prepared",
          mode: "direct" as const,
          path: workspace,
          setup: {
            capabilities: { fs: "workspace-write" as const, shell: true, network: "none" as const },
            commands: [
              {
                key: "append",
                command: "/bin/sh",
                args: ["-c", "sleep 0.05; printf run >> count.txt"],
              },
            ],
          },
        });
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const [first] = await Promise.all([
            ctx.workspace(spec(input.workspace)),
            ctx.workspace(spec(input.workspace)),
          ]);
          const read = await ctx.command({
            key: "read-count",
            workspace: first,
            cwd: ".",
            mode: "argv",
            argv: ["/bin/sh", "-c", "cat count.txt"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          return read.stdout.text;
        }
      `,
    };

    const result = await kernel(store, provider).run<string>(
      workflow,
      { workspace },
      { target: workspace },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toBe("run");
    expect(
      store
        .listEvents("run_workspace_setup")
        .filter((event) => event.type === "workspace.setup.started"),
    ).toHaveLength(1);
  });

  test("failed setup prevents provider invocation", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-fail-");
    let called = false;
    const provider: AgentProvider = {
      name: "reader",
      async generate(): Promise<AgentResult> {
        called = true;
        return { text: "called", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-fail",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const workspace = await ctx.workspace({
            key: "prepared",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                { key: "fail", command: "/bin/sh", args: ["-c", "printf nope >&2; exit 7"] },
              ],
            },
          });
          return await ctx.agent({ key: "inspect", provider: "reader", prompt: "read", workspace });
        }
      `,
    };

    await expect(
      kernel(store, provider).run<string>(workflow, { workspace }, { target: workspace }),
    ).rejects.toThrow(/command fail failed/);
    expect(called).toBe(false);
    expect(store.getAgentWorkspace("run_workspace_setup", "prepared")).toMatchObject({
      setupStatus: "failed",
      failureSeen: true,
      activeHolderKind: null,
    });
    expect(store.listEvents("run_workspace_setup").map((event) => event.type)).toContain(
      "workspace.setup.failed",
    );
  });

  test("rerun recovers a workspace stranded with a pending setup holder", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-stranded-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-stranded",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const workspace = await ctx.workspace({
            key: "prepared",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                { key: "write", command: "/bin/sh", args: ["-c", "printf prepared > prepared.txt"] },
              ],
            },
          });
          const read = await ctx.command({
            key: "read-prepared",
            workspace,
            cwd: ".",
            mode: "argv",
            argv: ["/bin/sh", "-c", "cat prepared.txt"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          return read.stdout.text;
        }
      `,
    };

    const first = await kernel(store, provider).run<string>(
      workflow,
      { workspace },
      { target: workspace },
    );
    expect(first.output).toBe("prepared");
    const row = store.getAgentWorkspace("run_workspace_setup", "prepared");
    expect(row?.setupIdentityHash).toBeTruthy();
    writeFileSync(join(workspace, "prepared.txt"), "stale");
    store.deleteWorkspaceSetupRowsByStableKeyPrefix("run_workspace_setup", [
      "workspace.setup.prepared.",
    ]);
    store.updateAgentWorkspace("run_workspace_setup", "prepared", {
      setupStatus: "pending",
      setupFinishedAtMs: null,
      setupErrorJson: null,
      activeHolderKind: "setup",
      activeHolderKey: row?.setupIdentityHash ?? null,
      activeHolderAttempt: null,
      activeStartedAtMs: Date.now(),
    });

    const rerun = await kernel(store, provider).rerun<string>("run_workspace_setup");

    expect(rerun.status).toBe("finished");
    expect(rerun.output).toBe("prepared");
    expect(store.getAgentWorkspace("run_workspace_setup", "prepared")).toMatchObject({
      setupStatus: "completed",
      activeHolderKind: null,
    });
  });

  test("terminal retry resets failed setup and reruns commands from the first setup command", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-retry-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-retry",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const workspace = await ctx.workspace({
            key: "prepared",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                {
                  key: "flaky",
                  command: "/bin/sh",
                  args: ["-c", "if [ ! -f marker ]; then touch marker; exit 7; fi; printf ok > done.txt"],
                },
              ],
            },
          });
          const read = await ctx.command({
            key: "read-done",
            workspace,
            cwd: ".",
            mode: "argv",
            argv: ["/bin/sh", "-c", "cat done.txt"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          return read.stdout.text;
        }
      `,
    };

    await expect(
      kernel(store, provider).run<string>(workflow, { workspace }, { target: workspace }),
    ).rejects.toThrow(/command flaky failed/);
    expect(store.getAgentWorkspace("run_workspace_setup", "prepared")).toMatchObject({
      setupStatus: "failed",
    });

    const retried = await kernel(store, provider).retry<string>("run_workspace_setup");

    expect(retried.status).toBe("finished");
    expect(retried.output).toBe("ok");
    expect(store.getAgentWorkspace("run_workspace_setup", "prepared")).toMatchObject({
      setupStatus: "completed",
      activeHolderKind: null,
    });
    const events = store.listEvents("run_workspace_setup").map((event) => event.type);
    expect(events.filter((event) => event === "workspace.setup.started")).toHaveLength(2);
    const secondSetupStarted = events.indexOf(
      "workspace.setup.started",
      events.indexOf("workspace.setup.started") + 1,
    );
    const secondCommandStarted = events.indexOf(
      "workspace.setup.command.started",
      events.indexOf("workspace.setup.command.started") + 1,
    );
    expect(secondSetupStarted).toBeGreaterThan(-1);
    expect(secondCommandStarted).toBeGreaterThan(secondSetupStarted);
  });

  test("terminal retry preserves completed setup rows for other workspaces", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-retry-scoped-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-retry-scoped",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const ready = await ctx.workspace({
            key: "ready",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                { key: "write", command: "/bin/sh", args: ["-c", "printf ready > ready.txt"] },
              ],
            },
          });
          const flaky = await ctx.workspace({
            key: "flaky",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                {
                  key: "write",
                  command: "/bin/sh",
                  args: ["-c", "if [ ! -f marker ]; then touch marker; exit 7; fi; printf flaky > flaky.txt"],
                },
              ],
            },
          });
          const readReady = await ctx.command({
            key: "read-ready",
            workspace: ready,
            cwd: ".",
            mode: "argv",
            argv: ["/bin/sh", "-c", "cat ready.txt"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          const readFlaky = await ctx.command({
            key: "read-flaky",
            workspace: flaky,
            cwd: ".",
            mode: "argv",
            argv: ["/bin/sh", "-c", "cat flaky.txt"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          return readReady.stdout.text + "/" + readFlaky.stdout.text;
        }
      `,
    };

    await expect(
      kernel(store, provider).run<string>(workflow, { workspace }, { target: workspace }),
    ).rejects.toThrow(/command write failed/);
    expect(
      store.getLatestAttempt("run_workspace_setup", "workspace.setup.ready.write"),
    ).toMatchObject({
      effectType: "workspace_setup",
      status: "completed",
    });
    expect(
      store.getLatestAttempt("run_workspace_setup", "workspace.setup.flaky.write"),
    ).toMatchObject({
      effectType: "workspace_setup",
      status: "completed",
    });

    const retried = await kernel(store, provider).retry<string>("run_workspace_setup");

    expect(retried.status).toBe("finished");
    expect(retried.output).toBe("ready/flaky");
    expect(
      store.getLatestAttempt("run_workspace_setup", "workspace.setup.ready.write"),
    ).toMatchObject({
      effectType: "workspace_setup",
      status: "completed",
    });
    expect(
      store.getLatestAttempt("run_workspace_setup", "workspace.setup.flaky.write"),
    ).toMatchObject({
      effectType: "workspace_setup",
      status: "completed",
    });
    const events = store.listEvents("run_workspace_setup");
    expect(
      events.filter(
        (event) =>
          event.type === "workspace.setup.started" &&
          (JSON.parse(event.payloadJson) as { workspaceId?: string }).workspaceId === "ready",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "workspace.setup.started" &&
          (JSON.parse(event.payloadJson) as { workspaceId?: string }).workspaceId === "flaky",
      ),
    ).toHaveLength(2);
  });

  test("setup identity changes fail closed on rerun", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-identity-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const source = (text: string) => `
      import { type Ctx } from "@kcosr/keel";
      export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
        const workspace = await ctx.workspace({
          key: "prepared",
          mode: "direct",
          path: input.workspace,
          setup: {
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            commands: [
              { key: "write", command: "/bin/sh", args: ["-c", "printf ${text} > prepared.txt"] },
            ],
          },
        });
        const read = await ctx.command({
          key: "read-prepared",
          workspace,
          cwd: ".",
          mode: "argv",
          argv: ["/bin/sh", "-c", "cat prepared.txt"],
          capabilities: { fs: "workspace-write", shell: true, network: "none" },
          timeoutMs: 5000,
          maxStdoutBytes: 1000,
          maxStderrBytes: 1000,
        });
        return read.stdout.text;
      }
    `;

    const first = await kernel(store, provider).run<string>(
      { name: "workspace-setup-identity", source: source("one") },
      { workspace },
      { target: workspace },
    );
    expect(first.output).toBe("one");

    await expect(
      kernel(store, provider).rerun<string>("run_workspace_setup", {
        source: source("two"),
        input: { workspace },
      }),
    ).rejects.toThrow(/setup identity changed/);
  });

  test("agent workspace acquisition checks setup readiness", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-agent-ready-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-agent-ready",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          await ctx.workspace({
            key: "prepared",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                { key: "write", command: "/bin/sh", args: ["-c", "printf prepared > prepared.txt"] },
              ],
            },
          });
          return "ok";
        }
      `,
    };
    const realm = kernel(store, provider);
    await realm.run<string>(workflow, { workspace }, { target: workspace });
    const setupIdentityHash = store.getAgentWorkspace(
      "run_workspace_setup",
      "prepared",
    )?.setupIdentityHash;
    expect(setupIdentityHash).toBeTruthy();
    const beginInvocationWorkspace = (
      realm as unknown as {
        beginInvocationWorkspace(
          runId: string,
          workspaceId: string,
          setupIdentityHash: string | null,
          holder: { kind: "agent"; key: string; attempt: number },
          atMs: number,
        ): unknown;
      }
    ).beginInvocationWorkspace.bind(realm);

    store.updateAgentWorkspace("run_workspace_setup", "prepared", { setupStatus: "pending" });
    expect(() =>
      beginInvocationWorkspace(
        "run_workspace_setup",
        "prepared",
        setupIdentityHash ?? null,
        { kind: "agent", key: "inspect", attempt: 1 },
        Date.now(),
      ),
    ).toThrow(/setup is pending/);

    store.updateAgentWorkspace("run_workspace_setup", "prepared", {
      setupStatus: "failed",
      setupErrorJson: JSON.stringify({ name: "Error", message: "failed" }),
    });
    expect(() =>
      beginInvocationWorkspace(
        "run_workspace_setup",
        "prepared",
        setupIdentityHash ?? null,
        { kind: "agent", key: "inspect", attempt: 1 },
        Date.now(),
      ),
    ).toThrow(/setup failed/);

    store.updateAgentWorkspace("run_workspace_setup", "prepared", {
      setupStatus: "completed",
      setupIdentityHash: "different",
    });
    expect(() =>
      beginInvocationWorkspace(
        "run_workspace_setup",
        "prepared",
        setupIdentityHash ?? null,
        { kind: "agent", key: "inspect", attempt: 1 },
        Date.now(),
      ),
    ).toThrow(/setup identity changed/);
  });

  test("setup environment secrets fail before spawning when missing or ungranted", async () => {
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const source = (grantSecret: boolean) => `
      import { type Ctx } from "@kcosr/keel";
      export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<void> {
        await ctx.workspace({
          key: "prepared",
          mode: "direct",
          path: input.workspace,
          setup: {
            capabilities: {
              fs: "workspace-write",
              shell: true,
              network: "none",
              secrets: ${grantSecret ? '["TOKEN"]' : "[]"},
            },
            commands: [
              {
                key: "secret",
                command: "/bin/sh",
                args: ["-c", "printf spawned > spawned.txt"],
                environment: { secrets: ["TOKEN"] },
              },
            ],
          },
        });
      }
    `;
    const missingStore = JournalStore.memory();
    const missingWorkspace = tempDir("keel-workspace-setup-missing-secret-");

    await expect(
      kernel(missingStore, provider, { secrets: new SecretStore() }).run<void>(
        { name: "workspace-setup-missing-secret", source: source(true) },
        { workspace: missingWorkspace },
        { target: missingWorkspace },
      ),
    ).rejects.toThrow(/missing secret value/);
    expect(existsSync(join(missingWorkspace, "spawned.txt"))).toBe(false);

    const ungrantedStore = JournalStore.memory();
    const ungrantedWorkspace = tempDir("keel-workspace-setup-ungranted-secret-");
    await expect(
      kernel(ungrantedStore, provider, { secrets: new SecretStore() }).run<void>(
        { name: "workspace-setup-ungranted-secret", source: source(false) },
        { workspace: ungrantedWorkspace },
        { target: ungrantedWorkspace, runSecrets: { TOKEN: "value" } },
      ),
    ).rejects.toThrow(/capabilities\.secrets/);
    expect(existsSync(join(ungrantedWorkspace, "spawned.txt"))).toBe(false);
  });

  test("setup cwd validation fails before spawning for missing or escaping cwd", async () => {
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const source = (cwd: string) => `
      import { type Ctx } from "@kcosr/keel";
      export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<void> {
        await ctx.workspace({
          key: "prepared",
          mode: "direct",
          path: input.workspace,
          setup: {
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            commands: [
              {
                key: "cwd",
                command: "/bin/sh",
                args: ["-c", "printf spawned > spawned.txt"],
                cwd: ${JSON.stringify(cwd)},
              },
            ],
          },
        });
      }
    `;
    const missingStore = JournalStore.memory();
    const missingWorkspace = tempDir("keel-workspace-setup-missing-cwd-");
    await expect(
      kernel(missingStore, provider).run<void>(
        { name: "workspace-setup-missing-cwd", source: source("missing") },
        { workspace: missingWorkspace },
        { target: missingWorkspace },
      ),
    ).rejects.toThrow(/ENOENT|no such file/i);
    expect(existsSync(join(missingWorkspace, "spawned.txt"))).toBe(false);

    const escapeStore = JournalStore.memory();
    const escapeWorkspace = tempDir("keel-workspace-setup-escape-cwd-");
    await expect(
      kernel(escapeStore, provider).run<void>(
        { name: "workspace-setup-escape-cwd", source: source("..") },
        { workspace: escapeWorkspace },
        { target: escapeWorkspace },
      ),
    ).rejects.toThrow(/must not contain \.\. path segments/);
    expect(existsSync(join(escapeWorkspace, "spawned.txt"))).toBe(false);
  });
});
