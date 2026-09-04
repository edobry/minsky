#!/usr/bin/env bun
/**
 * Why does the pre-narration trailing window not suppress these fires? (mt#3864)
 *
 * mt#3864's 2026-08-13 amendment attributed its dominant false-positive class to
 * the detector "requiring the evidencing tool call in the SAME turn". That is
 * false: `TRAILING_WINDOW_TURNS = 12` and `extractWindowToolUseNames` have
 * implemented cross-turn suppression since mt#2671. So the real question — and
 * the one this script answers with a measurement rather than a hypothesis — is
 * why the existing window misses.
 *
 * For every INJECTED (unsuppressed) record it locates the fire in its session
 * transcript, walks backwards counting real-user-prompt boundaries exactly as
 * `extractWindowToolUseNames` does, and reports the boundary distance at which
 * the category's nearest `requiredTools` occurrence sits. That distance splits
 * the population into three causes with three different fixes:
 *
 *   - `within-window`  — a required tool IS inside 12 boundaries, so suppression
 *                        should have fired. A bug in the window path.
 *   - `beyond-window`  — the tool is present but further back than 12. The
 *                        window is too short; widening is the fix.
 *   - `tool-absent`    — no required tool anywhere before the fire. No window
 *                        change can reach this; it is the third-party /
 *                        observed-elsewhere class, and belongs to the
 *                        subject-attribution criterion instead.
 *
 * Read-only. Never writes to the calibration log.
 *
 * Usage:
 *   bun scripts/diagnose-pre-narration-window.ts
 *   bun scripts/diagnose-pre-narration-window.ts --since 2026-08-13
 *   bun scripts/diagnose-pre-narration-window.ts --since 2026-08-09 --until 2026-08-19T03:20:00Z
 *   bun scripts/diagnose-pre-narration-window.ts --json
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  OUTCOME_CATEGORIES,
  TRAILING_WINDOW_TURNS,
  buildIdentityEvidence,
  detectPreNarrationWithSuppression,
  elideMarkdownContexts,
  extractClaimedPrNumber,
  extractUniqueClaimedPrNumber,
  extractPrNumbersForTools,
  extractWindowToolUseNames,
  windowSlice,
} from "../.minsky/hooks/pre-narration-detector";
import {
  extractAssistantText,
  extractLastAssistantTurn,
  extractToolUseNames,
  isRealUserPrompt,
  parseTranscript,
} from "../.minsky/hooks/transcript";
import type { TranscriptLine } from "../.minsky/hooks/transcript";
import { calibrationLogPath } from "../.minsky/hooks/dispatcher";

/**
 * Default resolves beside this script. Calibration logs are NOT tracked in git,
 * so a session workspace has none — pass `--log` pointing at the main checkout's
 * copy when running from a session.
 */
/**
 * mt#4971: resolved through the WRITER's own function rather than the pre-mt#4748
 * repo path, which no longer exists — reading it produced a SKIP that looked like
 * "no records" rather than "wrong location". `fallbackCwd` (not `projectDir`) keeps
 * the resolver's `CLAUDE_PROJECT_DIR` tier ahead of this checkout.
 */
const DEFAULT_LOG = calibrationLogPath("pre-narration", {
  fallbackCwd: resolve(import.meta.dir, ".."),
});
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface CalibrationMatch {
  category: string;
  phrase: string;
  context?: string;
  hadMatchingTool?: boolean;
}
interface CalibrationRecord {
  timestamp: string;
  session_id?: string;
  suppressionReasons?: string[];
  matches?: CalibrationMatch[];
}

type Cause = "within-window" | "beyond-window" | "tool-absent" | "identity-backed" | "unreplayable";

export interface Finding {
  timestamp: string;
  sessionId: string;
  category: string;
  phrase: string;
  /** Real-user-prompt boundaries between the fire and the nearest required tool. */
  boundariesBack: number | null;
  cause: Cause;
  detail?: string;
  /**
   * PR/review-related tool names that DO appear in the window, for a
   * `tool-absent` finding. This is what distinguishes "the agent had no
   * evidence" from "the agent had evidence via a tool this category does not
   * list" — two findings with opposite fixes.
   */
  nearbyTools?: string[];
  /** Verdict of replaying TODAY's detector over this record. See {@link Normalized}. */
  normalized: Normalized;
  /** How the judged turn was located. See {@link locateJudgedTurnEnd}. */
  anchor: "phrase" | "timestamp-fallback";
  /**
   * The phrase and sentence TODAY's detector matches, when it still fires.
   *
   * Not the same as `phrase`/the record's `context`, and the difference is the
   * point: a shipped elision can retire the occurrence a record was written
   * about while the category still fires on OTHER text in the same turn. The
   * record then describes text that no longer fires, so classifying the class
   * of a live fire from the RECORD would repeat, one level down, the staleness
   * this whole task exists to avoid. Classify these.
   */
  currentPhrase?: string;
  currentContext?: string;
  /**
   * Which of mt#3864's three classes this fire falls in, from the text that
   * CURRENTLY matches. Only meaningful when `normalized === "fires"`.
   */
  fireClass?: FireClass;
}

/**
 * What TODAY's detector does with a record the log says FIRED (mt#4256).
 *
 * The log spans months of detector versions, so its raw fire set is a mixture
 * of populations. Classifying that mixture measures retired matchers as much as
 * live ones — and the resulting count then reads as headroom for a tune, which
 * is the phantom improvement mem#1067 §2 says to treat as a bug hypothesis. So
 * every record is replayed through the current code before it is classified.
 *
 * The script already did exactly this for ONE suppression path (`identity-backed`,
 * added when PR #3096 shipped that path) and said why: "evaluated on the same
 * terms the detector uses — otherwise this script's before/after would misreport
 * the very fix it exists to measure." This generalizes that to all of them.
 *
 *   - `fires`        — still an unsuppressed match. The population to classify.
 *   - `suppressed`   — today's detector detects the claim and suppresses it. A
 *                      fire a shipped fix has already retired; NOT a tune target.
 *   - `retired`      — the turn was located by its own phrase (so the
 *                      reconstruction is verified), and the category matches
 *                      nothing at all: a matcher narrowing has already removed
 *                      this fire. Also not a tune target.
 *   - `unreproduced` — the category is in neither half AND the turn could not be
 *                      verified against the phrase, so the text replayed here may
 *                      not be the text that was judged. Kept separate from
 *                      `retired` because only one of the two is a fact about the
 *                      DETECTOR; the other is a fact about this script. An
 *                      absence in a replay is the latter until the reconstruction
 *                      is shown faithful.
 */
export type Normalized = "fires" | "suppressed" | "retired" | "unreproduced";

/**
 * The three false-positive classes mt#3864 named and mt#4256 measures.
 *
 *   - `domain-literal`        — a review-state token or status word appearing as
 *                               DATA being discussed, not as an asserted outcome.
 *   - `third-party-subject`   — another session, bot or actor performed the
 *                               action, and the sentence names that subject.
 *   - `past-dated`            — the sentence carries its own timestamp or
 *                               relative-time anchor.
 *   - `unclassified`          — none of the three. In this corpus that is
 *                               overwhelmingly mt#3864's Cause-B residual, which
 *                               mt#4256's spec puts out of scope.
 */
export type FireClass = "domain-literal" | "third-party-subject" | "past-dated" | "unclassified";

/**
 * Explicit non-agent subjects. Deliberately a short closed set of phrases that
 * NAME another actor, rather than anything inferred: the sentences in this
 * corpus that lack such a phrase attribute the outcome by task id instead
 * (`mt#4112 is DONE and PR #2975 merged`), and "names a task id beside a PR"
 * does not discriminate — `**Shipped.** PR #3073 merged as …; mt#4212 is DONE`
 * has the identical shape and is the agent's OWN work. Separating those needs
 * to know which task is the agent's own, which is attribution rather than
 * lexicon, so this matcher does not attempt it and the residual is reported.
 */
const THIRD_PARTY_SUBJECT =
  /\b(its|their)\s+agent\b|\banother\s+(agent|session|actor|conversation)\b|\ba\s+peer\s+(agent|session)\b|\bpeer-owned\b/i;

/**
 * Self-dated statements: an explicit clock time, an ISO instant, or a
 * relative-time anchor naming when the thing happened.
 */
const PAST_DATED =
  /\b\d{1,2}:\d{2}(:\d{2})?\s?Z?\b|\b\d{4}-\d{2}-\d{2}\b|\bduring this session\b|\bhas since\b|\bearlier (today|this session)\b|\bwhile we worked\b/i;

/**
 * The token is the OBJECT of discussion rather than an assertion: a
 * differently-sensed "review" (a calibration review is not a PR review), or the
 * claim referred to as a noun ("The APPROVED claim came from …").
 */
const DOMAIN_LITERAL = [
  /\bcalibration\s+review\b/i,
  // `[Tt]he` rather than an `i` flag: the flag would also lowercase the token
  // class, matching "the review claim" and every other ordinary noun phrase.
  // The uppercase token is the whole signal — it is what makes the word a
  // MENTION of a review state rather than a use of an English word.
  /\b[Tt]he\s+[A-Z_]{4,}\s+claim\b/,
  /\bthe\s+(claim|token|phrase|record)\b[^.]*\b(APPROVED|CHANGES_REQUESTED)\b/i,
];

/**
 * Classify one still-firing fire against the three classes (mt#4256).
 *
 * **This is a HEURISTIC, and it is reported beside a hand classification rather
 * than in place of one.** Every class here is a semantic property of a sentence
 * — who acted, when, and whether a word is used or mentioned — and a regex can
 * only reach the lexically-marked subset of each. Where the two disagree, the
 * disagreement is the finding: it bounds how much of a class a Rung-1 matcher
 * could ever reach, which is precisely the input mt#4256 owes ADR-032. Treating
 * this function's output as the measurement would answer a narrower question
 * than the one being asked (mem#1047).
 *
 * Order is most-specific first. A sentence can satisfy more than one class —
 * "PR #2926 merged … and the ceiling has since breached" is both third-party
 * and past-dated — and is counted once, under the first that matches, so the
 * per-class counts sum to the population.
 */
export function classifyFire(context: string): FireClass {
  if (THIRD_PARTY_SUBJECT.test(context)) return "third-party-subject";
  if (DOMAIN_LITERAL.some((p) => p.test(context))) return "domain-literal";
  if (PAST_DATED.test(context)) return "past-dated";
  return "unclassified";
}

/**
 * Index of the real user prompt that CLOSES the turn carrying `phrase` — the
 * point at which this detector actually ran (mt#4256).
 *
 * Anchors on the recorded phrase rather than on the record's timestamp.
 * {@link findFireIndex} takes the last line at-or-before the record's
 * timestamp, which lands on the wrong turn whenever the closing prompt's line
 * is written on the far side of that instant; the turn reconstructed from it is
 * then a DIFFERENT turn, and every conclusion drawn from it — the boundary
 * distance as much as the replay — is about text that was never judged.
 *
 * Measured over the 2026-08-09→19 window, not assumed: timestamp anchoring
 * reconstructed a turn containing the recorded phrase for **20 of 30** matches,
 * content anchoring for **30 of 30**. All 30 phrases were present somewhere in
 * their transcript, so the 10 were mislocation, never loss to compaction.
 *
 * The phrase is compared against the ELIDED text, because that is what the
 * detector matched and what `extractMatchContext` captured — comparing against
 * raw text fails on any phrase whose sentence contains a code span, since
 * elision blanks those to same-length whitespace.
 *
 * Returns `null` when the phrase appears in no assistant line, which is a real
 * finding (a rotated or subagent-scoped transcript) rather than a lookup miss.
 */
export function locateJudgedTurnEnd(
  lines: TranscriptLine[],
  timestamp: string,
  phrase: string
): number | null {
  if (!phrase) return null;
  const target = Date.parse(timestamp);
  // Take the LAST occurrence at or before the record, so a phrase the agent
  // repeats across turns resolves to the one this record is about.
  //
  // A LATER-ONLY match is NOT adopted (PR #3151 R1). The record is written when
  // the turn's closing prompt is submitted, so the judged text always precedes
  // it; an occurrence that exists only after the record instant is therefore a
  // DIFFERENT, future turn, and taking it would mis-locate the judged turn
  // exactly the way the timestamp anchor this function replaces does — biasing
  // both the boundary distance and the replay verdict, while reporting
  // `anchor: "phrase"` and thus claiming the reconstruction was verified.
  // Returning null degrades to the timestamp fallback, which keeps the
  // `unreproduced` vs `retired` distinction honest.
  let phraseIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!elideMarkdownContexts(extractAssistantText([line])).includes(phrase)) continue;
    const ts = line.timestamp;
    if (typeof ts === "string" && Date.parse(ts) > target) break;
    phraseIndex = i;
  }
  if (phraseIndex < 0) return null;
  for (let i = phraseIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && isRealUserPrompt(line)) return i;
  }
  // The turn was never closed by a later prompt — the transcript ends inside
  // it. The tail is then the whole judged turn, so the end of file is the point
  // the detector saw.
  return lines.length - 1;
}

/**
 * Replay the current detector over the transcript prefix ending at the fire.
 *
 * Mirrors `run()` in `pre-narration-detector.ts` call for call, on the same
 * inputs, so a change to the detector changes this replay too. The one
 * difference is deliberate: `run()` passes `ctx.recordedAnchor` to pin the
 * completed turn, and a historical record carries no anchor — so the replay
 * takes `extractLastAssistantTurn`'s own fallback over the prefix. That is why
 * `unreproduced` exists as a third verdict rather than being folded into
 * `suppressed`; a prefix that reconstructs the wrong turn must be visible, not
 * silently counted as a fix landing.
 */
export function replayCurrentDetector(
  lines: TranscriptLine[],
  fireIndex: number,
  category: string,
  anchor: Finding["anchor"]
): {
  normalized: Normalized;
  currentPhrase?: string;
  currentContext?: string;
  fireClass?: FireClass;
} {
  const prefix = lines.slice(0, fireIndex + 1);
  const turnLines = extractLastAssistantTurn(prefix);
  if (turnLines.length === 0) return { normalized: "unreproduced" };
  const detection = detectPreNarrationWithSuppression(
    turnLines,
    extractWindowToolUseNames(prefix, TRAILING_WINDOW_TURNS),
    buildIdentityEvidence(prefix, TRAILING_WINDOW_TURNS)
  );
  const hit = detection.matches.find((m) => m.category === category);
  if (hit) {
    return {
      normalized: "fires",
      currentPhrase: hit.matchedPhrase,
      currentContext: hit.context,
      // Classified from the CURRENT text, never the record's — see `Finding`.
      fireClass: classifyFire(hit.context),
    };
  }
  if (detection.suppressed.some((m) => m.category === category))
    return { normalized: "suppressed" };
  // No category match either way. Whether that is a fact about the detector or
  // about this script turns entirely on whether the turn is the right one, and
  // the anchor is what answers that: a phrase-anchored turn demonstrably
  // contains the text the record was written about.
  return { normalized: anchor === "phrase" ? "retired" : "unreproduced" };
}

/**
 * The boundary at which mt#3864's fix became the running detector — the mtime
 * of the regenerated `.claude/hooks` copy, not the merge commit, because the
 * generated mirror is what actually executes.
 *
 * Reported as a SPLIT rather than pooled across, per `/plan-task` gate (o) step
 * 3. Normalization is what makes the pooled window usable at all; this split is
 * the check on that, and it is also the number that stops a reader concluding
 * anything from the post-boundary silence: at the fire rates below, the handful
 * of records since the boundary predict ~1 fire, so 0 is not evidence.
 */
const MT3864_BOUNDARY = "2026-08-19T02:16:00.000Z";

/** Per-day fire counts, so a window carried by one day is visible as one. */
function bucketByDay(findings: Finding[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const f of findings) {
    const day = f.timestamp.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return new Map([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** The reporting payload, shared by the console and `--json` paths. */
function summarize(findings: Finding[], windowTurns: number) {
  const stillFires = findings.filter((f) => f.normalized === "fires");
  const tally = <T>(rows: T[], key: (row: T) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const k = key(row);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  return {
    windowTurns,
    recordedFires: findings.length,
    normalized: tally(findings, (f) => f.normalized),
    byClass: tally(stillFires, (f) => f.fireClass ?? "unclassified"),
    byCategoryAndCause: tally(stillFires, (f) => `${f.category} — ${f.cause}`),
    byDay: Object.fromEntries(bucketByDay(stillFires)),
    boundary: {
      at: MT3864_BOUNDARY,
      before: stillFires.filter((f) => f.timestamp < MT3864_BOUNDARY).length,
      after: stillFires.filter((f) => f.timestamp >= MT3864_BOUNDARY).length,
    },
    anchors: tally(findings, (f) => f.anchor),
  };
}

/** Tool names worth reporting as candidate evidence for a PR-outcome claim. */
const PR_RELATED = /pr|review|merge|github|changeset|checks/i;

/** Distinct PR-related tool names within the trailing window, most recent first. */
function nearbyPrTools(lines: TranscriptLine[], fireIndex: number): string[] {
  const seen = new Set<string>();
  let boundaries = 0;
  for (let i = fireIndex; i >= 0 && boundaries < TRAILING_WINDOW_TURNS; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    for (const name of extractToolUseNames([line])) {
      if (PR_RELATED.test(name)) seen.add(name);
    }
    if (isRealUserPrompt(line)) boundaries++;
  }
  return [...seen];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Locate a session's transcript across the per-project directories. */
function findTranscript(sessionId: string): string | null {
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const dir of readdirSync(PROJECTS_DIR)) {
    const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Index of the last line at or before the record's timestamp — the fire point.
 * Returns -1 when the transcript has no line that old (a rotated/truncated file).
 */
function findFireIndex(lines: TranscriptLine[], timestamp: string): number {
  const target = Date.parse(timestamp);
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    const ts = lines[i]?.timestamp;
    if (typeof ts !== "string") continue;
    if (Date.parse(ts) <= target) best = i;
    else break;
  }
  return best;
}

/**
 * Boundary distance from the fire back to the nearest occurrence of any tool in
 * `requiredTools`, counting real-user-prompt boundaries exactly as
 * `extractWindowToolUseNames` does. `null` when no such tool occurs at all.
 */
function boundaryDistanceToTool(
  lines: TranscriptLine[],
  fireIndex: number,
  requiredTools: readonly string[]
): number | null {
  const required = new Set(requiredTools);
  let boundaries = 0;
  for (let i = fireIndex; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    if (extractToolUseNames([line]).some((n) => required.has(n))) return boundaries;
    if (isRealUserPrompt(line)) boundaries++;
  }
  return null;
}

function main(): void {
  const since = arg("--since") ?? "";
  // An UPPER bound, because this log is live and grows while you read it —
  // including with fires caused by the very session doing the measuring, whose
  // turns discuss PR outcomes by construction. Without `--until` a reported
  // figure cannot be reproduced later, and the run that produced it is part of
  // its own population.
  const until = arg("--until") ?? "";
  const asJson = process.argv.includes("--json");
  const logPath = arg("--log") ?? DEFAULT_LOG;

  if (!existsSync(logPath)) {
    console.log(`SKIP: no calibration log at ${logPath}`);
    console.log(
      "(Since mt#4748 calibration logs live under the runtime state dir, keyed by checkout," +
        " so a session workspace resolves its OWN key and finds nothing. From a session, pass" +
        " --log <main-checkout's state-dir path>.)"
    );
    process.exit(0);
  }

  const records: CalibrationRecord[] = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CalibrationRecord)
    .filter((r) => (r.suppressionReasons ?? []).length === 0)
    .filter((r) => (since ? r.timestamp >= since : true))
    .filter((r) => (until ? r.timestamp < until : true));

  const byCategory = new Map(OUTCOME_CATEGORIES.map((c) => [c.key, c]));
  const findings: Finding[] = [];
  const transcriptCache = new Map<string, TranscriptLine[] | null>();

  for (const record of records) {
    const sessionId = record.session_id ?? "";
    if (!transcriptCache.has(sessionId)) {
      const path = sessionId ? findTranscript(sessionId) : null;
      transcriptCache.set(sessionId, path ? parseTranscript(path) : null);
    }
    const lines = transcriptCache.get(sessionId) ?? null;

    for (const match of record.matches ?? []) {
      const category = byCategory.get(match.category);
      const base = {
        timestamp: record.timestamp,
        sessionId,
        category: match.category,
        phrase: match.phrase,
        // Every `unreplayable` exit below shares this: with no transcript, no
        // known category, or no locatable fire point there is nothing to replay
        // the current detector against, so the normalized verdict is the same
        // "we could not tell" the cause already reports. Set on `base` rather
        // than at each exit so a future exit cannot forget it.
        normalized: "unreproduced" as Normalized,
        anchor: "timestamp-fallback" as const,
      };
      if (lines === null) {
        findings.push({
          ...base,
          boundariesBack: null,
          cause: "unreplayable",
          detail: "no transcript",
        });
        continue;
      }
      if (category === undefined) {
        findings.push({
          ...base,
          boundariesBack: null,
          cause: "unreplayable",
          detail: "unknown category",
        });
        continue;
      }
      // Content-anchored, with the timestamp as fallback: a record whose phrase
      // is absent from the transcript still gets located the old way rather
      // than dropped, and the fallback is NAMED in the finding so a reader can
      // tell a reconstruction that was verified against the phrase from one
      // that was not.
      const anchored = locateJudgedTurnEnd(lines, record.timestamp, match.phrase);
      const fireIndex = anchored ?? findFireIndex(lines, record.timestamp);
      if (fireIndex < 0) {
        findings.push({
          ...base,
          boundariesBack: null,
          cause: "unreplayable",
          detail: "fire predates transcript",
        });
        continue;
      }
      const anchor: Finding["anchor"] = anchored === null ? "timestamp-fallback" : "phrase";
      const distance = boundaryDistanceToTool(lines, fireIndex, category.requiredTools);

      // Identity-scoped evidence (PR #3096 R1) is not a name match, so boundary
      // distance cannot express it: it holds only when the PR the claim NAMES
      // was actually read. Evaluated on the same terms the detector uses —
      // otherwise this script's before/after would misreport the very fix it
      // exists to measure.
      // WINDOW-scoped, matching the detector after PR #3096 R2. Slicing to the
      // fire and then taking the window is what the detector sees; using the
      // full pre-fire history here would re-introduce, in the measurement, the
      // exact scope mismatch R2 removed from the code.
      // mt#4810: the same two-step the detector now uses — the matched phrase
      // first, then the claim's own sentence. Kept in sync deliberately: the
      // comment above is explicit that a divergence here would misreport the
      // very fix this script exists to measure, and this is where that would
      // have happened.
      const claimedPr =
        extractClaimedPrNumber(match.phrase) ?? extractUniqueClaimedPrNumber(match.context ?? "");
      const identityBacked =
        claimedPr !== null &&
        extractPrNumbersForTools(
          windowSlice(lines.slice(0, fireIndex + 1), TRAILING_WINDOW_TURNS),
          category.identityScopedTools ?? []
        ).has(claimedPr);

      const cause: Cause = identityBacked
        ? "identity-backed"
        : distance === null
          ? "tool-absent"
          : distance < TRAILING_WINDOW_TURNS
            ? "within-window"
            : "beyond-window";
      findings.push({
        ...base,
        boundariesBack: distance,
        cause,
        anchor,
        ...replayCurrentDetector(lines, fireIndex, match.category, anchor),
        ...(cause === "tool-absent" ? { nearbyTools: nearbyPrTools(lines, fireIndex) } : {}),
      });
    }
  }

  // Both paths render from ONE summary (PR #3151 R1 non-blocking). Previously
  // `--json` emitted the raw findings array while the console showed only the
  // normalized population, so the two disagreed about what the run had found
  // with nothing saying so. The findings array is still emitted in full — it is
  // the post-processing surface — but the summary travels with it.
  const summary = summarize(findings, TRAILING_WINDOW_TURNS);
  const stillFires = findings.filter((f) => f.normalized === "fires");

  if (asJson) {
    console.log(JSON.stringify({ summary, findings }, null, 2));
    return;
  }

  console.log(`Window = ${TRAILING_WINDOW_TURNS} real-user-prompt boundaries.`);
  console.log(
    `Matches the LOG recorded as fires: ${summary.recordedFires}${since ? ` (since ${since})` : ""}`
  );
  console.log(
    `Replayed through TODAY's detector: ${summary.normalized["fires"] ?? 0} still fire, ` +
      `${summary.normalized["suppressed"] ?? 0} now suppressed, ` +
      `${summary.normalized["retired"] ?? 0} no longer matched, ` +
      `${summary.normalized["unreproduced"] ?? 0} unreproduced.`
  );
  console.log(
    `Judged turn located by recorded phrase: ${summary.anchors["phrase"] ?? 0}; ` +
      `by timestamp fallback: ${summary.anchors["timestamp-fallback"] ?? 0}.`
  );
  console.log(
    "Only the 'still fire' rows are a tune target; the drop is work already shipped, not headroom.\n"
  );

  console.log("By class (mt#3864's three, over the still-firing population):");
  for (const cls of [
    "domain-literal",
    "third-party-subject",
    "past-dated",
    "unclassified",
  ] as const) {
    console.log(`  ${String(summary.byClass[cls] ?? 0).padStart(3)}  ${cls}`);
  }
  console.log(
    "  (heuristic — reaches only the lexically-marked subset of each class; see classifyFire)"
  );

  console.log("\nBy category and window cause:");
  for (const [key, count] of Object.entries(summary.byCategoryAndCause).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`  ${String(count).padStart(3)}  ${key}`);
  }

  console.log("\nPer day (a window carried by one day is not a window):");
  for (const [day, count] of Object.entries(summary.byDay)) {
    console.log(`  ${String(count).padStart(3)}  ${day}`);
  }
  console.log(
    `\nSplit at the mt#3864 boundary (${summary.boundary.at}): ` +
      `${summary.boundary.before} before, ${summary.boundary.after} after.`
  );

  console.log("\nPer-match detail (still firing under today's detector):");
  for (const f of stillFires) {
    const dist = f.boundariesBack === null ? "none" : `${f.boundariesBack} back`;
    console.log(
      `  [${f.cause}] ${f.category} (${dist}) "${f.phrase}"${f.detail ? ` — ${f.detail}` : ""}`
    );
    if (f.cause === "tool-absent" && f.nearbyTools !== undefined) {
      console.log(`        tools actually in window: ${f.nearbyTools.join(", ") || "(none)"}`);
    }
  }
}

// Guarded so the module can be imported by its test without running the whole
// diagnostic (and reading the operator's calibration log) as an import side
// effect. `bun scripts/diagnose-pre-narration-window.ts` is unaffected.
if (import.meta.main) main();
