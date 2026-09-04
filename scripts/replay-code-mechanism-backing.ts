#!/usr/bin/env bun
/**
 * Replay the BACKING axis of `code-mechanism-assertion` (mt#4084).
 *
 * ## Why this exists beside `replay-code-mechanism-calibration.ts`
 *
 * That script states its own bound: *"this replays claim EXTRACTION, not
 * BACKING … the corpus is not captured, so `hadSameTurnRead` and
 * `backedClaimCount` are outside what this can re-derive"* — and it runs the
 * detector against an EMPTY corpus (`detectCodeMechanismAssertion(excerpt, "", "")`).
 *
 * A corpus-only change is therefore invisible to it: running it against mt#4084
 * reports every record `same`, which reads as "no collateral" and is really "the
 * probe cannot see this change at all". A probe that returns the same answer
 * whether or not the change shipped carries no information (mem#704).
 *
 * This script closes that gap WITHOUT taking the retention decision that script
 * declined (capturing the corpus into the record). It reconstructs the turn's
 * tool calls from the local transcript instead, which is where they already are.
 *
 * ## The join, and why it is exact
 *
 * A capture records `judgedInput.hash` = `hashJudgedText(elideBlocksAndQuotes(assistantText))`.
 * Both functions are exported, so re-deriving that hash for every turn in the
 * transcript store yields an EXACT key — not a fuzzy text match. `--validate`
 * reports the join rate; a record that does not join is reported as such and is
 * never folded into a rate, so an unjoinable record cannot masquerade as
 * agreement.
 *
 * ## What it reports
 *
 * - **FP direction (SC4)** — of the claims that fired under the OLD corpus, how
 *   many the call-record widening now backs.
 * - **FN direction (SC5)** — the same number read the other way, per record, so
 *   each silencing can be checked against the turn that produced it rather than
 *   accepted in aggregate. A silencing that cannot be justified record-by-record
 *   is too broad.
 *
 * Emits aggregate counts plus claim symbols — never turn text. The corpus is the
 * operator's own transcripts.
 *
 * Usage:
 *   bun scripts/replay-code-mechanism-backing.ts
 *   bun scripts/replay-code-mechanism-backing.ts --validate
 *   bun scripts/replay-code-mechanism-backing.ts --transcripts <dir> --log <path>
 *
 * Exit 0 when it completes, including a clean SKIP when the transcript store is
 * absent (CI has no local transcripts).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  detectCodeMechanismAssertion,
  buildVerificationCorpus,
  elideBlocksAndQuotes,
} from "../.minsky/hooks/code-mechanism-assertion-detector";
import { hashJudgedText, hasJudgedInputCapture } from "../.minsky/hooks/judged-input-capture";
import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import {
  checkoutForLegacyLogPath,
  transcriptRootFallbackNotice,
} from "./lib/calibration-log-checkout";
import {
  parseTranscript,
  findRealPromptIndices,
  extractAssistantText,
  type TranscriptLine,
} from "../.minsky/hooks/transcript";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * mt#4971: resolved through the WRITER's own function rather than the pre-mt#4748
 * repo path, which no longer exists — reading it produced a SKIP that looked like
 * "no records" rather than "wrong location". `fallbackCwd` (not `projectDir`) keeps
 * the resolver's `CLAUDE_PROJECT_DIR` tier ahead of this checkout.
 *
 * `LOG_PATH` below still `resolve(REPO_ROOT, ...)`s this, which is a no-op for the
 * absolute default and remains correct for a relative `--log`.
 */
const DEFAULT_LOG = calibrationLogPath("code-mechanism-assertion", {
  fallbackCwd: REPO_ROOT,
});

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value !== undefined && value !== "" ? value : undefined;
}

const ARGV = process.argv.slice(2);
const LOG_PATH = resolve(REPO_ROOT, flag(ARGV, "--log") ?? DEFAULT_LOG);

/**
 * Claude Code derives its per-project transcript directory from the checkout
 * path with separators replaced by `-`, so the key is DERIVED, never hardcoded —
 * a pinned key silently takes the SKIP branch on every other machine
 * (the lesson PR #3037 R1 recorded for the sibling harness).
 */
function resolveTranscriptDir(): string | null {
  const explicit = flag(ARGV, "--transcripts") ?? process.env["MINSKY_TRANSCRIPTS_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;

  const projects = join(homedir(), ".claude", "projects");

  // mt#4971 / PR #3624 R1: this used to lead with `dirname(dirname(LOG_PATH))`, which
  // recovered the checkout from the pre-mt#4748 `<checkout>/.minsky/<file>` layout and
  // is why `--log <other-checkout>/…` steered transcript selection. A state-dir path
  // cannot carry that — `projects/<key>/` is a one-way hash — so that expression now
  // yields `<state dir>`, a directory that is not a checkout and whose slug will never
  // match. Ask for the legacy shape explicitly instead of computing a confident wrong
  // answer, and tell the caller when an explicit `--log` could not steer.
  const derivedCheckout = checkoutForLegacyLogPath(LOG_PATH);
  if (flag(ARGV, "--log") !== undefined && derivedCheckout === null) {
    process.stderr.write(`${transcriptRootFallbackNotice(LOG_PATH, REPO_ROOT)}\n`);
  }
  for (const checkout of derivedCheckout === null ? [REPO_ROOT] : [derivedCheckout, REPO_ROOT]) {
    const candidate = join(projects, checkout.replace(/[\\/]/g, "-"));
    if (existsSync(candidate)) return candidate;
  }
  if (!existsSync(projects)) return null;
  try {
    const matches = readdirSync(projects).filter((n) => n.endsWith("-minsky"));
    if (matches.length === 1) return join(projects, matches[0] as string);
    if (matches.length > 1) {
      // Never guess between checkouts (PR #3046 R1): picking the wrong one would
      // silently measure a DIFFERENT project's turns and report a plausible
      // number. Name the candidates and let the caller choose.
      process.stderr.write(
        `Ambiguous transcript store: ${matches.length} candidates under ${projects} ` +
          `(${matches.join(", ")}). Pass --transcripts <dir> to choose.\n`
      );
    }
  } catch {
    // intentional-swallow: unreadable projects dir is the same as absent here.
    return null;
  }
  return null;
}

const TRANSCRIPT_DIR = resolveTranscriptDir();

interface CalibrationRecord {
  timestamp?: string;
  session_id?: string;
  judgedInput?: { hash?: string; truncated?: boolean };
  [key: string]: unknown;
}

function readJsonl(path: string): CalibrationRecord[] {
  if (!existsSync(path)) return [];
  const out: CalibrationRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as CalibrationRecord);
    } catch {
      // intentional-swallow: a torn final line is expected in a live-appended log.
      continue;
    }
  }
  return out;
}

/** Every completed turn in the store, keyed by the hash the capture would record. */
function indexTurnsByJudgedHash(dir: string): Map<string, TranscriptLine[]> {
  const index = new Map<string, TranscriptLine[]>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    // intentional-swallow: an unreadable store is reported as a SKIP by the caller.
    return index;
  }

  for (const file of files) {
    let lines: TranscriptLine[];
    try {
      lines = parseTranscript(join(dir, file));
    } catch {
      // intentional-swallow: one unreadable transcript must not abort the sweep.
      continue;
    }
    const prompts = findRealPromptIndices(lines);
    for (let i = 0; i < prompts.length; i++) {
      const start = (prompts[i] as number) + 1;
      const end = i + 1 < prompts.length ? (prompts[i + 1] as number) : lines.length;
      const turn = lines.slice(start, end);
      if (turn.length === 0) continue;
      const text = extractAssistantText(turn);
      if (text.trim() === "") continue;
      const hash = hashJudgedText(elideBlocksAndQuotes(text));
      if (!index.has(hash)) index.set(hash, turn);
    }
  }
  return index;
}

const claimKey = (c: { symbol: string; predicate: string }): string => `${c.symbol}|${c.predicate}`;

interface Outcome {
  timestamp: string;
  before: string[];
  after: string[];
  silenced: string[];
}

function main(): void {
  if (TRANSCRIPT_DIR === null || !existsSync(TRANSCRIPT_DIR)) {
    process.stdout.write(
      "SKIP: transcript store not found — this replay reconstructs turn tool-calls from it.\n" +
        "Pass --transcripts <dir> or set MINSKY_TRANSCRIPTS_DIR.\n"
    );
    return;
  }

  const records = readJsonl(LOG_PATH);
  const auditable = records.filter((r) => hasJudgedInputCapture(r as Record<string, unknown>));
  const index = indexTurnsByJudgedHash(TRANSCRIPT_DIR);

  const outcomes: Outcome[] = [];
  let joined = 0;
  let unjoinable = 0;

  for (const record of auditable) {
    const hash = record.judgedInput?.hash;
    const turn = typeof hash === "string" ? index.get(hash) : undefined;
    if (turn === undefined) {
      unjoinable += 1;
      continue;
    }
    joined += 1;

    const text = extractAssistantText(turn);
    const corpusBefore = buildVerificationCorpus(turn, { includeCallRecord: false });
    const corpusAfter = buildVerificationCorpus(turn);

    const before = detectCodeMechanismAssertion(text, corpusBefore, "").claims.map(claimKey);
    const after = detectCodeMechanismAssertion(text, corpusAfter, "").claims.map(claimKey);
    const silenced = before.filter((c) => !after.includes(c));
    if (silenced.length > 0 || before.length !== after.length) {
      outcomes.push({ timestamp: record.timestamp ?? "unknown", before, after, silenced });
    }
  }

  process.stdout.write(
    `records: ${records.length}  capture-bearing: ${auditable.length}\n` +
      `joined to a real turn: ${joined}   unjoinable: ${unjoinable}\n`
  );

  if (ARGV.includes("--validate")) {
    process.stdout.write(
      `\nturns indexed from the store: ${index.size}\n` +
        `join is by exact hash — hashJudgedText(elideBlocksAndQuotes(assistantText)) — not a text match.\n` +
        `An unjoinable record is reported, never counted as agreement.\n`
    );
    return;
  }

  const totalSilenced = outcomes.reduce((n, o) => n + o.silenced.length, 0);
  process.stdout.write(
    `\n## Backing change (SC4 / SC5)\n\n` +
      `records whose claim set changed: ${outcomes.length}/${joined}\n` +
      `claims newly backed (silenced) : ${totalSilenced}\n\n` +
      `Per record — read each one against its turn before accepting it:\n`
  );
  if (outcomes.length === 0) {
    process.stdout.write("  (none)\n");
  } else {
    for (const o of outcomes) {
      process.stdout.write(`  ${o.timestamp}  silenced=[${o.silenced.join(", ")}]\n`);
    }
  }
}

main();
