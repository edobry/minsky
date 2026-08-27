#!/usr/bin/env bun
/**
 * Measure what changing the MCP disconnect escalation set would do (mt#4499).
 *
 * ## Why this is a committed script rather than a number in a PR body
 *
 * mt#4499's SC3 required the blast radius to be measured before the change
 * landed: "an escalation signal that fires constantly is as useless as one that
 * never fires." The measurement was run and pasted into PR #3283 — and the
 * reviewer correctly marked that criterion **Unverifiable from the diff alone**,
 * because a number in a PR description reproduces from nothing. This script is
 * that number's source, so the next person to touch `SERVER_INITIATED_CAUSES`
 * can re-derive it instead of trusting a paste.
 *
 * ## What it reports, and why it refuses to pool
 *
 * Per-DAY eligible counts under two candidate sets, plus the days on which each
 * would cross the daily threshold. Deliberately not a mean: this cadence is
 * bimodal (quiet stretches vs crash bursts and active-merge windows), and a
 * statistic spanning a regime boundary describes neither side. The 2026-07-26
 * burst is the whole reason mt#4499 exists, and a pooled average hides it.
 *
 * Known bound, stated rather than papered over: buckets are calendar days while
 * the real predicate uses a rolling 24h window. For a blast-radius estimate the
 * difference is immaterial when a burst is intraday; it is the wrong instrument
 * for a change that lands close to the threshold.
 *
 * ## Usage
 *
 *   bun scripts/measure-escalation-blast-radius.ts [--log <path>] [--add <cause>]
 *
 * `--add` adds a cause to the BASELINE set, so the run compares "today" against
 * "today plus that exclusion". With no `--add` it defaults to `signal`, which
 * reproduces the mt#4499 decision: baseline = shipped set, candidate = the set
 * as it stood before mt#4499.
 *
 * Exits 0 when it measured, 1 when the log is unreadable, and prints a SKIP and
 * exits 0 when no log exists (a fresh machine has nothing to measure).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listCorpusPaths } from "../src/mcp/disconnect-log-segments";
import { SERVER_INITIATED_CAUSES } from "../src/mcp/disconnect-escalation";

/** Mirrors `ESCALATION_THRESHOLD_24H` in `src/mcp/disconnect-tracker.ts`. */
const DAILY_THRESHOLD = 3;
const SHORT_LIVED_THRESHOLD_MS = 5000;

interface LoggedEvent {
  kind?: unknown;
  cause?: unknown;
  uptimeMs?: unknown;
  processRole?: unknown;
  timestamp?: unknown;
}

function eligibleUnder(excluded: ReadonlySet<string>, e: LoggedEvent): boolean {
  if (e.kind !== "disconnect") return false;
  if (typeof e.cause === "string" && excluded.has(e.cause)) return false;
  if (typeof e.uptimeMs === "number" && e.uptimeMs < SHORT_LIVED_THRESHOLD_MS) return false;
  if (e.processRole === "helper") return false;
  return true;
}

/**
 * Reads the hybrid log: a legacy pretty-printed array followed by JSONL.
 * Bracket-only lines are skipped, and a line that does not parse is skipped
 * rather than aborting — the same tolerance `loadFromDisk` applies, and the
 * reason a naive `jq` over this file fails (mt#4481).
 */
function readEvents(logPath: string): LoggedEvent[] {
  // Census across every monthly segment, not just the active file (mt#4495).
  // This script measures per-DAY across the whole history, so reading only the
  // active file would silently narrow the window to the current month — the
  // exact "reads only the active segment when the operator meant the whole
  // history" failure mt#4495's AT3 calls a FAILURE rather than a pass.
  const raw = listCorpusPaths(logPath)
    .map((segment) => fs.readFileSync(segment, "utf-8") as string)
    .join("\n");
  const events: LoggedEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("]")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") events.push(parsed as LoggedEvent);
    } catch {
      // intentional-swallow: a partially-written tail line is expected on a live
      // log. Skipping it loses one event from a census, which is not worth
      // aborting a measurement over.
    }
  }
  return events;
}

function countByDay(events: LoggedEvent[], excluded: ReadonlySet<string>): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const e of events) {
    if (!eligibleUnder(excluded, e)) continue;
    if (typeof e.timestamp !== "string") continue;
    const day = e.timestamp.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return byDay;
}

function main(): number {
  const argv = process.argv.slice(2);
  const logFlag = argv.indexOf("--log");
  const addFlag = argv.indexOf("--add");
  const logPath =
    logFlag >= 0 && argv[logFlag + 1]
      ? String(argv[logFlag + 1])
      : path.join(os.homedir(), ".local/state/minsky/mcp-disconnect-log.json");
  const addedCause = addFlag >= 0 && argv[addFlag + 1] ? String(argv[addFlag + 1]) : "signal";

  if (listCorpusPaths(logPath).length === 0) {
    console.log(`SKIP: no disconnect log at ${logPath} — nothing to measure.`);
    return 0;
  }

  let events: LoggedEvent[];
  try {
    events = readEvents(logPath);
  } catch (err) {
    console.error(`FAIL: could not read ${logPath}: ${(err as Error).message}`);
    return 1;
  }

  const baseline: ReadonlySet<string> = SERVER_INITIATED_CAUSES as ReadonlySet<string>;
  const candidate: ReadonlySet<string> = new Set<string>([...baseline, addedCause]);

  const baseDays = countByDay(events, baseline);
  const candDays = countByDay(events, candidate);
  const allDays = [...new Set([...baseDays.keys(), ...candDays.keys()])].sort();

  console.log(`log:            ${logPath}`);
  console.log(`events read:    ${events.length}`);
  console.log(`baseline set:   {${[...baseline].sort().join(", ")}}`);
  console.log(`candidate adds: "${addedCause}"`);
  console.log("");
  console.log("days where the per-day eligible counts DIFFER:");
  let differing = 0;
  for (const day of allDays) {
    const b = baseDays.get(day) ?? 0;
    const c = candDays.get(day) ?? 0;
    if (b === c) continue;
    differing++;
    console.log(`  ${day}: baseline=${b}  candidate=${c}`);
  }
  if (differing === 0) console.log("  (none)");

  const over = (m: Map<string, number>) =>
    [...m.values()].filter((n) => n > DAILY_THRESHOLD).length;
  console.log("");
  console.log(`days crossing the daily threshold (>${DAILY_THRESHOLD}/24h):`);
  console.log(`  baseline:  ${over(baseDays)}`);
  console.log(`  candidate: ${over(candDays)}`);
  console.log("");
  console.log("NOTE: calendar-day buckets; the live predicate uses a rolling 24h window.");
  return 0;
}

process.exit(main());
