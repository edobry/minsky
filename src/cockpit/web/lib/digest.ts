/**
 * digest.ts — Tier-2 cross-session digest derivation (mt#2869).
 *
 * Pure grouping/summarization over `/api/activity` rows: a day's system
 * events become per-workstream Tier-1-shaped summaries (what happened /
 * exceptions / where it stands) the DigestPage renders. Derivation only —
 * no fetching, no rendering — so the whole shape is unit-testable.
 *
 * Honest-data discipline (plant-board canon): the digest renders ONLY what
 * the event log actually recorded. Event types without live producers simply
 * never appear; nothing is synthesized.
 */

/** Row shape `/api/activity` returns (system_events columns, camelCased). */
export interface DigestEventRow {
  id: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  relatedTaskId?: string | null;
  relatedSessionId?: string | null;
  actor?: string | null;
  createdAt: string;
}

/** An exception line — the "what you need to know" slot of the group. */
export interface DigestException {
  eventType: string;
  /** Short human line, e.g. `deploy FAILED (minsky-mcp)` or `hook blocked: bypass-merge`. */
  label: string;
  at: string;
}

/** Per-workstream (task-grouped) digest entry. */
export interface DigestGroup {
  /** Grouping key: the task id (`mt#…`) or "fleet" for unattributed events. */
  key: string;
  taskId: string | null;
  /** Best-effort title, from the richest payload seen (changeset.created carries one). */
  title: string | null;
  /** Compressed what-happened counts, rendered as the group's summary line. */
  counts: {
    statusChanges: number;
    changesetsOpened: number;
    prsMerged: number;
    asksCreated: number;
    asksAnswered: number;
    sessionsStarted: number;
    memories: number;
    deploys: number;
    other: number;
  };
  /** PR numbers seen in this group (opened or merged), for deeplinks. */
  prNumbers: number[];
  /** The task's most recent status transition of the window, e.g. "DONE". */
  latestStatus: string | null;
  /** Exceptions — deploy failures, blocked hook firings, failed subagents. */
  exceptions: DigestException[];
  eventCount: number;
  firstAt: string;
  lastAt: string;
}

/** Key for events not attributable to any task. */
export const FLEET_GROUP_KEY = "fleet";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Resolve the grouping task id for one event row. */
export function groupKeyFor(row: DigestEventRow): string {
  const payload = row.payload ?? {};
  return str(row.relatedTaskId) ?? str(payload["taskId"]) ?? FLEET_GROUP_KEY;
}

/** Classify one row into an exception line, or null when routine. */
export function exceptionFor(row: DigestEventRow): DigestException | null {
  const payload = row.payload ?? {};
  switch (row.eventType) {
    case "deploy.fail": {
      const service = str(payload["service"]) ?? "unknown service";
      return { eventType: row.eventType, label: `deploy FAILED (${service})`, at: row.createdAt };
    }
    case "subagent.failed": {
      return { eventType: row.eventType, label: "subagent failed", at: row.createdAt };
    }
    case "hook.fired": {
      // Only blocked/overridden guard firings are exceptions; the guard layer
      // working quietly is routine.
      const decision = str(payload["decision"]);
      if (decision !== "blocked" && decision !== "overridden") return null;
      const hook = str(payload["hook"]) ?? "guard";
      return { eventType: row.eventType, label: `${hook} ${decision}`, at: row.createdAt };
    }
    case "embeddings.provider_degraded": {
      return { eventType: row.eventType, label: "embeddings provider degraded", at: row.createdAt };
    }
    case "task.status_changed": {
      const to = str(payload["newStatus"]);
      if (to !== "BLOCKED") return null;
      return { eventType: row.eventType, label: "task BLOCKED", at: row.createdAt };
    }
    default:
      return null;
  }
}

/**
 * Group a day's events into per-workstream digest entries, most-active
 * first, with the fleet-level bucket (unattributed events) always last.
 * Input order does not matter; rows are re-sorted by `createdAt` internally.
 */
export function buildDigest(rows: DigestEventRow[]): DigestGroup[] {
  const sorted = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const groups = new Map<string, DigestGroup>();

  for (const row of sorted) {
    const key = groupKeyFor(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        taskId: key === FLEET_GROUP_KEY ? null : key,
        title: null,
        counts: {
          statusChanges: 0,
          changesetsOpened: 0,
          prsMerged: 0,
          asksCreated: 0,
          asksAnswered: 0,
          sessionsStarted: 0,
          memories: 0,
          deploys: 0,
          other: 0,
        },
        prNumbers: [],
        latestStatus: null,
        exceptions: [],
        eventCount: 0,
        firstAt: row.createdAt,
        lastAt: row.createdAt,
      };
      groups.set(key, group);
    }

    group.eventCount += 1;
    group.lastAt = row.createdAt;

    const payload = row.payload ?? {};
    switch (row.eventType) {
      case "task.status_changed": {
        group.counts.statusChanges += 1;
        // Rows are time-sorted, so the last write wins — the group's
        // "where it stands" slot.
        group.latestStatus = str(payload["newStatus"]) ?? group.latestStatus;
        break;
      }
      case "changeset.created": {
        group.counts.changesetsOpened += 1;
        group.title = group.title ?? str(payload["title"]);
        const pr = num(payload["prNumber"]);
        if (pr !== null && !group.prNumbers.includes(pr)) group.prNumbers.push(pr);
        break;
      }
      case "pr.merged": {
        group.counts.prsMerged += 1;
        const pr = num(payload["prNumber"]);
        if (pr !== null && !group.prNumbers.includes(pr)) group.prNumbers.push(pr);
        break;
      }
      case "ask.created": {
        group.counts.asksCreated += 1;
        break;
      }
      case "ask.answered":
      case "ask.policy_closed": {
        group.counts.asksAnswered += 1;
        break;
      }
      case "session.started": {
        group.counts.sessionsStarted += 1;
        break;
      }
      case "memory.created": {
        group.counts.memories += 1;
        break;
      }
      case "deploy.build":
      case "deploy.smoke":
      case "deploy.live":
      case "deploy.fail": {
        group.counts.deploys += 1;
        break;
      }
      default: {
        group.counts.other += 1;
        break;
      }
    }

    const exception = exceptionFor(row);
    if (exception) group.exceptions.push(exception);
  }

  const list = [...groups.values()];
  // Most-active workstreams first; the fleet bucket pinned last regardless of
  // volume — unattributed churn must never outrank attributable work.
  list.sort((a, b) => {
    if (a.key === FLEET_GROUP_KEY) return 1;
    if (b.key === FLEET_GROUP_KEY) return -1;
    return b.eventCount - a.eventCount;
  });
  return list;
}

/**
 * Render the group's what-happened counts as one compact summary sentence
 * fragment, omitting zero-count clauses. Empty string when nothing countable
 * happened (a group can exist purely on `other` events).
 */
export function summarizeCounts(counts: DigestGroup["counts"]): string {
  const parts: string[] = [];
  if (counts.prsMerged > 0)
    parts.push(`${counts.prsMerged} PR${counts.prsMerged > 1 ? "s" : ""} merged`);
  if (counts.changesetsOpened > 0) parts.push(`${counts.changesetsOpened} opened`);
  if (counts.statusChanges > 0)
    parts.push(`${counts.statusChanges} status change${counts.statusChanges > 1 ? "s" : ""}`);
  if (counts.sessionsStarted > 0)
    parts.push(`${counts.sessionsStarted} session${counts.sessionsStarted > 1 ? "s" : ""} started`);
  if (counts.asksCreated > 0)
    parts.push(`${counts.asksCreated} ask${counts.asksCreated > 1 ? "s" : ""} raised`);
  if (counts.asksAnswered > 0) parts.push(`${counts.asksAnswered} resolved`);
  if (counts.memories > 0)
    parts.push(`${counts.memories} memor${counts.memories > 1 ? "ies" : "y"} saved`);
  if (counts.deploys > 0)
    parts.push(`${counts.deploys} deploy event${counts.deploys > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

/** [since, until) ISO bounds for the local calendar day `offset` days back (0 = today). */
export function dayWindow(
  offset: number,
  now: Date = new Date()
): { since: string; until: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset + 1);
  return { since: start.toISOString(), until: end.toISOString() };
}
