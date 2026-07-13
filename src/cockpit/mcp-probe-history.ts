/**
 * Rolling probe-history store for the hosted MCP-server status widget (mt#2077).
 *
 * The widget probes the hosted MCP `/health` endpoint on every poll. To compute
 * uptime % and last-downtime — and to fire the M1 "health-check failing for >60s"
 * anomaly — we need to remember probe results across polls and across cockpit
 * restarts. This module owns that local, operator-machine-only history:
 *
 *   - Pure history math (uptime %, last downtime, trailing-failure duration, M1)
 *     is separated from file IO so it is trivially unit-testable.
 *   - Persistence reuses `atomicWriteJSON` from `lifecycle.ts` and lives at
 *     `<cockpitStateDir>/mcp-probe-history.json` — NO shared-persistence / DB
 *     schema touch, per the mt#2077 scope.
 *
 * The history is keyed globally (not per-workspace): it tracks the hosted server,
 * which is the same target regardless of which workspace's cockpit is probing.
 * Concurrent read-modify-write from two cockpit instances can drop a single
 * sample under interleaving; that is benign at the 30s probe cadence (worst case
 * one missed data point in the uptime ratio) and avoids a lock for a local tool.
 */

import fs from "fs";
import path from "path";
import { atomicWriteJSON, getCockpitStateDir } from "./lifecycle";

/** One probe result. */
export interface ProbeSample {
  /** ISO8601 timestamp of the probe. */
  at: string;
  /** Whether the probe returned HTTP 200. */
  ok: boolean;
  /** HTTP status code, or null when the request failed before a response. */
  statusCode: number | null;
}

/** The persisted rolling window of probe samples (chronological order). */
export interface ProbeHistory {
  samples: ProbeSample[];
}

/** 24h retention window for uptime % and history pruning. */
export const PROBE_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** M1 fires when the hosted /health has been non-200 continuously for >60s. */
export const HEALTH_FAIL_THRESHOLD_MS = 60 * 1000;

const EMPTY_HISTORY: ProbeHistory = { samples: [] };

// ---------------------------------------------------------------------------
// Pure history math
// ---------------------------------------------------------------------------

function sampleTime(sample: ProbeSample): number {
  return new Date(sample.at).getTime();
}

/** Drop samples older than `now - windowMs`. */
export function pruneHistory(history: ProbeHistory, windowMs: number, now: number): ProbeHistory {
  const cutoff = now - windowMs;
  return {
    samples: history.samples.filter((s) => {
      const t = sampleTime(s);
      return !isNaN(t) && t >= cutoff;
    }),
  };
}

/** Append a sample (assumed newest) and prune to the retention window. */
export function appendSample(
  history: ProbeHistory,
  sample: ProbeSample,
  windowMs: number,
  now: number
): ProbeHistory {
  return pruneHistory({ samples: [...history.samples, sample] }, windowMs, now);
}

/**
 * Uptime percentage over `windowMs` ending at `now`. Returns null when no
 * samples fall inside the window (nothing to report yet).
 */
export function uptimePct(history: ProbeHistory, windowMs: number, now: number): number | null {
  const cutoff = now - windowMs;
  const inWindow = history.samples.filter((s) => {
    const t = sampleTime(s);
    return !isNaN(t) && t >= cutoff;
  });
  if (inWindow.length === 0) return null;
  const okCount = inWindow.filter((s) => s.ok).length;
  return (okCount / inWindow.length) * 100;
}

/** ISO timestamp of the most recent failing probe, or null if none recorded. */
export function lastDowntime(history: ProbeHistory): string | null {
  for (let i = history.samples.length - 1; i >= 0; i--) {
    const sample = history.samples[i];
    if (sample && !sample.ok) return sample.at;
  }
  return null;
}

/**
 * Duration in ms of the current trailing run of consecutive failing probes,
 * measured from the first failure of that run to `now`. Returns 0 when the most
 * recent probe succeeded (or there is no history).
 */
export function consecutiveFailureMs(history: ProbeHistory, now: number): number {
  const samples = history.samples;
  if (samples.length === 0) return 0;
  const last = samples[samples.length - 1];
  if (!last || last.ok) return 0;

  let firstFailureAt = sampleTime(last);
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i];
    if (!sample || sample.ok) break;
    const t = sampleTime(sample);
    if (!isNaN(t)) firstFailureAt = t;
  }
  return Math.max(0, now - firstFailureAt);
}

/** M1: hosted /health non-200 continuously for longer than the threshold. */
export function healthFailing(
  history: ProbeHistory,
  now: number,
  thresholdMs: number = HEALTH_FAIL_THRESHOLD_MS
): boolean {
  return consecutiveFailureMs(history, now) > thresholdMs;
}

// ---------------------------------------------------------------------------
// Persistence (local file, no DB)
// ---------------------------------------------------------------------------

export function getProbeHistoryFilePath(): string {
  return path.join(getCockpitStateDir(), "mcp-probe-history.json");
}

/**
 * Read the persisted probe history. Returns an empty history on missing file,
 * malformed JSON, or wrong-shape contents — the caller treats those uniformly
 * as "no history yet" so the next write cleanly overwrites.
 */
export function readProbeHistory(): ProbeHistory {
  const filePath = getProbeHistoryFilePath();
  if (!fs.existsSync(filePath)) return { samples: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return { samples: [] };
  }
  if (!parsed || typeof parsed !== "object") return { samples: [] };
  const samples = (parsed as { samples?: unknown }).samples;
  if (!Array.isArray(samples)) return { samples: [] };
  const valid = samples.filter(
    (s): s is ProbeSample =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as { at?: unknown }).at === "string" &&
      typeof (s as { ok?: unknown }).ok === "boolean" &&
      (typeof (s as { statusCode?: unknown }).statusCode === "number" ||
        (s as { statusCode?: unknown }).statusCode === null)
  );
  return { samples: valid };
}

/** Persist the probe history atomically. Best-effort; never throws. */
export function writeProbeHistory(history: ProbeHistory): void {
  try {
    atomicWriteJSON(getProbeHistoryFilePath(), history);
  } catch {
    // Best-effort: a failed write only loses local uptime history, never blocks
    // the widget's live health rendering.
  }
}

export { EMPTY_HISTORY };
