import type { Capabilities, ToolPolicy } from "../agents/capabilities.ts";
import { READ_ONLY, resolveCapabilities } from "../agents/capabilities.ts";
import type { WorkflowSourceInput } from "../workflow-definitions/source.ts";

export const UNTRUSTED_DEFAULT_CEILING_PROFILE = "untrusted-default";
export const DEFAULT_ONE_OFF_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LaunchAuthority {
  profile: string;
  ceiling: Capabilities;
}

const FS_RANK: Record<Capabilities["fs"], number> = {
  none: 0,
  read: 1,
  "workspace-write": 2,
};

export function authorityForCeilingProfile(profile: string): LaunchAuthority {
  if (profile !== UNTRUSTED_DEFAULT_CEILING_PROFILE) {
    throw new Error(`unknown launch-authority ceiling profile "${profile}"`);
  }
  return {
    profile,
    ceiling: cloneCapabilities(READ_ONLY),
  };
}

export class CapabilityCeilingError extends Error {
  readonly code = "capability_ceiling_exceeded";

  constructor(
    readonly profile: string,
    readonly context: string,
    readonly declared: Capabilities,
    readonly ceiling: Capabilities,
    readonly exceeded: string[],
  ) {
    super(
      `${context} exceeds launch-authority ceiling "${profile}": ${exceeded.join(", ")}; request escalation with ctx.human({ requestedCaps })`,
    );
    this.name = "CapabilityCeilingError";
  }
}

export function assertCapabilitiesWithinAuthority(
  declared: Capabilities,
  authority: LaunchAuthority | null,
  context: string,
): Capabilities {
  if (!authority) return cloneCapabilities(declared);
  const exceeded: string[] = [];
  if (FS_RANK[declared.fs] > FS_RANK[authority.ceiling.fs]) exceeded.push(`fs=${declared.fs}`);
  if (declared.shell && !authority.ceiling.shell) exceeded.push("shell=true");
  if (!networkIsSubset(declared.network, authority.ceiling.network)) exceeded.push("network");
  const allowedSecrets = new Set(authority.ceiling.secrets);
  const deniedSecrets = declared.secrets.filter((secret) => !allowedSecrets.has(secret));
  if (deniedSecrets.length > 0) exceeded.push(`secrets=[${deniedSecrets.join(",")}]`);
  if (exceeded.length > 0) {
    throw new CapabilityCeilingError(
      authority.profile,
      context,
      cloneCapabilities(declared),
      cloneCapabilities(authority.ceiling),
      exceeded,
    );
  }
  return minCapabilities(declared, authority.ceiling);
}

export function grantCapabilities(
  authority: LaunchAuthority | null,
  granted: unknown,
): LaunchAuthority | null {
  if (!authority || granted === null || typeof granted !== "object" || Array.isArray(granted)) {
    return authority;
  }
  const caps = resolveCapabilities({ capabilities: granted as Partial<Capabilities> });
  return {
    profile: authority.profile,
    ceiling: {
      fs: FS_RANK[caps.fs] > FS_RANK[authority.ceiling.fs] ? caps.fs : authority.ceiling.fs,
      shell: authority.ceiling.shell || caps.shell,
      network: unionNetwork(authority.ceiling.network, caps.network),
      secrets: [...new Set([...authority.ceiling.secrets, ...caps.secrets])].sort(),
    },
  };
}

export function preflightSubmissionSource(
  source: WorkflowSourceInput,
  authority: LaunchAuthority | null,
): void {
  if (!authority) return;
  const modules =
    typeof source === "string" ? [{ path: "entry.ts", code: source }] : source.modules;
  for (const module of modules) {
    for (const match of module.code.matchAll(
      /toolPolicy\s*:\s*["'](none|read-only|workspace-write|unrestricted)["']/g,
    )) {
      const policy = match[1] as ToolPolicy;
      assertCapabilitiesWithinAuthority(
        resolveCapabilities({ toolPolicy: policy }),
        authority,
        `${module.path} toolPolicy "${policy}"`,
      );
    }
    for (const match of module.code.matchAll(/capabilities\s*:\s*\{([^{}]*)\}/gs)) {
      const body = match[1] ?? "";
      const partial: Partial<Capabilities> = {};
      const fs = /\bfs\s*:\s*["'](none|read|workspace-write)["']/.exec(body)?.[1];
      if (fs) partial.fs = fs as Capabilities["fs"];
      const shell = /\bshell\s*:\s*(true|false)/.exec(body)?.[1];
      if (shell) partial.shell = shell === "true";
      if (/\bnetwork\s*:\s*\[(?!\s*\])/.test(body)) partial.network = ["*"];
      const secrets = /\bsecrets\s*:\s*\[(?!\s*\])/.test(body);
      if (secrets) partial.secrets = ["<declared>"];
      if (Object.keys(partial).length > 0) {
        assertCapabilitiesWithinAuthority(
          resolveCapabilities({ capabilities: partial }),
          authority,
          `${module.path} capabilities declaration`,
        );
      }
    }
  }
}

export function parseLaunchAuthority(value: string | null): LaunchAuthority | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as LaunchAuthority;
  if (
    !parsed ||
    typeof parsed.profile !== "string" ||
    !parsed.ceiling ||
    typeof parsed.ceiling !== "object"
  ) {
    throw new Error("persisted launch authority is invalid");
  }
  return {
    profile: parsed.profile,
    ceiling: resolveCapabilities({ capabilities: parsed.ceiling }),
  };
}

function minCapabilities(a: Capabilities, b: Capabilities): Capabilities {
  return {
    fs: FS_RANK[a.fs] <= FS_RANK[b.fs] ? a.fs : b.fs,
    shell: a.shell && b.shell,
    network: intersectNetwork(a.network, b.network),
    secrets: a.secrets.filter((secret) => b.secrets.includes(secret)),
  };
}

function networkIsSubset(
  declared: Capabilities["network"],
  ceiling: Capabilities["network"],
): boolean {
  if (declared === "none") return true;
  if (ceiling === "none") return false;
  if (ceiling.includes("*")) return true;
  return declared.every((host) => ceiling.includes(host));
}

function intersectNetwork(
  a: Capabilities["network"],
  b: Capabilities["network"],
): Capabilities["network"] {
  if (a === "none" || b === "none") return "none";
  if (a.includes("*")) return [...b];
  if (b.includes("*")) return [...a];
  return a.filter((host) => b.includes(host));
}

function unionNetwork(
  a: Capabilities["network"],
  b: Capabilities["network"],
): Capabilities["network"] {
  if (a === "none") return b === "none" ? "none" : [...b];
  if (b === "none") return [...a];
  if (a.includes("*") || b.includes("*")) return ["*"];
  return [...new Set([...a, ...b])].sort();
}

function cloneCapabilities(caps: Capabilities): Capabilities {
  return {
    fs: caps.fs,
    shell: caps.shell,
    network: caps.network === "none" ? "none" : [...caps.network],
    secrets: [...caps.secrets],
  };
}
