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

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
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
  conversationsScanned: number;
  turnsExamined: number;
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

/** Defensive bound on one turn's consumable run — the harness emits at most a few. */
const MAX_BLOCKS_PER_TURN = 8;

const KNOWN_TAGS: ReadonlySet<string> = new Set<string>(HARNESS_MARKUP_TAGS);

/** Every turn-start tag name in `text`, in order, consuming a contiguous run. */
export function turnStartTags(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (let i = 0; i < MAX_BLOCKS_PER_TURN; i++) {
    const match = TURN_START_TAG.exec(rest);
    if (!match) break;
    const tag = match[1];
    if (tag === undefined) break;
    found.push(tag);
    rest = rest.slice(match[0].length);
  }
  return found;
}

/** True when the tag is neither in the inventory nor a recorded prose lookalike. */
export function isUnknownTag(tag: string): boolean {
  return !KNOWN_TAGS.has(tag) && !EXCLUSIONS.has(tag);
}

/** Short enough to read in a table row, long enough to judge markup-vs-prose. */
const SAMPLE_CHARS = 90;

/**
 * The pure core: turns in, report out. Every IO decision — where the corpus
 * lives, whether it exists, how a line parses — belongs to the caller, so this
 * is testable without a transcript directory.
 */
export function scanTurns(turns: Iterable<ScannedTurn>): ScanReport {
  const occurrences = new Map<string, number>();
  const conversations = new Map<string, Set<string>>();
  const samples = new Map<string, string>();
  const seenConversations = new Set<string>();
  let turnsExamined = 0;

  for (const turn of turns) {
    seenConversations.add(turn.conversationId);
    turnsExamined += 1;
    for (const tag of turnStartTags(turn.text)) {
      if (!isUnknownTag(tag)) continue;
      occurrences.set(tag, (occurrences.get(tag) ?? 0) + 1);
      const convos = conversations.get(tag) ?? new Set<string>();
      convos.add(turn.conversationId);
      conversations.set(tag, convos);
      if (!samples.has(tag))
        samples.set(tag, turn.text.slice(0, SAMPLE_CHARS).replace(/\n/g, "\\n"));
    }
  }

  const findings: TagFinding[] = [...occurrences.entries()]
    .map(([tag, count]) => ({
      tag,
      occurrences: count,
      conversations: conversations.get(tag)?.size ?? 0,
      sample: samples.get(tag) ?? "",
    }))
    // Most-occurring first: a family shows up as a cluster, a fluke as a tail.
    .sort((a, b) => b.occurrences - a.occurrences || a.tag.localeCompare(b.tag));

  return {
    conversationsScanned: seenConversations.size,
    turnsExamined,
    findings,
  };
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
      isDir = statSync(path).isDirectory();
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

/** `scanTurns` over an async source — same logic, streamed input. */
async function scanCorpus(files: string[]): Promise<ScanReport> {
  const turns: ScannedTurn[] = [];
  for await (const turn of readCorpus(files)) turns.push(turn);
  return scanTurns(turns);
}

function renderText(report: ScanReport, root: string): string {
  const lines: string[] = [];
  // The corpus size leads, on every run including a clean one — see the header.
  lines.push(
    `Scanned ${report.conversationsScanned} conversation file(s), ` +
      `${report.turnsExamined} user turn(s), under ${root}`
  );
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
  console.log(json ? JSON.stringify(report, null, 2) : renderText(report, root));
  process.exit(failOnUnknown && report.findings.length > 0 ? 1 : 0);
}
