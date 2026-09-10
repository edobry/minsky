#!/usr/bin/env bun
/**
 * mt#4969 AT1-AT3 — replay a wall-of-text calibration window through the
 * depth-request gate BEFORE and AFTER the two-entry widening, and assert the
 * change suppresses exactly the records it was calibrated from.
 *
 * ## Why a replay rather than reasoning about the regexes
 *
 * mt#4969's acceptance test is deliberately NEGATIVE: the newly-suppressed
 * count must be EXACTLY 3, so an over-broad pattern FAILS rather than passes.
 * That is not a property you can read off a regex — the window's fourth
 * near-miss record (2026-09-02T20:07:35.858Z) buries "dive deeper into" ~830
 * characters into a 960-character prompt, where it names a research TARGET
 * inside a hypothetical rather than requesting a longer answer. Only running
 * the real pattern list over the real corpus separates the two.
 *
 * ## BEFORE and AFTER, and the canary that keeps them different
 *
 * BEFORE is the shipped `DEPTH_REQUEST_PATTERNS` minus the two entries this
 * task adds, selected BY NAME; AFTER is the whole list. Both sides come from
 * the same import, so there is no stale-copy drift — but that also makes it
 * possible to compare a list against itself and print a clean, meaningless
 * zero (mem#1208: "a before/after probe must import the REAL pre-fix module",
 * and its first attempt called the same patched function on both sides).
 * `assertCanary` below fails CLOSED on exactly that: it requires both new
 * names to be present, the two sides to differ in length by 2, and the
 * measured dive-deeper prompt to match AFTER and NOT match BEFORE. If the
 * entries are ever renamed or removed, this exits 2 rather than reporting a
 * pass.
 *
 * ## What the replay can and cannot see
 *
 * Each calibration record captures ONE prompt (`precedingPrompt`), while the
 * live gate scans up to `DEPTH_REQUEST_LOOKBACK_TURNS` principal prompts. So
 * this replay is a LOWER bound on live suppression: a record whose match sat
 * two prompts back is invisible here. Records with `precedingPrompt.truncated:
 * true` are likewise seen only in part, and are counted and reported
 * separately rather than silently folded in.
 *
 * ## Why this is not `replay-wall-of-text-window.ts`
 *
 * That sibling (mt#4531) replays real TRANSCRIPTS to choose the detector's
 * measured-window METRIC, and it does exercise the depth gate on the way
 * (`SUPPRESSION_DEPTH_REQUEST`). Different question, different input: this one
 * asks whether a change to the depth gate's PATTERN LIST suppresses exactly
 * the records it was calibrated from, and mt#4969's AT1 states that over the
 * calibration log's injected records — which is what this reads.
 *
 * The sibling is nonetheless the STRONGER instrument for the bound above: a
 * transcript replay sees the full `DEPTH_REQUEST_LOOKBACK_TURNS` window, where
 * this sees one captured prompt. If a future widening's claim turns on records
 * whose match may sit further back, extend that script rather than this one.
 *
 * Exit 0 = checked, every assertion holds. Exit 1 = checked, an assertion
 * failed. Exit 2 = the check could not run (no log, no records, canary
 * broken) — never conflated with a pass.
 *
 * Usage:
 *   bun scripts/measure-depth-request-widening.ts
 *   bun scripts/measure-depth-request-widening.ts --project-dir /path/to/main/repo
 *   bun scripts/measure-depth-request-widening.ts --log /path/to/wall-of-text-calibration.jsonl
 *   bun scripts/measure-depth-request-widening.ts --window 120 --verbose
 *
 * From a Minsky session workspace, pass `--project-dir` (the MAIN checkout) or
 * `--log`: the log is keyed by project root, so resolving from the clone finds
 * an empty path.
 */
import { readFileSync } from "fs";

import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import { DEPTH_REQUEST_PATTERNS } from "../.minsky/hooks/wall-of-text-detector";

/** The two entries mt#4969 adds. BEFORE is the shipped list minus these. */
const NEW_PATTERN_NAMES = ["lets-dive-deeper", "tell-me-more"] as const;

/**
 * One probe per new entry, each drawn from the record that entry is calibrated
 * from. `assertCanary` requires every probe to match AFTER *via its own named
 * pattern* and to match nothing in BEFORE — so the canary fails closed if
 * either entry is renamed, removed, or broadened enough to swallow the other's
 * probe.
 */
const CANARY_PROBES: ReadonlyArray<{ pattern: string; probe: string }> = [
  {
    pattern: "lets-dive-deeper",
    probe: "lets dive deeper into the community discourse around this",
  },
  { pattern: "tell-me-more", probe: "tell me more about their concept of an exit handoff" },
];

/** The calibration stream this detector writes to. */
const CALIBRATION_LOG_NAME = "wall-of-text";

/** The window mt#4969's re-measurement is stated against: `head -120`. */
const DEFAULT_WINDOW = 120;

/** mt#4969 AT1 — the newly-suppressed count must be this, not "at least" this. */
const EXPECTED_NEWLY_SUPPRESSED = 3;

/**
 * The window's fourth "dive deeper" record — an injected fire that must STAY
 * injected. Its 960-character prompt reaches "... or if we want to dive deeper
 * into the claude code binary itself ..." only around offset 830, naming a
 * research target inside a hypothetical rather than requesting a longer answer.
 */
const NEAR_MISS_TIMESTAMP = "2026-09-02T20:07:35.858Z";

/** One record's worth of what this replay needs. Everything else is ignored. */
interface ReplayRecord {
  readonly timestamp: string;
  readonly prompt: string;
  readonly truncated: boolean;
  readonly largestBlockWords: number | null;
  /** True when EITHER suppression gate already fired — i.e. not an injected fire. */
  readonly alreadySuppressed: boolean;
}

interface Pattern {
  readonly name: string;
  readonly re: RegExp;
}

function matches(patterns: ReadonlyArray<Pattern>, text: string): string | null {
  for (const p of patterns) {
    // Fresh test per call: these are non-global regexes, so lastIndex is not carried.
    if (p.re.test(text)) return p.name;
  }
  return null;
}

function parseArgs(argv: string[]): {
  log?: string;
  projectDir?: string;
  window: number;
  verbose: boolean;
} {
  let log: string | undefined;
  let projectDir: string | undefined;
  let window = DEFAULT_WINDOW;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--log") log = argv[++i];
    else if (arg === "--project-dir") projectDir = argv[++i];
    else if (arg === "--window") window = Number(argv[++i]);
    else if (arg === "--verbose") verbose = true;
  }
  return { log, projectDir, window, verbose };
}

function die(code: 1 | 2, message: string): never {
  console.error(`[measure-depth-request-widening] ${message}`);
  process.exit(code);
}

/**
 * Fail CLOSED unless BEFORE and AFTER genuinely differ. Without this the
 * script's central comparison could be list-against-itself, which prints a
 * clean zero and means nothing.
 */
function assertCanary(before: ReadonlyArray<Pattern>, after: ReadonlyArray<Pattern>): void {
  const names = after.map((p) => p.name);
  for (const required of NEW_PATTERN_NAMES) {
    if (!names.includes(required)) {
      die(2, `canary: DEPTH_REQUEST_PATTERNS has no "${required}" entry — nothing to measure`);
    }
  }
  if (after.length - before.length !== NEW_PATTERN_NAMES.length) {
    die(
      2,
      `canary: BEFORE/AFTER differ by ${after.length - before.length}, expected ${NEW_PATTERN_NAMES.length}`
    );
  }
  // A positive control per ENTRY, on each side: every probe must match AFTER
  // *through its own pattern* and must NOT match BEFORE. This is what makes
  // the newly-suppressed count below evidence about the CHANGE rather than
  // about the corpus.
  //
  // PR #3699 R1 NON-BLOCKING — one probe covering only `lets-dive-deeper` left
  // the canary able to pass while `tell-me-more` was renamed, broadened, or
  // removed, since the surviving entry satisfied it alone. Probing per entry,
  // and asserting the MATCHING PATTERN'S NAME rather than merely that
  // something matched, closes both halves: a probe that starts resolving
  // through a different entry now fails closed too.
  for (const { pattern, probe } of CANARY_PROBES) {
    const hit = matches(after, probe);
    if (hit !== pattern) {
      die(
        2,
        `canary: "${probe}" matches AFTER via ${hit ?? "nothing"}, expected ${pattern} — the probe no longer exercises the entry it is for`
      );
    }
    if (matches(before, probe) !== null) {
      die(2, `canary: "${probe}" already matches BEFORE — it cannot evidence the ${pattern} entry`);
    }
  }
}

function loadWindow(logPath: string, window: number): ReplayRecord[] {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf-8");
  } catch (err) {
    die(2, `cannot read ${logPath}: ${String(err)}`);
  }

  const records: ReplayRecord[] = [];
  for (const line of raw.split("\n").slice(0, window)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a partial trailing write is not a reason to fail the run
    }
    const r = parsed as {
      timestamp?: string;
      largestBlockWords?: number;
      suppressedByDepthRequest?: boolean;
      suppressedByQuestionAnswer?: boolean;
      precedingPrompt?: { excerpt?: string; truncated?: boolean };
    };
    records.push({
      timestamp: typeof r.timestamp === "string" ? r.timestamp : "(no timestamp)",
      prompt: r.precedingPrompt?.excerpt ?? "",
      truncated: r.precedingPrompt?.truncated === true,
      largestBlockWords: typeof r.largestBlockWords === "number" ? r.largestBlockWords : null,
      alreadySuppressed:
        r.suppressedByDepthRequest === true || r.suppressedByQuestionAnswer === true,
    });
  }
  return records;
}

/** Prompt-shape classes mt#4969's AT2/AT3 and its re-measurement pin as still-firing. */
const CONTROL_CLASSES: ReadonlyArray<{ label: string; at: string; re: RegExp }> = [
  // AT2 — bare go-aheads. The principal asked for nothing; neither new pattern
  // can reach them, and a widening that did would silence the detector's core case.
  { label: "bare go-ahead", at: "AT2", re: /^\s*(?:proceed\.?|\.|let'?s keep going\.?)\s*$/i },
  // AT3 — the handoff class, this task's explicit NON-goal. mt#4969's
  // re-measurement classifies these as mostly the detector working correctly.
  //
  // ANCHORED, and that is not a detail. A bare /\bhandoff\b/i is the wrong
  // instrument for this class: it matches the word ANYWHERE, so it sweeps in
  // prompts that DISCUSS handoffs rather than request one — including this
  // task's own `tell me more about their concept of an "exit handoff"` record,
  // which then reads as the widening silencing a handoff fire. Measured over
  // the window: 25 injected prompts contain the word, 23 are the class (22
  // `handoff <ref>` plus `Handoff.`), and the 2 remainders are a topic mention
  // inside a long prompt. The class is a REQUEST for a handoff, so the control
  // has to be anchored the way the spec states it ("a `handoff`-prefixed
  // prompt").
  { label: "handoff request", at: "AT3", re: /^\s*(?:give me\s+a\s+)?handoff\b/i },
  // The brevity class: the principal asked for LESS and got an over-budget
  // block, so these are unambiguous true positives.
  { label: "brevity request", at: "SC5", re: /\b(?:concise(?:ly)?|high-level|summarize)\b/i },
];

function main(): void {
  const { log, projectDir, window, verbose } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(window) || window <= 0) die(2, `--window must be a positive number`);

  const after = [...DEPTH_REQUEST_PATTERNS] as Pattern[];
  const before = after.filter(
    (p) => !(NEW_PATTERN_NAMES as ReadonlyArray<string>).includes(p.name)
  );
  assertCanary(before, after);

  const logPath = log ?? calibrationLogPath(CALIBRATION_LOG_NAME, { projectDir });
  const all = loadWindow(logPath, window);
  if (all.length === 0) {
    die(2, `no parseable records in ${logPath} — an empty window is a broken check, not a pass`);
  }

  const injected = all.filter((r) => !r.alreadySuppressed);
  const suppressed = all.length - injected.length;
  const truncated = injected.filter((r) => r.truncated).length;

  const newlySuppressed = injected.filter(
    (r) => matches(before, r.prompt) === null && matches(after, r.prompt) !== null
  );

  console.log(`[measure-depth-request-widening] log: ${logPath}`);
  console.log(
    `  window: head -${window} -> ${all.length} records; ${injected.length} injected / ${suppressed} suppressed`
  );
  console.log(
    `  patterns: BEFORE ${before.length} -> AFTER ${after.length} (added ${NEW_PATTERN_NAMES.join(", ")})`
  );
  if (truncated > 0) {
    console.log(
      `  NOTE: ${truncated} injected record(s) carry a TRUNCATED prompt — the replay sees less of those than the live gate does.`
    );
  }

  console.log(
    `\n  AT1 — newly suppressed: ${newlySuppressed.length} (expected exactly ${EXPECTED_NEWLY_SUPPRESSED})`
  );
  for (const r of newlySuppressed) {
    const words = r.largestBlockWords === null ? "?" : `${r.largestBlockWords}w`;
    console.log(`    ${r.timestamp}  ${words}  via ${matches(after, r.prompt)}`);
    console.log(`      ${r.prompt.slice(0, 110).replace(/\s+/g, " ")}...`);
  }

  const failures: string[] = [];
  if (newlySuppressed.length !== EXPECTED_NEWLY_SUPPRESSED) {
    failures.push(
      `AT1: newly-suppressed count is ${newlySuppressed.length}, expected exactly ${EXPECTED_NEWLY_SUPPRESSED}`
    );
  }

  // The near-miss, pinned by RECORD ID rather than by a regex class — this is
  // the single record that decides whether `lets-dive-deeper` is correctly
  // shaped, so it gets an assertion that cannot drift with a class definition.
  // A bare /\bdive deeper into\b/ suppresses it and takes AT1 to 4.
  const nearMiss = injected.find((r) => r.timestamp === NEAR_MISS_TIMESTAMP);
  if (nearMiss === undefined) {
    failures.push(
      `AT1 near-miss: record ${NEAR_MISS_TIMESTAMP} is not an injected fire in this window — the control cannot fail`
    );
  } else if (newlySuppressed.includes(nearMiss)) {
    failures.push(
      `AT1 near-miss: the widening silenced ${NEAR_MISS_TIMESTAMP}, whose prompt names a research target inside a hypothetical rather than asking for a longer answer`
    );
  } else {
    console.log(`  AT1 near-miss — ${NEAR_MISS_TIMESTAMP} still fires (expected).`);
  }

  // Each control class must be non-empty (otherwise the assertion below is
  // vacuous — mem#704) AND wholly untouched by the widening.
  console.log("");
  for (const cls of CONTROL_CLASSES) {
    const members = injected.filter((r) => cls.re.test(r.prompt));
    const silenced = members.filter((r) => newlySuppressed.includes(r));
    console.log(
      `  ${cls.at} — ${cls.label}: ${members.length} injected, ${silenced.length} newly suppressed (expected 0)`
    );
    if (members.length === 0) {
      failures.push(`${cls.at}: the "${cls.label}" class is EMPTY — the control cannot fail`);
    }
    if (silenced.length > 0) {
      failures.push(
        `${cls.at}: the widening silenced ${silenced.length} "${cls.label}" record(s): ${silenced
          .map((r) => r.timestamp)
          .join(", ")}`
      );
    }
    if (verbose) {
      for (const r of members) console.log(`      ${r.timestamp}  ${r.prompt.slice(0, 80)}`);
    }
  }

  if (failures.length > 0) {
    console.error("\n[measure-depth-request-widening] FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n[measure-depth-request-widening] PASS — AT1, AT2, AT3 hold on this window.");
}

if (import.meta.main) main();
