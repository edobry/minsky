/**
 * S3 gauges widget (mt#2590)
 *
 * Feeds the S3 · Management node's three mini-gauge instruments on the plant
 * board (PlantFlowPage.tsx). Before this widget, the gauges rendered literal
 * hardcoded needle/setpoint fractions styled as live data — this widget wires
 * two of the three to real sources; the third is an honest gap (see below).
 *
 * - `mcpDisconnects` — escalation-eligible MCP disconnects in the last 24h,
 *   read directly from the append-only JSONL log
 *   (`~/.local/state/minsky/mcp-disconnect-log.json`) documented in
 *   CLAUDE.md "MCP disconnect cadence and escalation threshold". This widget
 *   deliberately does NOT import `src/mcp/disconnect-tracker.ts` (a different
 *   process's singleton, with heavier transitive imports); it re-implements
 *   the small "escalation-eligible" predicate directly from the documented
 *   log contract, matching the CLAUDE.md "Quick consumer commands" pattern.
 * - `subagentDispatches` — partial-uncommitted-no-handoff count for the most
 *   recently active parent session, via the exact SQL pattern documented in
 *   CLAUDE.md "Subagent dispatch cadence and escalation threshold" (SQL
 *   inspection patterns section), queried against the `subagent_invocations`
 *   table through the shared persistence connection (same pattern as
 *   embeddings-health.ts).
 * - `attention` — NO HTTP surface exists today for `attention_report` (an
 *   MCP-tool-only surface); this field is always null. Per mt#2590's
 *   documented escape hatch, the frontend renders an honest placeholder
 *   (flat needle, "—" sublabel) for this one instrument rather than fake it.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { promises as fsPromises, existsSync } from "fs";
import * as path from "path";
import * as os from "os";
import { getSharedPersistenceService } from "../shared-persistence";

// ---------------------------------------------------------------------------
// Payload shape — mirrored by useS3Gauges.ts on the frontend.
// ---------------------------------------------------------------------------

export interface S3GaugesPayload {
  mcpDisconnects: {
    /** Escalation-eligible disconnects in the last 24h, or null if the log is unreadable. */
    eligibleCount24h: number | null;
    /** CLAUDE.md-documented daily escalation threshold (fires above this count). */
    threshold: number;
  };
  subagentDispatches: {
    /** partial-uncommitted-no-handoff count for the most recent parent session, or null if the DB is unreachable. */
    partialUncommittedCount: number | null;
    /** CLAUDE.md-documented per-session escalation threshold (fires above this count). */
    threshold: number;
  };
  attention: {
    /** No HTTP surface exists for attention_report today (mt#2590 documented gap). Always null. */
    value: null;
  };
}

/** CLAUDE.md "Recurrence-threshold escalation": daily fires above 3 eligible disconnects/24h. */
const MCP_DISCONNECT_DAILY_THRESHOLD = 3;
/** CLAUDE.md "Escalation rule": session fires above 2 partial-uncommitted dispatches. */
const SUBAGENT_SESSION_THRESHOLD = 2;

const SERVER_INITIATED_CAUSES = new Set([
  "staleness_exit",
  "signal_sigterm",
  "signal_sigint",
  "signal_sighup",
  "server_close",
  "idle_timeout",
]);
const SHORT_LIVED_THRESHOLD_MS = 5000;

export interface DisconnectLogEvent {
  kind: string;
  cause?: string;
  timestamp: string;
  uptimeMs?: number;
  processRole?: string;
}

/**
 * Runtime type guard for a parsed JSONL line. The log is written by a
 * different process (the MCP server) under a documented but external
 * contract (CLAUDE.md), so a parsed value is untrusted input — validate
 * field presence/types before treating it as a `DisconnectLogEvent` rather
 * than blindly casting.
 */
export function isDisconnectLogEvent(value: unknown): value is DisconnectLogEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== "string") return false;
  if (typeof v.timestamp !== "string") return false;
  if (v.cause !== undefined && typeof v.cause !== "string") return false;
  if (v.uptimeMs !== undefined && typeof v.uptimeMs !== "number") return false;
  if (v.processRole !== undefined && typeof v.processRole !== "string") return false;
  return true;
}

export function isEscalationEligible(event: DisconnectLogEvent): boolean {
  if (event.kind !== "disconnect") return false;
  if (typeof event.cause === "string" && SERVER_INITIATED_CAUSES.has(event.cause)) return false;
  if (typeof event.uptimeMs === "number" && event.uptimeMs < SHORT_LIVED_THRESHOLD_MS) return false;
  // Legacy events without processRole are counted conservatively as eligible (CLAUDE.md).
  if (event.processRole === "helper") return false;
  return true;
}

/**
 * Bound on how many trailing lines of the (unbounded, append-only) JSONL log
 * are parsed per poll. The log is never truncated on disk (CLAUDE.md:
 * "append-only JSONL"), so a long-lived server can accumulate a large file
 * over weeks/months even though the in-process tracker only keeps the last
 * 500 events in memory. Only the trailing window can possibly fall inside
 * the 24h lookback this widget cares about, so parsing is capped at this
 * many trailing lines regardless of total file size — bounding CPU work per
 * poll independent of how large the on-disk log has grown.
 */
const MAX_LOG_LINES_SCANNED = 2000;

/** Default on-disk location of the MCP disconnect JSONL log (CLAUDE.md). */
export function defaultDisconnectLogPath(): string {
  return path.join(os.homedir(), ".local", "state", "minsky", "mcp-disconnect-log.json");
}

/**
 * Injectable filesystem seam for readMcpDisconnectEligibleCount24h — tests
 * pass an in-memory fake (e.g. via `createMockFilesystem`) instead of
 * touching a real file, per the project's dependency-injection convention
 * for filesystem access in tests (`custom/no-real-fs-in-tests`).
 */
export interface DisconnectLogReaderDeps {
  exists: (path: string) => boolean;
  /** Reads the whole file as a UTF-8 string. */
  readFile: (path: string) => Promise<string>;
}

const defaultDisconnectLogReaderDeps: DisconnectLogReaderDeps = {
  exists: existsSync,
  readFile: async (p) => (await fsPromises.readFile(p, { encoding: "utf-8" })) as string,
};

/**
 * Read the MCP disconnect JSONL log and count escalation-eligible disconnects
 * in the last 24h. Returns null if the log is missing or unreadable — this is
 * a genuine "no data" state, not a zero. Async (non-blocking) file read, and
 * bounded to the trailing MAX_LOG_LINES_SCANNED lines so a long-lived,
 * ever-growing append-only log can't make this poll slow.
 *
 * @param logPathOverride Test seam — defaults to the real CLAUDE.md-documented path.
 * @param deps Test seam — defaults to the real filesystem.
 */
export async function readMcpDisconnectEligibleCount24h(
  logPathOverride?: string,
  deps: DisconnectLogReaderDeps = defaultDisconnectLogReaderDeps
): Promise<number | null> {
  try {
    const logPath = logPathOverride ?? defaultDisconnectLogPath();
    if (!deps.exists(logPath)) return null;
    const raw = await deps.readFile(logPath);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const allLines = raw.split(/\r?\n/);
    const lines = allLines.slice(-MAX_LOG_LINES_SCANNED);
    let count = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("]")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isDisconnectLogEvent(parsed)) continue;
      const ts = new Date(parsed.timestamp).getTime();
      if (Number.isNaN(ts) || ts < cutoff) continue;
      if (isEscalationEligible(parsed)) count++;
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Query `subagent_invocations` for the partial-uncommitted-no-handoff count
 * scoped to the most recently active parent session — the exact SQL pattern
 * documented in CLAUDE.md's "Subagent dispatch cadence" SQL inspection block.
 * Returns null when SQL is unavailable or the table doesn't exist yet.
 */
async function readSubagentPartialUncommittedCount(): Promise<number | null> {
  try {
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();
    if (!provider.capabilities.sql) return null;
    const rawSql = await provider.getRawSqlConnection?.();
    if (!rawSql) return null;
    const sql = rawSql as import("postgres").Sql;
    const rows = await sql`
      SELECT COUNT(*)::int AS partial_uncommitted_count
      FROM subagent_invocations
      WHERE parent_session_id = (
        SELECT parent_session_id
        FROM subagent_invocations
        WHERE parent_session_id IS NOT NULL
        ORDER BY started_at DESC
        LIMIT 1
      )
      AND outcome = 'partial-uncommitted-no-handoff'
    `;
    const row = (rows[0] ?? {}) as { partial_uncommitted_count?: number };
    return row.partial_uncommitted_count ?? 0;
  } catch {
    return null;
  }
}

export const s3GaugesWidget: WidgetModule = {
  id: "s3-gauges",
  title: "S3 Gauges",
  updateMode: { type: "polling", intervalMs: 30_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      const [eligibleCount24h, partialUncommittedCount] = await Promise.all([
        readMcpDisconnectEligibleCount24h(),
        readSubagentPartialUncommittedCount(),
      ]);

      const payload: S3GaugesPayload = {
        mcpDisconnects: { eligibleCount24h, threshold: MCP_DISCONNECT_DAILY_THRESHOLD },
        subagentDispatches: {
          partialUncommittedCount,
          threshold: SUBAGENT_SESSION_THRESHOLD,
        },
        attention: { value: null },
      };

      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `s3-gauges error: ${message}` };
    }
  },
};
