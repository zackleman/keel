// Checkpoint feed: an ordered progress timeline for a run. Frames come from the
// durable "checkpoint" events already streamed to the console (payload
// { stableKey, attempt, message, data }), mirroring the supervisor MCP
// `tail_checkpoints` tool. Rendering off the merged event stream means the feed
// live-updates through the existing SSE wiring with no extra data plumbing.
import type { EventStreamFrame } from "../api/types";
import { StatusPill, formatTime } from "./controls";

export interface CheckpointFrame {
  seq: number;
  atMs: number;
  message: string;
  data: unknown;
}

// Pretty-printed `data` beyond this many characters collapses behind a toggle so
// a large payload does not dominate the timeline.
const COLLAPSE_THRESHOLD = 160;

/**
 * Extract checkpoint frames from a run's event stream in stream order. The caller
 * passes the already-merged (tail + live) frames, which are ordered by sequence,
 * so the returned frames preserve append order.
 */
export function checkpointFrames(events: EventStreamFrame[]): CheckpointFrame[] {
  const frames: CheckpointFrame[] = [];
  for (const event of events) {
    if (event.kind !== "durable" || event.type !== "checkpoint") continue;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;
    const message =
      "message" in payload && typeof payload.message === "string" ? payload.message : "";
    const data = "data" in payload ? (payload as { data: unknown }).data : null;
    frames.push({ seq: event.seq, atMs: event.atMs, message, data });
  }
  return frames;
}

export function CheckpointFeed({ frames }: { frames: CheckpointFrame[] }) {
  return (
    <ol className="checkpoint-feed">
      {frames.map((frame) => (
        <li className="checkpoint-item" key={frame.seq}>
          <span className="timeline-dot dot-info" />
          <div className="checkpoint-body">
            <div className="checkpoint-main">
              <span className="checkpoint-message">{frame.message || "(no message)"}</span>
            </div>
            <div className="checkpoint-meta">
              <StatusPill tone="neutral">#{frame.seq}</StatusPill>
              <span className="mono">{formatTime(frame.atMs)}</span>
            </div>
            <CheckpointData data={frame.data} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function CheckpointData({ data }: { data: unknown }) {
  if (data === null || data === undefined) return null;
  const json = JSON.stringify(data, null, 2);
  if (json.length <= COLLAPSE_THRESHOLD) {
    return <pre className="code-block json-block checkpoint-data">{json}</pre>;
  }
  return (
    <details className="checkpoint-data-details">
      <summary>data</summary>
      <pre className="code-block json-block checkpoint-data">{json}</pre>
    </details>
  );
}
