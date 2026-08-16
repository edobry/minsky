#!/usr/bin/env bun
//
// Report harness markup tags the inventory does not know — mt#4061.
//
// `HARNESS_MARKUP_TAGS` (`packages/shared/src/harness-markup.ts`) is a
// hand-maintained allowlist, and every time it has been extended the trigger was
// a human noticing raw XML in the cockpit conversation view rather than a check:
//
//   mt#3322 — `local-command-stdout` / `local-command-caveat`; 124 of 134
//             command wrappers were undetected at the time.
//   mt#3396 — `task-notification`; 48 turns, all role `user`.
//   mt#4058 — `bash-input` / `bash-stdout` / `bash-stderr`; found from a
//             principal screenshot on 2026-08-12.
//
// Each fix was correct and each left the same gap open for the next family.
// This script makes the inventory's own grounding survey — "the set of tags
// actually observed across the local transcript corpus (~2.6k conversations,
// surveyed 2026-07-29)" — repeatable instead of a one-off.
//
// It NOMINATES; it does not decide. Whether a tag is harness markup or ordinary
// prose is a judgment (see EXCLUSIONS below for three that look like markup and
// are not), so the output is a list for a human to rule on, not a verdict.
//
// Usage:
//   bun scripts/audit-unknown-harness-tags.ts
//   bun scripts/audit-unknown-harness-tags.ts --json
//   bun scripts/audit-unknown-harness-tags.ts --fail-on-unknown   # for CI wiring
//
// Exit codes: 0 = scanned (findings or not, unless --fail-on-unknown), 0 with a
// `SKIP:` line when no corpus is present (a bare checkout has no transcripts,
// which is not a defect), 1 = unknown tags found AND --fail-on-unknown.
//
// **Corpus caveat — read this before trusting a clean report.** The corpus is
// the local Claude Code JSONL under `~/.claude/projects/`. ADR-025 (ACCEPTED
// 2026-07-08) declares that file set throw-away: "The local Claude Code JSONL is
// throw-away after a successful upload. Nothing reads it at runtime." Reading it
// anyway is a deliberate deviation, because the object-store archive that
// replaces it is not populated — as of mt#4061 the only consumers of
// `TranscriptArchiveStore` are `scripts/transcript-archive/{smoke,lib}.ts`; no
// ingest path writes to it, and the backfill (mt#2682) is still TODO. So this is
// the only corpus that exists today.
//
// That is exactly why the report ALWAYS states its corpus size. A clean run over
// zero conversations and a clean run over two thousand print the same finding
// list, and once ADR-025's ingest lands and local files start being cleaned up,
// the first case becomes reachable silently. A probe that cannot fail carries no
// information (mem#704). Re-point this at the archive once that ingest and
// mt#2682's backfill land.

import { createReadStream, existsSync, lstatSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESS_MARKUP_TAGS } from "../packages/shared/src/harness-markup";

/**
 * Tags that LOOK like harness markup and are ordinary prose. Recorded verbatim
 * from the inventory's own docblock, which surveyed them in 2026-07-29 — the
 * point of carrying them here is that a sweep which re-nominates them every run
 * teaches its reader to skim the output.
 */
// NOT centralized into `@minsky/shared/harness-markup` (PR #2947 R1 raised the
// drift risk, non-blocking). The inventory records these as PROSE in its
// docblock — narrative, not a data structure — and lifting them into an
// exported constant would put a dev-tool concern in a browser-bundled module
// for three entries. Deliberate duplication with a pointer; revisit if the
// inventory ever grows an exclusion this script does not carry.
const EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  ["command", "CLI help text (`exec [options] <command>`, `git <command> [<revision>...]`)"],
  ["command-digest", "a code comment describing an id format"],
  ["skill-name", "rule prose describing the `/<skill-name>` form"],
]);

/** One turn's worth of scan input, decoupled from how it was read off disk. */
export interface ScannedTurn {
  /** The conversation this turn came from — a finding reports how many it spans. */
  conversationId: string;
  /** The turn's raw text, exactly as stored. */
  text: string;
}

export interface TagFinding {
  tag: string;
  occurrences: number;
  /** How many distinct conversations carry it — 1 is likely a fluke, 40 is a family. */
  conversations: number;
  /** A short verbatim sample, so a reader can judge markup-vs-prose without grepping. */
  sample: string;
}

export interface ScanReport {
  /**
   * Files that yielded at least one `user` turn — NOT every `.jsonl` present.
   * The two differ (1553 vs 1556 on the corpus this shipped against), and the
   * whole purpose of these counts is that a reader can compare them to
   * something, so the narrower number gets the narrower name.
   */
  filesWithUserTurns: number;
  turnsExamined: number;
  /**
   * Turns whose turn-start run hit {@link MAX_BLOCKS_PER_TURN}, so tags past
   * the cap were not examined. Reported rather than swallowed: a sweep that
   * prints a clean result while having skipped input is the exact shape this
   * task exists to remove (PR #2947 R1).
   */
  turnsTruncatedAtCap: number;
  findings: TagFinding[];
}

/**
 * Turn-START anchored, close-tag REQUIRED. Both halves are the conservatism
 * `splitInjectedContent` applies, mirrored here for the same reason: prose
 * mentioning `<command>` mid-sentence, or CLI help text with no closing tag,
 * must not be nominated. Tag names are lowercase-with-hyphens, which every
 * observed harness tag is and which excludes JSX (`<Card>`) and comparisons
 * (`<3`).
 */
const TURN_START_TAG = /^\s*<([a-z][a-z0-9-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/;

/**
 * Defensive bound on one turn's consumable run.
 *
 * Not a claim that 8 is enough — it is a runaway guard. Measured on the corpus
 * this shipped against: `turnsTruncatedAtCap` was 0 across 12,140 turns, which
 * establishes that nothing REACHED the cap, not what the true maximum run is.
 * Because it COULD silently drop a longer family's later tags, hitting it is
 * counted and reported rather than swallowed (`ScanReport.turnsTruncatedAtCap`).
 */
const MAX_BLOCKS_PER_TURN = 8;

const KNOWN_TAGS: ReadonlySet<string> = new Set<string>(HARNESS_MARKUP_TAGS);

export interface TurnStartTagsResult {
  tags: string[];
  /** True when the cap stopped the scan with text still unconsumed. */
  truncated: boolean;
}

/** Every turn-start tag name in `text`, in order, consuming a contiguous run. */
export function turnStartTags(text: string): string[] {
  return scanTurnStartTags(text).tags;
}

/** {@link turnStartTags}, plus whether the cap cut the run short. */
export function scanTurnStartTags(text: string): TurnStartTagsResult {
  const tags: string[] = [];
  let rest = text;
  for (let i = 0; i < MAX_BLOCKS_PER_TURN; i++) {
    const match = TURN_START_TAG.exec(rest);
    if (!match) break;
    const tag = match[1];
    if (tag === undefined) break;
    tags.push(tag);
    rest = rest.slice(match[0].length);
  }
  // Truncated only when the cap was reached AND another block was waiting —
  // a turn with exactly MAX_BLOCKS_PER_TURN blocks lost nothing.
  const truncated = tags.length === MAX_BLOCKS_PER_TURN && TURN_START_TAG.test(rest);
  return { tags, truncated };
}

/** True when the tag is neither in the inventory nor a recorded prose lookalike. */
export function isUnknownTag(tag: string): boolean {
  return !KNOWN_TAGS.has(tag) && !EXCLUSIONS.has(tag);
}

/** Short enough to read in a table row, long enough to judge markup-vs-prose. */
const SAMPLE_CHARS = 90;

/**
 * The pure core: fold turns in one at a time, read the report out.
 *
 * Incremental by design (PR #2947 R1). The first cut collected every turn into
 * an array before counting, which made the header's "streamed rather than read
 * whole" true of each FILE and false of the CORPUS — thousands of transcripts
 * would land in RAM at once. Folding as we go bounds memory by the number of
 * distinct unknown tags, which is what the counts are anyway.
 *
 * Every IO decision — where the corpus lives, whether it exists, how a line
 * parses — belongs to the caller, so this is testable without a transcript
 * directory.
 */
export class TagScanAccumulator {
  private readonly occurrences = new Map<string, number>();
  private readonly conversations = new Map<string, Set<string>>();
  private readonly samples = new Map<string, string>();
  private readonly seenFiles = new Set<string>();
  private turnsExamined = 0;
  private turnsTruncatedAtCap = 0;

  add(turn: ScannedTurn): void {
    this.seenFiles.add(turn.conversationId);
    this.turnsExamined += 1;
    const { tags, truncated } = scanTurnStartTags(turn.text);
    if (truncated) this.turnsTruncatedAtCap += 1;
    for (const tag of tags) {
      if (!isUnknownTag(tag)) continue;
      this.occurrences.set(tag, (this.occurrences.get(tag) ?? 0) + 1);
      const convos = this.conversations.get(tag) ?? new Set<string>();
      convos.add(turn.conversationId);
      this.conversations.set(tag, convos);
      if (!this.samples.has(tag)) {
        this.samples.set(tag, turn.text.slice(0, SAMPLE_CHARS).replace(/\n/g, "\\n"));
      }
    }
  }

  report(): ScanReport {
    const findings: TagFinding[] = [...this.occurrences.entries()]
      .map(([tag, count]) => ({
        tag,
        occurrences: count,
        conversations: this.conversations.get(tag)?.size ?? 0,
        sample: this.samples.get(tag) ?? "",
      }))
      // Most-occurring first: a family shows up as a cluster, a fluke as a tail.
      .sort((a, b) => b.occurrences - a.occurrences || a.tag.localeCompare(b.tag));

    return {
      filesWithUserTurns: this.seenFiles.size,
      turnsExamined: this.turnsExamined,
      turnsTruncatedAtCap: this.turnsTruncatedAtCap,
      findings,
    };
  }
}

/** {@link TagScanAccumulator} over an in-memory sequence — the test-path shape. */
export function scanTurns(turns: Iterable<ScannedTurn>): ScanReport {
  const acc = new TagScanAccumulator();
  for (const turn of turns) acc.add(turn);
  return acc.report();
}

// ── IO shell ────────────────────────────────────────────────────────────────

function corpusRoot(): string {
  return process.env["MINSKY_TRANSCRIPT_CORPUS"] ?? join(homedir(), ".claude", "projects");
}

function jsonlFiles(root: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    let isDir: boolean;
    try {
      // `lstatSync`, not `statSync` (PR #2947 R1): a symlinked directory
      // pointing at an ancestor would otherwise recurse forever. Not following
      // links at all is the cheapest cycle guard, and the corpus is a flat
      // per-project tree of real directories.
      isDir = lstatSync(path).isDirectory();
    } catch {
      continue; // a vanished or unreadable entry is not a scan failure
    }
    if (isDir) {
      files.push(...jsonlFiles(path));
    } else if (entry.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

/** The text of a `user`-role record, or null when the line is not one. */
function userTurnText(line: string): string | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null; // a truncated trailing line is normal in a live-appended file
  }
  if (typeof record !== "object" || record === null) return null;
  const message = (record as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  if ((message as { role?: unknown }).role !== "user") return null;

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  // A turn's text blocks are concatenated, matching how the render surface
  // reconstitutes a run before classifying it (mt#2791's flushTextRun).
  const parts = content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
    )
    .map((block) => block.text);
  return parts.length > 0 ? parts.join("") : null;
}

async function* readCorpus(files: string[]): AsyncGenerator<ScannedTurn> {
  for (const file of files) {
    // Streamed rather than read whole: a single transcript runs to tens of MB.
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (line.length === 0) continue;
        const text = userTurnText(line);
        if (text !== null) yield { conversationId: file, text };
      }
    } finally {
      rl.close();
    }
  }
}

/**
 * Fold the corpus into a report WITHOUT materializing it (PR #2947 R1).
 * Nothing accumulates here but the accumulator's own counters.
 */
async function scanCorpus(files: string[]): Promise<ScanReport> {
  const acc = new TagScanAccumulator();
  for await (const turn of readCorpus(files)) acc.add(turn);
  return acc.report();
}

function renderText(report: ScanReport, root: string, filesDiscovered: number): string {
  const lines: string[] = [];
  // The corpus size leads, on every run including a clean one — see the header.
  // BOTH file counts, because they differ and a reader comparing to a raw
  // `find | wc -l` should not have to guess which one this is (PR #2947 R1).
  lines.push(
    `Scanned ${filesDiscovered} .jsonl file(s) under ${root}; ` +
      `${report.filesWithUserTurns} carried a user turn, ` +
      `${report.turnsExamined} user turn(s) examined`
  );
  if (report.turnsTruncatedAtCap > 0) {
    lines.push(
      `WARNING: ${report.turnsTruncatedAtCap} turn(s) hit the ${MAX_BLOCKS_PER_TURN}-block ` +
        `scan cap — tags past it were NOT examined, so this report is incomplete for those turns.`
    );
  }
  if (report.findings.length === 0) {
    lines.push("No unknown turn-start tags. The inventory covers this corpus.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`${report.findings.length} tag name(s) not in HARNESS_MARKUP_TAGS:`);
  lines.push("");
  for (const f of report.findings) {
    lines.push(
      `  <${f.tag}>  ${f.occurrences} occurrence(s) in ${f.conversations} conversation(s)`
    );
    lines.push(`      ${f.sample}`);
  }
  lines.push("");
  lines.push(
    "Each is a NOMINATION, not a verdict: decide per tag whether it is harness " +
      "markup or ordinary prose. If markup, add it to HARNESS_MARKUP_TAGS " +
      "(packages/shared/src/harness-markup.ts) with its observed counts, and give " +
      "it a presentation entry in src/cockpit/web/lib/injected-content.ts. If " +
      "prose, add it to EXCLUSIONS in this script with the reason."
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const json = process.argv.includes("--json");
  const failOnUnknown = process.argv.includes("--fail-on-unknown");
  const root = corpusRoot();

  if (!existsSync(root)) {
    console.log(`SKIP: no transcript corpus at ${root} (set MINSKY_TRANSCRIPT_CORPUS to override)`);
    process.exit(0);
  }
  const files = jsonlFiles(root);
  if (files.length === 0) {
    console.log(`SKIP: no .jsonl files under ${root}`);
    process.exit(0);
  }

  const report = await scanCorpus(files);
  console.log(
    json
      ? JSON.stringify({ ...report, filesDiscovered: files.length }, null, 2)
      : renderText(report, root, files.length)
  );
  process.exit(failOnUnknown && report.findings.length > 0 ? 1 : 0);
}
