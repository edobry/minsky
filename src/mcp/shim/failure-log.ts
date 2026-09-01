/**
 * Durable record of a CLIENT-side daemon failure (mt#4828).
 *
 * The daemon instruments its own deaths well — `staleness_exit`, `signal_*`
 * and friends all land in `mcp-disconnect-log.json` with a cause and an
 * uptime. What nothing recorded is the other half of the same event: the tool
 * call that was in flight and died with it. That trace existed only as an
 * error string inside one agent's transcript, so the cadence of
 * caller-visible failures was unmeasurable even while the daemon-side cadence
 * was well measured — which is how a defect that fires several times an hour
 * went unquantified until someone happened to notice it twice in one session.
 *
 * WHERE IT LANDS, and why it is the same file. Records go into the ACTIVE
 * disconnect log, `<stateDir>/mcp-disconnect-log.json`, under their own
 * `kind: "client_failure"`. That is deliberate rather than convenient: the
 * existing sweep (`disconnect-event-sweep.ts`) filters strictly on
 * `candidate.kind !== "disconnect"`, so a new kind is INERT for every current
 * reader — it cannot corrupt the projection or inflate a row count — while
 * still sitting in the one file the log→`system_events` pipeline already
 * owns. mt#4654 is repairing that pipeline; when it extends to this kind, the
 * records are already there and already correlated by timestamp with the
 * daemon-side row for the same event. Writing a separate file instead would
 * have created exactly the second ingest path mt#4828's SC4 rules out.
 *
 * Segment rolling is NOT this module's job. The active path is stable by
 * design (`disconnect-log-segments.ts`: "Name and path unchanged"), and the
 * daemon rolls it; the shim only ever appends to the active file.
 *
 * NEVER THROWS, and that is the load-bearing property. This is a diagnostic
 * on the failure path — it runs when something has ALREADY gone wrong, and
 * the caller is mid-`catch` composing the JSON-RPC error the client will
 * receive. An exception here would replace a real, classified daemon failure
 * with an unrelated filesystem error, which is strictly worse than having no
 * record at all. `main.ts` learned this exact lesson with its stderr
 * diagnostic write (PR #3038 R1: "a diagnostic must never be able to change
 * what the client receives"); this module encodes it rather than relying on
 * the caller to wrap every call.
 */

import fs from "node:fs";
import path from "node:path";
import { getMinskyStateDir } from "@minsky/shared/paths";
import type { DaemonFailureKind } from "./client";

/** Filename of the ACTIVE disconnect log — see `disconnect-log-segments.ts`. */
const ACTIVE_LOG_FILENAME = "mcp-disconnect-log.json";

/**
 * Discriminator for these records. Distinct from the daemon's own
 * `disconnect` / `process_start` / `reconnect` kinds so existing readers skip
 * it (see this module's header) and a future reader can select it.
 */
const CLIENT_FAILURE_KIND = "client_failure";

export interface FailureLogDeps {
  /** Injected for tests — defaults to the real `fs.appendFileSync`. */
  appendFileSync?: typeof fs.appendFileSync;
  /** Injected for tests — defaults to `getMinskyStateDir()`. */
  stateDir?: string;
  /** Injected for tests — defaults to `Date.now()`. */
  nowMs?: number;
}

/** One appended line. Field names mirror the daemon's rows where they overlap. */
export interface ClientFailureRecord {
  kind: typeof CLIENT_FAILURE_KIND;
  timestamp: string;
  /** The classified failure, so this is aggregatable without parsing prose. */
  failureKind: DaemonFailureKind;
  /** JSON-RPC method that died — `tools/call`, `initialize`, … */
  method: string;
  /** Tool name when the client supplied one; absent otherwise. */
  toolName?: string;
  /** The underlying error text, for correlation with a daemon-side row. */
  error: string;
}

/**
 * Append one client-failure record to the active disconnect log.
 *
 * `toolName` is read from `params.name` when present. That is the ONE piece of
 * request shape this module looks at, and it is deliberately not a widening of
 * the thin-shim posture ADR-038 sets: the name is what makes a record
 * actionable ("which tool died"), it is a fixed field of the MCP `tools/call`
 * envelope rather than anything application-specific, and nothing branches on
 * its value — it is recorded, never interpreted. The shim still forms no
 * opinion about what any given tool does, which is the property ADR-038
 * actually protects.
 */
export function recordClientFailure(
  input: {
    failureKind: DaemonFailureKind;
    method: string;
    toolName?: string;
    error: string;
  },
  deps: FailureLogDeps = {}
): void {
  try {
    const appendFileSync = deps.appendFileSync ?? fs.appendFileSync;
    const filePath = path.join(deps.stateDir ?? getMinskyStateDir(), ACTIVE_LOG_FILENAME);
    const record: ClientFailureRecord = {
      kind: CLIENT_FAILURE_KIND,
      timestamp: new Date(deps.nowMs ?? Date.now()).toISOString(),
      failureKind: input.failureKind,
      method: input.method,
      ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
      error: input.error,
    };
    // One line, one write. `appendFileSync` opens with O_APPEND, so a record
    // cannot interleave with the daemon's concurrent writes to the same file
    // at this size — the same assumption the daemon's own append-only
    // persistence already makes (mt#1682).
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // intentional-swallow: see this module's header. A diagnostic on the
    // failure path must never displace the failure it is describing, and
    // there is nowhere to report a failed record-write except the file that
    // just failed.
  }
}
