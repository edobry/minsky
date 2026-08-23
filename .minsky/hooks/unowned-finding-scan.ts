#!/usr/bin/env bun
// PostToolUse, LOG-ONLY: a spec goes DONE carrying a findings-section item that
// names no owner (mt#4246).
//
// Several specs in this repo carry a `### Noticed, not actioned` section. The
// convention is good — an implementer who spots something adjacent should write
// it down rather than silently widen scope. But the section DISCHARGES the
// noticing obligation without creating an owner, and it does so while reading as
// diligence: `work-completion.mdc §Never notice an issue without acting on it`
// demands "file a task, update a spec, or save a memory", and writing the
// finding into a spec section literally IS updating a spec. The rule is
// satisfied on its face and defeated in substance.
//
// WHY THE THREE SIBLING GUARDS ARE BLIND TO IT:
//   - `turn-end-untaken-action-scan` reads `last_assistant_message`. The finding
//     was never in chat; it was in a `tasks_spec_patch` argument.
//   - `turn-end-unwalked-task-scan` triggers on a `tasks_create` MINT. Nothing
//     was minted — that is the failure.
//   - `stop-at-decision-scan` triggers on a spec-patch into an open NON-BOUND
//     task. This patch goes into the agent's OWN task, correctly suppressed.
//
// ORIGINATING INCIDENT (2026-08-17/18): one session, three instances, with the
// pattern NAMED aloud in between. mt#3845's Outcome recorded two items; one
// became mt#4238 *because* the agent said "a note in a task's outcome is where
// work goes to be lost", and the other — that mt#3130's build list still
// described a prerequisite on a premise already known false — was left. A third,
// a measured detector gap in mt#4228's spec, carried a "file separately if the
// measurement justifies it" conditional never discharged. Both survivors were
// caught only when the principal asked "are you sure there's nothing remaining?"
//
// EVENT CHOICE — `PostToolUse`, deviating from the spec's "Stop/PreToolUse"
// wording, recorded per the spec-decision-reconciliation discipline. This guard
// never denies, so PreToolUse buys nothing; PostToolUse additionally means a
// FAILED transition writes no record, and it matches the sibling already keyed
// on this tool+status axis (`drive-ready-to-implementation.ts`, PostToolUse on
// → READY).
//
// OWNERSHIP IS A MARKER, NOT A REFERENCE — and the corpus is why. An earlier
// draft discharged an item on any `mt#N`-shaped reference. A reference in
// SUBJECT position is indistinguishable from one in OWNER position to such a
// test ("filed as mt#4238" vs "mt#3130's build list is stale"), and that draft
// shipped with the miss recorded as a known limit, to be measured.
//
// The measurement came back total, and the counts below are stated at two
// points because the guard changed between them (PR #3098 R4, NON-BLOCKING —
// this paragraph carried the first set as if it were the final one).
//
// At the time of the reference test, `scripts/replay-unowned-findings.ts` saw
// only LIST items, and found FOUR of them across three specs — every one
// carrying a reference in subject position, none in owner position. The
// reference test discharged 4 of 4, including BOTH originating items. Its
// recall on the class it exists to catch was zero, so it is gone rather than
// annotated.
//
// Widening to prose-bodied sections (see `closeSection` below) then took the
// corpus figure to SIX items across FOUR specs — mt#3845 x2, mt#4220 x2,
// mt#4228, mt#3265 — of which five carry a bare reference and the sixth,
// mt#3265's prose section, carries none. That sixth was invisible to the
// list-only scan entirely, which is the point of the widening.
//
// Corpus size is ~4,130 specs and moves with the task table; the replay reports
// the figure it actually scanned rather than a number pinned here. An earlier
// draft of this comment pinned 4,146 — the raw `task_specs` count, which is
// higher than what the replay scans because its join drops specs whose task row
// no longer exists.
//
// The replacement is an explicit `[owner: mt#N]` marker. This is not a widening
// of the pattern — "filed as|tracked by|owned by" over free text is exactly the
// ADR-024 Rung-2 phrase corpus this guard must not become. It moves the judgment
// to the author: the guard checks that ownership was DECLARED, never infers it.
//
// The cost is honest and is the point: an item whose owner exists but is not
// declared in the spec still fires. That is correct. mt#3845's first item WAS
// actioned (mt#4238 was filed) and its spec text still says only "it needs a
// follow-up task filed" — a reader of that record cannot tell it is owned, which
// is the defect this guard is named for, not a false positive. A bare reference
// is still RECORDED on each finding (`bareRefPresent`) so a future calibration
// review can measure how often one appears without re-running the corpus.
//
// LOG-ONLY (calibration-first, mt#2263 ladder): the heading match is structural,
// but whether a findings item genuinely needs an owner is a judgment this cannot
// make. The false-positive rate is measured before anything injects. This guard
// NEVER returns `additionalContext` and never denies.
//
// @see mt#4246 — this guard; mem#799 §The ARTIFACT surface — the incident record
// @see .minsky/hooks/turn-end-unwalked-task-scan.ts — mint-keyed sibling
// @see .minsky/hooks/stop-at-decision-scan.ts — spec-patch-keyed sibling
// @see docs/architecture/adr-042-gate-battery-enforcement-shape.md — the
//   structured-trace discriminator this applies by analogy

import { logCalibrationRecord } from "./dispatcher";
import { execWithPath, readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_UNOWNED_FINDING_SCAN";
export const GUARD_NAME = "unowned-finding-scan";
export const CALIBRATION_LOG = "unowned-finding-calibration";
export const TARGET_TOOL_NAME = "mcp__minsky__tasks_status_set";
export const TRIGGER_STATUS = "DONE";

/**
 * Cap on the spec read. Generous relative to the sibling's kind-read because a
 * spec body is larger, and bounded because a hung read must not stall the
 * PostToolUse path for a guard that only writes a log line.
 */
const SPEC_READ_TIMEOUT_MS = 20_000;

/**
 * Headings whose body is a findings list.
 *
 * **Deliberately over-matching, with the precision in the READING.** Same
 * discipline `/plan-task` Step 2 item 6 applies to required-actions sections: a
 * loose pattern plus a precise read costs one line of triage, while a tight
 * pattern costs a missed item — which is the failure this guard exists to
 * prevent. The RESOLVED-record counterpart is handled by {@link isDischargeRecord}.
 */
export const FINDING_SECTION_PATTERNS: readonly RegExp[] = [
  /\bnoticed,?\s*(but\s+)?not\s+(actioned|fixed|acted\s+on)\b/i,
  /\bnot\s+actioned\b/i,
  /\brecorded,?\s*(but\s+)?not\s+(fixed|actioned|acted\s+on)\b/i,
  /\bout\s+of\s+scope\s+but\s+worth\s+doing\b/i,
];

/**
 * Headings that RECORD a discharge rather than owing work.
 *
 * `## Required actions resolved (2026-08-16)` is a record of work already done;
 * treating it as owed is the over-match this pairs with. Checked BEFORE the
 * finding patterns so "recorded, not fixed — RESOLVED" reads as resolved.
 */
export const DISCHARGE_RECORD_PATTERNS: readonly RegExp[] = [
  /\bresolved\b/i,
  /\bdischarged\b/i,
  /\bactioned\s+(since|later|in)\b/i,
];

/**
 * Any Minsky-shaped task reference. Multi-backend by construction (mt#3730's
 * lesson).
 *
 * NOT an ownership test — see the header. This is recorded on each finding so
 * the calibration review can measure how often a fired item carries a bare
 * reference, and is deliberately never consulted to suppress one.
 */
const TASK_REF_RE = /\b[a-z]{2,}#\d+\b/;

/**
 * The explicit ownership marker — the ONLY thing that discharges an item by
 * naming an owner.
 *
 * Same construction and same rationale as {@link NO_OWNER_MARKER_RE} below: the
 * author declares, the guard checks presence. `[owner: mt#4238]` is a claim a
 * reader of the spec can act on; `mt#4238` loose in a sentence is not, because
 * the sentence may be about that task rather than assigning to it.
 *
 * mt#4246's SC2 says this in the spec's own words as of 2026-08-18: "an item
 * carrying an `[owner: mt#N]` marker does NOT fire … a bare task reference does
 * NOT discharge an item". It previously said a bare reference discharged, which
 * is the criterion this module was built against and then measured against —
 * see the header. The criterion was amended rather than the behaviour, because
 * the measurement is what settled it; a deviation explained here while the
 * criterion still said otherwise is the mt#4213 shape (PR #3098 R3).
 */
const OWNER_MARKER_RE = /\[owner:[^\]]*\S[^\]]*\]/i;

/**
 * The explicit no-owner marker.
 *
 * **A MARKER rather than prose-reason recognition, and that choice is
 * load-bearing.** The spec's criterion ORIGINALLY read "a task ref OR a stated
 * reason" — both halves are now markers, and SC2 says so (amended 2026-08-18,
 * PR #3098 R3). The obvious implementation of the original — detect whether the item contains a reason —
 * would be a phrase corpus over free text, which ADR-024 assigns to Rung 2 and
 * whose recall arms-race that ADR exists to end. A marker moves the judgment to
 * the author, where it belongs: the guard checks that a reason was STATED, never
 * whether it is a good one. It also matches the convention the execution-evidence
 * gate already teaches (`[scN-deferred: mt#NNNN]`, `[negative-control-deferred: …]`).
 */
const NO_OWNER_MARKER_RE = /\[no-owner:[^\]]*\S[^\]]*\]/i;

/** A markdown heading line → its level and title, or null. */
export function parseHeading(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  const hashes = match?.[1];
  const title = match?.[2];
  if (hashes === undefined || title === undefined) return null;
  return { level: hashes.length, title: title.trim() };
}

export function isFindingSection(title: string): boolean {
  if (DISCHARGE_RECORD_PATTERNS.some((re) => re.test(title))) return false;
  return FINDING_SECTION_PATTERNS.some((re) => re.test(title));
}

export function isDischargeRecord(title: string): boolean {
  return DISCHARGE_RECORD_PATTERNS.some((re) => re.test(title));
}

/** A top-level list item start: `-`, `*`, `+`, or `1.` at column 0-3. */
function isListItemStart(line: string): boolean {
  return /^ {0,3}(?:[-*+]|\d+\.)\s+\S/.test(line);
}

export interface UnownedFinding {
  /** The heading the item was found under, verbatim. */
  section: string;
  /** The item's text, joined across its continuation lines and trimmed. */
  item: string;
  /**
   * Whether the item carries a bare task reference somewhere in its text.
   * Calibration data only — never suppresses the finding (see the header).
   */
  bareRefPresent: boolean;
}

/**
 * Pure core — exported for tests and the replay script. No IO.
 *
 * Walks the spec's headings, and for each findings section collects the
 * top-level list items carrying neither the explicit `[owner: …]` marker nor
 * the explicit `[no-owner: …]` marker. Continuation lines are folded into their item so a
 * reference on a wrapped second line still counts.
 */
export function detectUnownedFindings(specText: string): UnownedFinding[] {
  const lines = specText.split("\n");
  const findings: UnownedFinding[] = [];

  let section: string | null = null;
  let sectionLevel = 0;
  let buffer: string[] = [];
  let sawListItem = false;
  let prose: string[] = [];
  let inFence = false;

  const record = (text: string): void => {
    if (section === null) return;
    const item = text.replace(/\s+/g, " ").trim();
    if (item === "") return;
    if (OWNER_MARKER_RE.test(item)) return;
    if (NO_OWNER_MARKER_RE.test(item)) return;
    findings.push({ section, item, bareRefPresent: TASK_REF_RE.test(item) });
  };

  const flushItem = (): void => {
    const text = buffer.join(" ");
    buffer = [];
    record(text);
  };

  /**
   * A findings section whose body is PROSE counts as one finding.
   *
   * Not a widening for its own sake — mt#4228's real section is exactly this
   * shape ("The third guard, recorded not fixed", four paragraphs, an
   * undischarged "file separately if the measurement justifies it", and no
   * bullet anywhere). A list-items-only reading makes "write the finding as a
   * paragraph" a complete evasion of a guard whose entire trigger is the
   * heading above it, and the heading is the structural trace — the bullet is
   * formatting.
   *
   * Distinct from the limitation the spec accepts: a loose sentence in
   * `## Outcome` under NO findings heading stays invisible here, because there
   * is no structural trace to key on. That one is a semantic judgment; this is
   * not.
   */
  const closeSection = (): void => {
    flushItem();
    if (section !== null && !sawListItem) record(prose.join(" "));
    prose = [];
    sawListItem = false;
  };

  for (const line of lines) {
    // Fences are tracked before the heading test so a `#` line inside a code
    // block cannot open or close a section.
    //
    // Tracked UNCONDITIONALLY — not only while a section is open (PR #3098 R1,
    // BLOCKING). Gating the toggle on `section !== null` meant a fence opened
    // OUTSIDE any findings section never set the flag, so a `### Noticed, not
    // actioned` line inside that fence was read as a real heading and opened a
    // section. That is not a hypothetical shape: mt#4246's own spec, mt#4228's,
    // and this PR's body all quote findings headings inside fences, so the
    // guard would have fired on its own documentation.
    //
    // Fence state is a property of the DOCUMENT, not of a section, which is
    // also why `closeSection` no longer resets it — a section boundary cannot
    // occur inside a fence, and clearing the flag there would resynchronize the
    // parser to the wrong parity.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = parseHeading(line);
    if (heading !== null) {
      // Any heading ends the open list ITEM — a bullet cannot span one.
      flushItem();
      // Only a heading at the same or higher level ends the SECTION. A DEEPER
      // subheading leaves it open, and prose keeps accumulating across it.
      //
      // The two used to be conflated: `closeSection()` ran on every heading
      // while a section was open, and since it is what records a prose-bodied
      // section, a `####` subheading before the first bullet emitted the
      // preamble above it as its own finding — then reset, so a section with
      // three subheadings produced three items where there is one (PR #3098 R2,
      // NON-BLOCKING). Flushing the item and closing the section are different
      // events at different granularities; they are separate calls now.
      const closes = section !== null && heading.level <= sectionLevel;
      if (closes) {
        closeSection();
        section = null;
      }
      if (isFindingSection(heading.title)) {
        section = heading.title;
        sectionLevel = heading.level;
      }
      continue;
    }

    if (section === null) continue;

    if (isListItemStart(line)) {
      flushItem();
      sawListItem = true;
      buffer.push(line.replace(/^ {0,3}(?:[-*+]|\d+\.)\s+/, ""));
      continue;
    }

    // A continuation line belongs to the open item; a blank line ends it.
    if (line.trim() === "") {
      flushItem();
      continue;
    }
    if (buffer.length > 0) buffer.push(line.trim());
    else if (!sawListItem) prose.push(line.trim());
  }

  closeSection();
  return findings;
}

// --- IO shell ---------------------------------------------------------------

export interface ScanDeps {
  readSpec: (taskId: string) => string | null;
}

/** Live read of a task's spec body via the CLI. Returns null on any failure. */
export function readSpecViaCLI(taskId: string): string | null {
  const result = execWithPath(["minsky", "tasks", "spec", "get", taskId, "--json"], {
    timeout: SPEC_READ_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { content?: unknown };
    return typeof parsed.content === "string" ? parsed.content : null;
  } catch {
    // Fails OPEN: an unreadable spec records nothing rather than guessing.
    return null;
  }
}

export function resolveTaskId(input: ToolHookInput): string | null {
  const value = (input.tool_input as Record<string, unknown> | undefined)?.["taskId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function resolveNewStatus(input: ToolHookInput): string | null {
  const requested = (input.tool_input as Record<string, unknown> | undefined)?.["status"];
  if (typeof requested === "string" && requested.length > 0) return requested.toUpperCase();
  const applied = (input.tool_response as Record<string, unknown> | undefined)?.["newStatus"];
  return typeof applied === "string" && applied.length > 0 ? applied.toUpperCase() : null;
}

/**
 * The decision, with IO injected. Returns the findings to record, or an empty
 * array when this call is not a candidate at all.
 */
export function decideFindings(input: ToolHookInput, deps: ScanDeps): UnownedFinding[] {
  if (input.tool_name !== TARGET_TOOL_NAME) return [];
  if (resolveNewStatus(input) !== TRIGGER_STATUS) return [];
  const taskId = resolveTaskId(input);
  if (taskId === null) return [];
  const spec = deps.readSpec(taskId);
  if (spec === null) return [];
  return detectUnownedFindings(spec);
}

export function isOverridden(env: Record<string, string | undefined>): boolean {
  return env[OVERRIDE_ENV_VAR] === "1";
}

async function main(): Promise<void> {
  const input = (await readInput()) as ToolHookInput;
  if (isOverridden(process.env)) {
    writeOutput({});
    return;
  }

  const findings = decideFindings(input, { readSpec: readSpecViaCLI });
  if (findings.length > 0) {
    logCalibrationRecord(CALIBRATION_LOG, {
      timestamp: new Date().toISOString(),
      session_id: input.session_id ?? null,
      guardName: GUARD_NAME,
      taskId: resolveTaskId(input),
      findingCount: findings.length,
      findings: findings.slice(0, 10),
    });
  }

  // LOG-ONLY: never denies, never injects.
  writeOutput({});
}

if (import.meta.main) {
  void main();
}
