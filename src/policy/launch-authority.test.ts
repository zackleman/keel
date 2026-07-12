import { describe, expect, test } from "bun:test";
import {
  CapabilityCeilingError,
  assertCapabilitiesWithinAuthority,
  authorityForCeilingProfile,
  grantCapabilities,
  preflightSubmissionSource,
} from "./launch-authority.ts";

describe("launch-authority ceilings", () => {
  test("effective capabilities are the declared/ceiling minimum and over-asks fail closed", () => {
    const authority = authorityForCeilingProfile("untrusted-default");
    expect(
      assertCapabilitiesWithinAuthority(
        { fs: "none", shell: false, network: "none", secrets: [] },
        authority,
        "agent",
      ),
    ).toEqual({ fs: "none", shell: false, network: "none", secrets: [] });
    expect(() =>
      assertCapabilitiesWithinAuthority(
        { fs: "workspace-write", shell: true, network: ["*"], secrets: ["TOKEN"] },
        authority,
        "agent",
      ),
    ).toThrow(CapabilityCeilingError);
  });

  test("approval grants expand only the snapshotted run authority", () => {
    const original = authorityForCeilingProfile("untrusted-default");
    const granted = grantCapabilities(original, {
      fs: "workspace-write",
      shell: true,
      network: "none",
      secrets: [],
    });
    expect(granted?.ceiling).toEqual({
      fs: "workspace-write",
      shell: true,
      network: "none",
      secrets: [],
    });
    expect(original.ceiling).toEqual({
      fs: "read",
      shell: false,
      network: "none",
      secrets: [],
    });
  });

  test("static workflow over-asks are rejected before launch", () => {
    expect(() =>
      preflightSubmissionSource(
        `export default async function wf(ctx) {
          return ctx.agent({ key: "x", prompt: "x", toolPolicy: "unrestricted" });
        }`,
        authorityForCeilingProfile("untrusted-default"),
      ),
    ).toThrow(/toolPolicy "unrestricted".*untrusted-default/);
  });

  test("spawned child snapshots remain attenuated from later parent grants", () => {
    const parent = authorityForCeilingProfile("untrusted-default");
    const child = JSON.parse(JSON.stringify(parent)) as typeof parent;
    const expandedParent = grantCapabilities(parent, {
      fs: "workspace-write",
      shell: true,
      network: "none",
      secrets: [],
    });
    expect(expandedParent?.ceiling.fs).toBe("workspace-write");
    expect(child.ceiling).toEqual({
      fs: "read",
      shell: false,
      network: "none",
      secrets: [],
    });
    expect(() =>
      assertCapabilitiesWithinAuthority(
        { fs: "workspace-write", shell: false, network: "none", secrets: [] },
        child,
        "spawned child",
      ),
    ).toThrow(CapabilityCeilingError);
  });
});
