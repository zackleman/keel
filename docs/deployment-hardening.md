# Remote deployment hardening

Keel workflow source is untrusted by default on a remote deployment. In the first remote
deployment model, **the server is the sandbox**: Keel's realm confines workflow-body code,
and submitter ceilings restrict agent and host-command authority, but the durable security
boundary is the dedicated box.

## Recommended topology

1. Provision a dedicated, rebuildable Linux VM or container. Do not colocate personal
   workloads or credentials.
2. Create a dedicated, non-privileged `keel` user. Run both the daemon and optional web
   transport as that user with systemd. Do not forward an SSH agent into the service.
3. Put the journal, definition cache, and per-run workspace store on a disposable volume.
   Back up only durable state that the team intentionally needs.
4. Bootstrap a separate submitter token with `KEEL_SUBMITTER_TOKEN`. Keep
   `KEEL_ADMIN_TOKEN` only in supervisor/operator configuration. Submitted one-offs use
   the `untrusted-default` ceiling; reviewed escalation is granted through
   `decide_approval`.
5. Expose no public listener. Join the box to the team's Tailscale network and restrict
   ingress with Tailscale ACLs. Reach `keel mcp` through SSH-exec stdio. If the web
   transport is enabled, bind it only on the private interface and apply the service
   guidance in `USAGE.md`.
6. Enforce host-level egress filtering. Allow only required model-provider APIs, source
   hosts, DNS, and update endpoints. Keel's network capability is advisory without this
   firewall.
7. Install only the provider credentials required by the box. Do not copy personal cloud
   credentials, general-purpose SSH keys, browser profiles, or developer dotfiles.
8. Keep an image/bootstrap script and practice rebuilding the VM. Treat the host as cattle:
   rotate tokens, replace the disposable volume, and reprovision after suspected compromise.

A minimal systemd service should set a fixed `User=keel`, an explicit `WorkingDirectory`,
a narrow environment file, `NoNewPrivileges=true`, and restart-on-failure. Filesystem
hardening directives must still permit the configured journal, cache, and workspace paths.

## Submission operations

- Laptop agents submit one-off captured source with the submitter token. A submitter token
  does not grant `workflow:run`; saved workflows require a separate workflow-scoped credential.
- Declarations above the credential's named ceiling fail at launch with
  `capability_ceiling_exceeded`; Keel does not silently downgrade them.
- A workflow that needs more authority parks with `ctx.human({ requestedCaps })`. An
  administrator reviews the request and supplies `grantedCaps` through MCP
  `decide_approval`. The decision and grant are durable approval data.
- When any submitter credential is configured, every promotion to `name@version` requires
  an approved dedicated `review:` gate, including source that has never run. The promoted
  source must hash to the exact definition executed by the review run; an ordinary in-workflow
  gate such as `ship` cannot authorize promotion. Registry definition hashes remain immutable.
- `keel gc` removes expired terminal one-off archives after seven days by default, then
  prunes unreferenced definitions. Saved workflow runs and definitions are exempt.

## Future Linux backstop

Per-agent bubblewrap or Landlock confinement is a useful future defense-in-depth option.
It is not part of this deployment phase and should not be represented as an existing Keel
guarantee.

## Residual risk

A run granted write or command capabilities acts as the daemon user on this box. Provider
tool flags are not an OS jail. Network capability remains advisory until the host egress
firewall backs it. A compromised granted-capability run may read or alter anything the
daemon user can access. The containment boundary is the dedicated box, not the Keel
process.
