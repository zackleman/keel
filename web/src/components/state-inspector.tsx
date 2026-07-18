// State inspector: the current folded ctx.state values, grouped namespace -> name
// -> latest value. This is the same last-write-wins view the supervisor MCP
// `get_state` tool returns; the daemon already exposes it as `run.state` on the
// projection, so we render that snapshot directly rather than folding raw
// state_write history in the client.
import type { RunStateSnapshot } from "../api/types";
import { JsonBlock } from "./controls";

/** True when any namespace holds at least one folded value. */
export function hasStateWrites(state: RunStateSnapshot | undefined | null): boolean {
  if (!state) return false;
  return Object.values(state).some((names) => Object.keys(names).length > 0);
}

export function StateInspector({ state }: { state: RunStateSnapshot }) {
  const namespaces = Object.entries(state).filter(([, names]) => Object.keys(names).length > 0);
  return (
    <div className="state-inspector">
      {namespaces.map(([namespace, names]) => (
        <section className="state-namespace" key={namespace}>
          <h3 className="state-namespace-name mono">{namespace}</h3>
          <dl className="state-entries">
            {Object.entries(names).map(([name, value]) => (
              <div className="state-entry" key={name}>
                <dt className="mono">{name}</dt>
                <dd>
                  <JsonBlock value={value} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
