/**
 * Guard-Health Tracker (mt#2812)
 *
 * The src/-side read+aggregate layer for the guard-health JSONL log
 * (`~/.local/state/minsky/guard-health-log.jsonl`), consumed by
 * `mcp__minsky__debug_systemInfo` under `guardHealth`. Makes guard-layer
 * failures a visible, escalating signal instead of silent fail-open permits.
 *
 * Architectural precedent (deliberately copied, per the task spec):
 * `src/mcp/disconnect-tracker.ts` (mt#1645/1682) and
 * `src/mcp/subagent-dispatch-tracker.ts` (mt#1735-1738) — same shape:
 * append-only log + aggregate surface + threshold escalation.
 *
 * Write side: `.minsky/hooks/guard-health.ts`'s `recordGuardError` /
 * `recordGuardCheckSkip`, called from `dispatcher.ts`'s guard-loop catch
 * block (automatic, for every ADR-028-migrated guard) and from standalone
 * hooks' own catch blocks. That module is DELIBERATELY NOT imported here —
 * the root `tsconfig.json`'s "include" is `["src", "types", "tests", ...]`,
 * `.minsky/` is not part of that program, and `.minsky/hooks/` is
 * intentionally self-contained (its own SPEC.md invariant: hooks keep
 * working even when the main codebase has type errors). This module
 * duplicates the read+aggregate logic instead, reading the SAME on-disk
 * JSONL file by filename convention. Precedent for duplication-over-
 * cross-import: `.minsky/hooks/mcp-daemon-staleness-detector.ts` inlines
 * its own daemon-state reader rather than importing
 * `src/mcp/daemon-state.ts`, for the same reason in the opposite direction.
 *
 * Read semantics: guard processes are SHORT-LIVED (a fresh Bun process per
 * hook event, not a long-running server), so — unlike `DisconnectTracker`'s
 * in-memory ring buffer, built up across one server process's lifetime —
 * this tracker keeps no persistent in-memory event list. Every
 * `getSummary()` call re-reads the log fresh from disk, because the events
 * it aggregates were written by many OTHER processes, not this one.
 *
 * @see mt#2812 — this task
 * @see src/mcp/disconnect-tracker.ts — architectural precedent
 * @see src/mcp/subagent-dispatch-tracker.ts — architectural precedent
 * @see .minsky/hooks/guard-health.ts — the write side + the hooks-tree's own
 *      copy of this read+aggregate logic (kept in sync manually; see that
 *      module's header comment for the cross-boundary rationale)
 * @see src/adapters/shared/commands/debug.ts — the `debug.systemInfo` integration point
 */

import fs from "fs";
import path from "path";
import os from "os";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Persisted event shape (must match .minsky/hooks/guard-health.ts's GuardHealthEvent)
// ---------------------------------------------------------------------------

export type GuardHealthEventKind = "error" | "check-skip";

export interface GuardHealthEvent {
  timestamp: string;
  guardName: string;
  event: string;
  kind: GuardHealthEventKind;
  errorClass?: string;
  message: string;
  toolName?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Escalation thresholds — MUST stay in sync with .minsky/hooks/guard-health.ts
// ---------------------------------------------------------------------------
//
// Grounded per the mt#2812 spec's explicit calibration ("a gate that errors
// on 3+ consecutive fires is already pathological per this week's data") and
// decision-defaults.mdc §Thresholds ("burst-detection windows: 24h").

/** Gap (ms) beyond which two consecutive failures for the same guard start a new streak. */
export const STREAK_RESET_GAP_MS = 24 * 60 * 60 * 1000;

/** Streak > this threshold (i.e. 2+ consecutive failures) -> "attention". */
export const ATTENTION_STREAK_THRESHOLD = 1;

/** Streak > this threshold (i.e. 3+ consecutive failures) -> "critical". */
export const CRITICAL_STREAK_THRESHOLD = 2;

export type GuardEscalation = "none" | "attention" | "critical";

export interface GuardHealthEntry {
  failureCount24h: number;
  failureCount7d: number;
  consecutiveStreak: number;
  lastEvent: GuardHealthEvent | null;
  escalation: GuardEscalation;
}

export interface GuardHealthSummary {
  byGuard: Record<string, GuardHealthEntry>;
  criticalGuards: string[];
  attentionGuards: string[];
  escalation: GuardEscalation;
}

function guardEscalationFor(streak: number): GuardEscalation {
  if (streak > CRITICAL_STREAK_THRESHOLD) return "critical";
  if (streak > ATTENTION_STREAK_THRESHOLD) return "attention";
  return "none";
}

/** Pure aggregation — given events + "now", compute the summary. Exported for direct unit testing. */
export function computeGuardHealthSummary(
  events: readonly GuardHealthEvent[],
  now: Date = new Date()
): GuardHealthSummary {
  const nowMs = now.getTime();
  const cutoff24h = nowMs - 24 * 60 * 60 * 1000;
  const cutoff7d = nowMs - 7 * 24 * 60 * 60 * 1000;

  const byGuardEvents = new Map<string, GuardHealthEvent[]>();
  for (const ev of events) {
    const arr = byGuardEvents.get(ev.guardName) ?? [];
    arr.push(ev);
    byGuardEvents.set(ev.guardName, arr);
  }

  const byGuard: Record<string, GuardHealthEntry> = {};
  const criticalGuards: string[] = [];
  const attentionGuards: string[] = [];

  for (const [guardName, guardEvents] of byGuardEvents) {
    const sorted = [...guardEvents].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const failureCount24h = sorted.filter(
      (e) => new Date(e.timestamp).getTime() >= cutoff24h
    ).length;
    const failureCount7d = sorted.filter((e) => new Date(e.timestamp).getTime() >= cutoff7d).length;

    let streak = sorted.length > 0 ? 1 : 0;
    for (let i = sorted.length - 1; i > 0; i--) {
      const cur = sorted[i];
      const prev = sorted[i - 1];
      if (!cur || !prev) break;
      const gap = new Date(cur.timestamp).getTime() - new Date(prev.timestamp).getTime();
      if (gap <= STREAK_RESET_GAP_MS) {
        streak++;
      } else {
        break;
      }
    }

    const escalation = guardEscalationFor(streak);
    const lastEvent = sorted.length > 0 ? (sorted[sorted.length - 1] ?? null) : null;

    byGuard[guardName] = {
      failureCount24h,
      failureCount7d,
      consecutiveStreak: streak,
      lastEvent,
      escalation,
    };

    if (escalation === "critical") criticalGuards.push(guardName);
    else if (escalation === "attention") attentionGuards.push(guardName);
  }

  const escalation: GuardEscalation =
    criticalGuards.length > 0 ? "critical" : attentionGuards.length > 0 ? "attention" : "none";

  return { byGuard, criticalGuards, attentionGuards, escalation };
}

function isValidEvent(item: unknown): item is GuardHealthEvent {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r.timestamp === "string" &&
    typeof r.guardName === "string" &&
    typeof r.event === "string" &&
    (r.kind === "error" || r.kind === "check-skip") &&
    typeof r.message === "string"
  );
}

/** Directory where the persistent guard-health log is written (mirrors disconnect-tracker.ts's getStateDir). */
function getStateDir(): string {
  const envDir = process.env.MINSKY_STATE_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".local", "state", "minsky");
}

/** Path to the persistent guard-health event log. */
function getLogPath(): string {
  return path.join(getStateDir(), "guard-health-log.jsonl");
}

/**
 * Public accessor for the persistent guard-health log path — for tests and
 * any future consumer that needs to locate the file (mirrors
 * `getDisconnectLogPath` in disconnect-tracker.ts).
 */
export function getGuardHealthLogPath(): string {
  return getLogPath();
}

/**
 * GuardHealthTracker — read-only singleton over the on-disk guard-health
 * JSONL log.
 *
 * Unlike `DisconnectTracker`, this tracker holds NO events in memory across
 * calls — `getSummary()` re-reads the log fresh from disk every time,
 * because guard-health events are written by many short-lived hook
 * processes, not by this MCP server process. The "singleton" here exists
 * only so `debug.ts` can call `GuardHealthTracker.getInstance()` with the
 * same API shape as `DisconnectTracker.getInstance()` /
 * `SubagentDispatchTracker.getInstance()` — there is no per-instance state
 * that would make repeated instantiation unsafe or wasteful either way.
 *
 * Fail-safe: `getSummary()` never throws. A missing/unreadable log file
 * (tracker unavailable) degrades to the zero-filled summary — guards keep
 * running normally regardless (mt#2812 acceptance test).
 */
export class GuardHealthTracker {
  private static _instance: GuardHealthTracker | null = null;

  private readonly logPathOverride?: string;

  constructor(logPathOverride?: string) {
    this.logPathOverride = logPathOverride;
  }

  static getInstance(): GuardHealthTracker {
    if (!GuardHealthTracker._instance) {
      GuardHealthTracker._instance = new GuardHealthTracker();
    }
    return GuardHealthTracker._instance;
  }

  /** Reset the singleton for tests — optionally pointing at a fixture log path. */
  static resetForTest(logPathOverride?: string): GuardHealthTracker {
    GuardHealthTracker._instance = new GuardHealthTracker(logPathOverride);
    return GuardHealthTracker._instance;
  }

  private readEvents(): GuardHealthEvent[] {
    const logPath = this.logPathOverride ?? getLogPath();
    try {
      if (!fs.existsSync(logPath)) return [];
      const raw = fs.readFileSync(logPath, { encoding: "utf-8" }) as string;
      const events: GuardHealthEvent[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isValidEvent(parsed)) events.push(parsed);
        } catch {
          // skip malformed line
        }
      }
      return events;
    } catch (err) {
      log.debug("guard_health_tracker: failed to read guard-health log (non-fatal)", {
        path: logPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Compute the current guard-health summary. Fail-safe — never throws.
   */
  getSummary(now: Date = new Date()): GuardHealthSummary {
    try {
      const events = this.readEvents();
      return computeGuardHealthSummary(events, now);
    } catch (err) {
      log.warn("guard_health_tracker: getSummary failed, returning zero-filled default", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { byGuard: {}, criticalGuards: [], attentionGuards: [], escalation: "none" };
    }
  }
}
