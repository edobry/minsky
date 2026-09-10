#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Context fill AT A WORK BOUNDARY — the instrument behind mt#5042's threshold.
//
// mt#5042's AT1 originally said to "re-run `scripts/measure-context-bandwidth.ts`
// and produce the context-at-merge distribution". That script does not produce
// it: it measures the re-upload tail, the session-length curve, and subagent
// dispatch ratios, none of which is fill at a boundary. This is the missing
// instrument, landed so the threshold can be RE-DERIVED rather than recalled.
//
// It answers three questions:
//
//   1. (AT1) What is the distribution of context fill at a work boundary — a
//      merge, a PR landing, a task closeout?
//   2. (AT2) For sessions that compacted, how many boundaries were available
//      BEFORE the compaction, how many would each candidate threshold have
//      caught, and how many requests earlier would the first catch have been?
//   3. Cross-validation: what is the compaction-onset distribution? mt#2531
//      independently derived p50 996,235 over 12 events by a different method;
//      agreement there is what licenses reading (1) and (2), which have no prior
//      to check against.
//
// ---------------------------------------------------------------------------
// WHAT THIS EMITS, ON EVERY CHANNEL (not just stdout)
// ---------------------------------------------------------------------------
//
// This reads the operator's own conversation transcripts, so the data-flow claim
// is scoped to every egress channel rather than the one being designed
// (`claim-confidence.mdc` — a channel-scoped "emits only counts" is the failure
// this paragraph exists to avoid):
//
//   - stdout/stderr — aggregate counts, token figures, and percentiles only.
//   - files written — one aggregate JSON at `--out`; same content as stdout.
//   - network — NONE. No fetch, no SDK, no embedding call. The whole computation
//     is local arithmetic over token counts.
//   - subprocess — NONE. Nothing is spawned, so nothing reaches another
//     process's argv.
//
// No prompt text, tool input, tool result, file path, or message content is read
// into an output on any of them: the only fields touched are `message.usage.*`,
// `message.id`, a tool_use `name`, and `compactMetadata.*`.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//
//   bun scripts/measure-context-at-merge.ts
//   bun scripts/measure-context-at-merge.ts --all-projects
//   bun scripts/measure-context-at-merge.ts --project <dir> --out <file.json>
//
// Read-only over the transcript corpus; the only write is the results file.
//
// @see mt#5042 — the task this grounds
// @see mt#2531 — the fill-only trigger whose thresholds this shows cannot be
//      inherited by a boundary-gated one
// @see .minsky/hooks/handoff-at-work-boundary.ts — the observer that consumes
//      the threshold this derives
// @see docs/context-bandwidth.md — the re-upload arithmetic that makes an
//      earlier compaction strictly cheaper
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The tool calls that mark a work boundary, mirroring
 * `.minsky/hooks/handoff-at-work-boundary.ts`'s `BOUNDARY_TOOLS`.
 *
 * Duplicated rather than imported: this script must run over a corpus written by
 * PAST versions of the hook tree, and importing the live map would silently
 * re-scope a historical measurement every time the hook's trigger set changes.
 * `measure-context-at-merge.test.ts` pins the two in sync so the duplication is
 * checked rather than hoped for.
 */
export const BOUNDARY_TOOLS: Readonly<Record<string, BoundaryKind>> = Object.freeze({
  mcp__minsky__session_pr_merge: "merge",
  mcp__github__merge_pull_request: "merge",
  mcp__minsky__session_pr_create: "pr-landing",
  mcp__minsky__tasks_status_set: "closeout",
});

export type BoundaryKind = "merge" | "pr-landing" | "closeout";

/** The candidate band the decision record prices the trade across. */
export const CANDIDATE_THRESHOLDS = [500_000, 600_000, 650_000, 700_000, 800_000, 950_000];

export interface BoundaryEvent {
  kind: BoundaryKind;
  /** Prompt tokens carried by the request that emitted the tool call — the fill AT the boundary. */
  fillTokens: number;
  /** 0-based index of that request within the session, for the "how much earlier" arithmetic. */
  requestIndex: number;
}

export interface CompactionEvent {
  preTokens: number;
  trigger: string;
  requestIndex: number;
}

export interface SessionScan {
  boundaries: BoundaryEvent[];
  compactions: CompactionEvent[];
  requests: number;
}

function asTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Prompt tokens for one request — the live context size.
 *
 * `output_tokens` is deliberately excluded, matching `context-fill-gauge`'s
 * `computeFill`: it is what the call PRODUCED, not what it was given, and it
 * reappears inside `cache_read` on the next call.
 */
export function fillFromUsage(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  return (
    asTokenCount(usage["input_tokens"]) +
    asTokenCount(usage["cache_creation_input_tokens"]) +
    asTokenCount(usage["cache_read_input_tokens"])
  );
}

/** The boundary tools named by `tool_use` blocks on one assistant message. */
export function boundaryToolsInContent(content: unknown): BoundaryKind[] {
  if (!Array.isArray(content)) return [];
  const kinds: BoundaryKind[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type !== "tool_use" || typeof b.name !== "string") continue;
    const kind = BOUNDARY_TOOLS[b.name];
    if (kind === undefined) continue;
    // A closeout is a status_set to DONE specifically; every other transition is
    // ordinary mid-work motion, not a point where conclusions have landed.
    if (kind === "closeout") {
      const input = b.input as Record<string, unknown> | undefined;
      const status = input?.["status"];
      if (typeof status !== "string" || status.toUpperCase() !== "DONE") continue;
    }
    kinds.push(kind);
  }
  return kinds;
}

/**
 * Scan one transcript into boundary and compaction events.
 *
 * Requests are deduped by `message.id`: Claude Code writes ONE JSONL LINE PER
 * CONTENT BLOCK, so a single API response spans several lines sharing one id
 * (mem#762 — counting lines over-counts requests by ~2.3x). The request INDEX
 * this produces is therefore a real request ordinal, which is what AT2's "how
 * many requests earlier" is measured in.
 */
export function scanTranscriptText(raw: string): SessionScan {
  const boundaries: BoundaryEvent[] = [];
  const compactions: CompactionEvent[] = [];
  const seenMessageIds = new Set<string>();
  let requestIndex = -1;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a partially-flushed final line is normal, not an error
    }
    if (typeof record !== "object" || record === null) continue;
    const entry = record as {
      type?: unknown;
      subtype?: unknown;
      message?: unknown;
      compactMetadata?: unknown;
    };

    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      const meta = entry.compactMetadata as Record<string, unknown> | undefined;
      const preTokens = asTokenCount(meta?.["preTokens"]);
      if (preTokens > 0) {
        compactions.push({
          preTokens,
          trigger: typeof meta?.["trigger"] === "string" ? (meta["trigger"] as string) : "unknown",
          requestIndex: Math.max(requestIndex, 0),
        });
      }
      continue;
    }

    if (entry.type !== "assistant") continue;
    const message = entry.message as
      | { id?: unknown; usage?: Record<string, unknown>; content?: unknown }
      | undefined;
    const id = message?.id;
    if (typeof id !== "string") continue;

    // A new request: advance the ordinal. Subsequent lines of the SAME response
    // reuse this index, so a tool_use on a later block is still attributed to
    // the request that carried it.
    if (!seenMessageIds.has(id)) {
      seenMessageIds.add(id);
      requestIndex++;
    }

    const kinds = boundaryToolsInContent(message?.content);
    if (kinds.length === 0) continue;
    const fillTokens = fillFromUsage(message?.usage);
    // A tool_use block with no usage on its own line: the fill is unknown for
    // that line, not zero. Skipping is the honest reading — a zero would drag
    // every percentile down and there is no way to tell the two apart later.
    if (fillTokens === 0) continue;
    for (const kind of kinds) boundaries.push({ kind, fillTokens, requestIndex });
  }

  return { boundaries, compactions, requests: seenMessageIds.size };
}

/**
 * The imperative shell around `scanTranscriptText`: read the file, hand the text
 * to the pure core.
 *
 * An unreadable transcript is skipped, not fatal — the corpus is a directory of
 * files written by another process, some of which may be mid-write.
 */
export function scanTranscript(filePath: string): SessionScan {
  try {
    return scanTranscriptText(readFileSync(filePath, "utf-8"));
  } catch {
    return { boundaries: [], compactions: [], requests: 0 };
  }
}

/** Nearest-rank percentile over an unsorted array. Returns 0 for an empty input. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx] ?? 0;
}

export interface Distribution {
  count: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  max: number;
}

export function describe(values: readonly number[]): Distribution {
  return {
    count: values.length,
    p10: percentile(values, 10),
    p25: percentile(values, 25),
    p50: percentile(values, 50),
    p75: percentile(values, 75),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

export interface ThresholdRow {
  thresholdTokens: number;
  /** Boundaries at or above the threshold — how often the trigger would fire. */
  fires: number;
  firesPct: number;
  /** Pre-compaction boundaries caught — the opportunities actually taken. */
  preCompactionCaught: number;
  preCompactionPct: number;
  /**
   * Median requests between the first firing boundary and the compaction it
   * preceded — how much earlier the handoff would have landed.
   */
  medianRequestsEarlier: number;
}

export interface MeasurementReport {
  generatedAt: string;
  corpus: {
    transcriptsScanned: number;
    sessionsWithBoundary: number;
    boundaryEvents: number;
    sessionsWithCompaction: number;
    compactionEvents: number;
  };
  fillAtBoundary: Distribution;
  fillAtBoundaryByKind: Record<BoundaryKind, Distribution>;
  /** AT2's population: boundaries that occurred before a compaction in the same session. */
  preCompactionBoundaries: Distribution;
  thresholds: ThresholdRow[];
  /** Cross-validation against mt#2531's independently derived p50 996,235. */
  compactionOnset: Distribution;
  autoCompactionOnset: Distribution;
}

interface PreCompactionBoundary extends BoundaryEvent {
  compactionRequestIndex: number;
}

export function buildReport(scans: readonly SessionScan[], generatedAt: string): MeasurementReport {
  const allBoundaries: BoundaryEvent[] = [];
  const preCompaction: PreCompactionBoundary[] = [];
  const onsets: number[] = [];
  const autoOnsets: number[] = [];
  let sessionsWithBoundary = 0;
  let sessionsWithCompaction = 0;

  for (const scan of scans) {
    if (scan.boundaries.length > 0) sessionsWithBoundary++;
    if (scan.compactions.length > 0) sessionsWithCompaction++;
    allBoundaries.push(...scan.boundaries);
    for (const c of scan.compactions) {
      onsets.push(c.preTokens);
      if (c.trigger === "auto") autoOnsets.push(c.preTokens);
    }
    // AT2: a boundary counts as a real missed opportunity when a compaction
    // followed it in the same session. Attributed to the FIRST compaction after
    // it, so a session with two compactions does not double-count.
    for (const b of scan.boundaries) {
      const next = scan.compactions.find((c) => c.requestIndex > b.requestIndex);
      if (next) preCompaction.push({ ...b, compactionRequestIndex: next.requestIndex });
    }
  }

  const byKind = {} as Record<BoundaryKind, Distribution>;
  for (const kind of ["merge", "pr-landing", "closeout"] as const) {
    byKind[kind] = describe(allBoundaries.filter((b) => b.kind === kind).map((b) => b.fillTokens));
  }

  const thresholds: ThresholdRow[] = CANDIDATE_THRESHOLDS.map((thresholdTokens) => {
    const fires = allBoundaries.filter((b) => b.fillTokens >= thresholdTokens).length;
    const caught = preCompaction.filter((b) => b.fillTokens >= thresholdTokens);
    const earlier = caught.map((b) => b.compactionRequestIndex - b.requestIndex);
    return {
      thresholdTokens,
      fires,
      firesPct:
        allBoundaries.length === 0 ? 0 : Math.round((fires / allBoundaries.length) * 1000) / 10,
      preCompactionCaught: caught.length,
      preCompactionPct:
        preCompaction.length === 0
          ? 0
          : Math.round((caught.length / preCompaction.length) * 1000) / 10,
      medianRequestsEarlier: percentile(earlier, 50),
    };
  });

  return {
    generatedAt,
    corpus: {
      transcriptsScanned: scans.length,
      sessionsWithBoundary,
      boundaryEvents: allBoundaries.length,
      sessionsWithCompaction,
      compactionEvents: onsets.length,
    },
    fillAtBoundary: describe(allBoundaries.map((b) => b.fillTokens)),
    fillAtBoundaryByKind: byKind,
    preCompactionBoundaries: describe(preCompaction.map((b) => b.fillTokens)),
    thresholds,
    compactionOnset: describe(onsets),
    autoCompactionOnset: describe(autoOnsets),
  };
}

// ---------------------------------------------------------------------------
// Corpus discovery + CLI
// ---------------------------------------------------------------------------

/**
 * Claude Code's per-project transcript directory, derived rather than hardcoded.
 * The harness encodes the project path by replacing every separator with `-`.
 */
function projectTranscriptDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[/\\]/g, "-"));
}

function transcriptFilesIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
}

function allProjectDirs(): string[] {
  const root = join(homedir(), ".claude", "projects");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((n) => join(root, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function printDistribution(label: string, d: Distribution): void {
  if (d.count === 0) {
    console.log(`${label}: (no events)`);
    return;
  }
  console.log(
    `${label}: n=${d.count}  p10 ${fmt(d.p10)}  p25 ${fmt(d.p25)}  p50 ${fmt(d.p50)}  ` +
      `p75 ${fmt(d.p75)}  p90 ${fmt(d.p90)}  p99 ${fmt(d.p99)}  max ${fmt(d.max)}`
  );
}

export function renderReport(report: MeasurementReport): string {
  const lines: string[] = [];
  lines.push(
    `corpus: ${report.corpus.transcriptsScanned} transcripts, ` +
      `${report.corpus.boundaryEvents} boundary events across ${report.corpus.sessionsWithBoundary} sessions, ` +
      `${report.corpus.compactionEvents} compactions across ${report.corpus.sessionsWithCompaction} sessions`
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const explicitProject = argValue("--project");
  const outPath = argValue("--out") ?? join("scripts", "context-at-merge-results.json");

  let dirs: string[];
  if (explicitProject) {
    dirs = [explicitProject];
  } else if (args.includes("--all-projects")) {
    dirs = allProjectDirs();
  } else {
    dirs = [projectTranscriptDir(process.cwd())];
  }

  const files = dirs.flatMap(transcriptFilesIn);
  if (files.length === 0) {
    // Skip gracefully rather than fail: a fresh machine has no corpus, and that
    // is not an error in the instrument.
    console.log(
      `SKIP: no transcripts found under ${dirs.map((d) => d.replace(homedir(), "~")).join(", ")}`
    );
    process.exit(0);
  }

  const scans = files.map(scanTranscript);
  const report = buildReport(scans, new Date().toISOString());

  console.log(renderReport(report));
  console.log("");
  printDistribution("fill at boundary (all)   ", report.fillAtBoundary);
  for (const kind of ["merge", "pr-landing", "closeout"] as const) {
    printDistribution(`  ${kind.padEnd(23)}`, report.fillAtBoundaryByKind[kind]);
  }
  printDistribution("fill at pre-compaction bd", report.preCompactionBoundaries);
  console.log("");
  printDistribution("compaction onset (all)   ", report.compactionOnset);
  printDistribution("compaction onset (auto)  ", report.autoCompactionOnset);
  console.log("");
  console.log("threshold      fires  share   pre-compaction caught   median requests earlier");
  for (const row of report.thresholds) {
    console.log(
      `${fmt(row.thresholdTokens).padStart(9)}  ${String(row.fires).padStart(7)}  ` +
        `${String(row.firesPct).padStart(5)}%  ` +
        `${String(row.preCompactionCaught).padStart(10)} / ${String(report.preCompactionBoundaries.count).padEnd(6)} ` +
        `(${String(row.preCompactionPct).padStart(5)}%)  ${String(row.medianRequestsEarlier).padStart(6)}`
    );
  }

  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  console.log(`\nwrote ${outPath}`);

  if (!existsSync(outPath)) process.exit(1);
}

if (import.meta.main) {
  void main();
}
