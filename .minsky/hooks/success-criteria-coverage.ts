// `## Success Criteria` cross-reference at merge time — mt#3350 (calibration-first).
//
// A task spec's `## Success Criteria` section was cross-referenced by NOTHING. mt#3033 wired
// the sibling `## Acceptance Tests` section into the execution-evidence gate, but the criteria
// section had no reader at all — so a criterion could be authored into a spec and shipped unmet
// while typecheck, lint and the whole test suite stayed green.
//
// **Originating incident (mt#3347).** The spec's FIRST success criterion was "a repo-wide grep
// for `<select` under `src/cockpit/web` returns zero hits outside the primitive itself." It was
// authored by the agent ~40 minutes before implementation and never run. 21 of 22 call sites
// migrated; the 22nd was the exact control in the principal's screenshot. It survived clean
// typecheck (5 projects), clean lint (2920 files), 1487 passing tests, a commit and a push.
// Running the criterion's own one-line grep would have caught it in under a second.
//
// The tractable subclass this module targets: **some criteria are mechanically executable** —
// they embed a runnable command and an expected result. For those the criterion IS its own
// check; nothing has to interpret intent, it just has to notice the output is missing.
//
// ## Why this module does not import the evidence hook
//
// `require-execution-evidence-before-merge.ts` imports THIS module to run the calibration, so an
// import back would be a cycle and would break that hook's entry point. The evidence-block text
// therefore flows IN as a parameter (`evidenceText`) rather than being re-extracted here. Only
// the `SC<N>`-heading pass is this module's own, and it uses the shared fence-aware primitives
// in `./markdown-sections.ts` rather than re-deriving them (Success Criterion 6).
//
// Dependency-free per `.minsky/hooks/SPEC.md` beyond those two sibling modules.
//
// @see mt#3350 — this task
// @see .minsky/hooks/require-execution-evidence-before-merge.ts — the AT sibling this mirrors, and this module's caller
// @see .minsky/hooks/markdown-sections.ts — shared fence-aware section scanning
// @see mem#736 — "a spec you authored yourself this session is the one you're least likely to re-read"

import { computeFenceInternalLines, isMarkdownHeading } from "./markdown-sections";

/** One item parsed from a task spec's `## Success Criteria` section. */
export interface SuccessCriterionItem {
  /** 1-based position in document order — the spec's own numbering, as `SC<N>` refers to it. */
  number: number;
  /** The item's text, with wrapped continuation lines joined. */
  text: string;
}

/**
 * Matches the `## Success Criteria` heading and its body.
 *
 * Same boundary construction as the AT path's `ACCEPTANCE_TESTS_RE` (mt#3306 Defect 1 /
 * mt#3059 FP-1, plus PR #2386 R1's off-by-one fix): the section ends at the next heading of
 * the SAME OR DEEPER level (`##` or `###`), anchored on `^` in multiline mode so a heading
 * that immediately follows with ZERO content is still recognized as the boundary. The final
 * alternative uses `(?![\s\S])` rather than `$` because the `m` flag would otherwise make `$`
 * mean "end of any line".
 *
 * This matters here for the same reason it did there: `work-completion.mdc §Recovery layer
 * spec discipline` requires a `### Covers` / `### Does NOT cover` pair on exactly the kind of
 * infrastructure spec this check most wants to police, and a `###` boundary invisible to a
 * `\n##\s` lookahead would sweep those bullets in as criteria.
 */
const SUCCESS_CRITERIA_RE =
  /##\s*Success Criteria\s*\n([\s\S]*?)(?=^#{2,3}\s|^---[ \t]*$|(?![\s\S]))/im;

/** Extracts the raw body of a spec's `## Success Criteria` section, or null when absent. */
export function extractSuccessCriteriaSection(specContent: string): string | null {
  const match = specContent.match(SUCCESS_CRITERIA_RE);
  return match ? (match[1] ?? "") : null;
}

/**
 * Parses the section into numbered items.
 *
 * Recognizes the GitHub task-list form the `/create-task` template and this repo's specs
 * actually use (`- [ ] ...`), plain bullets, and explicitly numbered lists. Unlike the AT
 * parser, a written number is NOT preserved: `SC<N>` references are positional by convention,
 * and a spec whose criteria are checkboxes has no written numbers to preserve. Numbering is
 * therefore always sequential in document order starting at 1.
 *
 * Top-level items only — an indented bullet is a sub-point of the current criterion and folds
 * into its text, matching the AT parser's PR #2207 R1 behavior. A bolded lead-in
 * (`- [ ] **Injection at PR time.** ...`) is kept in the text; it is often where the
 * distinctive keywords live.
 */
export function parseSuccessCriteria(specContent: string): SuccessCriterionItem[] {
  const section = extractSuccessCriteriaSection(specContent);
  if (!section) return [];

  const items: SuccessCriterionItem[] = [];
  let current: SuccessCriterionItem | null = null;

  for (const rawLine of section.split("\n")) {
    // Top-level checkbox or bullet: `- [ ] text`, `- [x] text`, `- text`, `* text`.
    const bulletMatch = rawLine.match(/^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (bulletMatch) {
      if (current) items.push(current);
      current = { number: items.length + 1, text: (bulletMatch[1] ?? "").trim() };
      continue;
    }
    const numberedMatch = rawLine.match(/^\d+\.\s+(.*)$/);
    if (numberedMatch) {
      if (current) items.push(current);
      current = { number: items.length + 1, text: (numberedMatch[1] ?? "").trim() };
      continue;
    }
    if (current && rawLine.trim().length > 0) {
      current.text = `${current.text} ${rawLine.trim()}`.trim();
    }
  }
  if (current) items.push(current);

  return items;
}

/**
 * Shapes that make a criterion mechanically executable — it names a command AND an expected
 * result, so the criterion is its own check.
 *
 * **The default here is INVERTED relative to the AT classifier, deliberately.**
 * `isExecutableAcceptanceTest` treats everything as executable and SUBTRACTS findings-shaped
 * text, which is right for an `## Acceptance Tests` list — those are behavioral by
 * construction. A `## Success Criteria` list is the opposite: mostly judgment-shaped prose
 * ("the control renders with cockpit surface tokens"), with the executable ones a sharp
 * minority. Inheriting the AT default would classify nearly every criterion executable and
 * bury the real signal in warnings nobody can act on — the mem#719 failure mode, where a
 * detector's unmatchable output trains readers to discount its correct output too.
 *
 * So: a positive match is REQUIRED. Under-flagging is the safe direction while this ships
 * log-only; the calibration log is how the pattern set gets widened on evidence.
 */
const EXECUTABLE_CRITERION_PATTERNS: readonly RegExp[] = [
  // A shell command in backticks or a fence: grep / rg / wc / find / ls / test.
  /`[^`]*\b(?:grep|rg|wc|find|ls|git\s+grep)\b[^`]*`/i,
  // A transcript-style prompt line.
  /^\s*\$\s+\S/m,
  // An explicit expected count, the shape mt#3347's missed criterion used.
  /\breturns?\s+(?:zero|no|\d+)\s+(?:hits|matches|results|lines|rows)\b/i,
  /\bthe\s+count\s+is\s+\d+\b/i,
  /\b(?:zero|0)\s+(?:hits|matches|occurrences)\b/i,
];

/**
 * True when a criterion embeds a runnable check plus an expected result.
 *
 * Empty/whitespace-only text is never executable. Everything else must positively match one
 * of {@link EXECUTABLE_CRITERION_PATTERNS} — see that constant for why the default is
 * non-executable rather than executable.
 */
export function isExecutableSuccessCriterion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return EXECUTABLE_CRITERION_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Criterion numbers that have a dedicated `SC<N>` section in the PR body.
 *
 * This is acceptance test 7's mechanism, and the boundary agreed with mt#3339 (see mt#3350's
 * `## Overlap reconciliation`): THIS task owns `SC<N>` heading recognition because it defines
 * what an SC number means; mt#3339 keeps every other non-canonical heading (`## Testing`,
 * `## Design/Approach`). The real-world shape is mt#3149 / PR #2255, whose body carries a
 * `## SC3 (...) — re-verified, closed as already-resolved` section that the AT-path scanner
 * could not see.
 *
 * Matching on the HEADING rather than folding the section into the evidence text is the more
 * precise move: `collectHeadingSections` collects from AFTER the heading line, so the number —
 * the only part that identifies WHICH criterion the section is about — would be dropped.
 *
 * Fence-gated via {@link computeFenceInternalLines}, so an `## SC3` line inside pasted example
 * Markdown does not count.
 */
export function findScHeadingNumbers(prBody: string): Set<number> {
  const stripped = prBody.replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped.split("\n");
  const fenceInternal = computeFenceInternalLines(lines);
  const found = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || fenceInternal[i] || !isMarkdownHeading(line)) continue;
    const match = line.match(/^\s*#{1,6}\s+SC\s*#?(\d+)\b/i);
    if (!match) continue;
    const n = parseInt(match[1] ?? "", 10);
    if (Number.isFinite(n)) found.add(n);
  }
  return found;
}

const CRITERION_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "before",
  "being",
  "block",
  "criterion",
  "doesn",
  "should",
  "their",
  "there",
  "these",
  "those",
  "which",
  "while",
]);

/** Lowercase, length>=5, non-stopword tokens used for loose keyword matching. */
function extractSignificantKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 5 && !CRITERION_STOPWORDS.has(word));
}

/** True when the evidence text references this criterion by number, in any common form. */
export function isCriterionReferencedByNumber(
  criterion: SuccessCriterionItem,
  evidenceText: string
): boolean {
  const n = criterion.number;
  return [
    new RegExp(`\\bSC\\s*#?${n}\\b`, "i"),
    new RegExp(`\\bsuccess criterion\\s*#?${n}\\b`, "i"),
    new RegExp(`\\bcriterion\\s*#?${n}\\b`, "i"),
    new RegExp(`\\bsc-${n}\\b`, "i"),
  ].some((p) => p.test(evidenceText));
}

/** True when the evidence text shares a distinctive keyword with the criterion's own text. */
export function isCriterionReferencedByKeyword(
  criterion: SuccessCriterionItem,
  evidenceText: string
): boolean {
  const lower = evidenceText.toLowerCase();
  return extractSignificantKeywords(criterion.text).some((k) => lower.includes(k));
}

/**
 * Extracts the deferral target from a `[scN-deferred: mt#NNNN]` marker for THIS criterion
 * number, anywhere in the PR body.
 *
 * The marker is per-criterion and NUMBERED, mirroring the AT path's `[atN-deferred:]`
 * verbatim. An earlier draft of mt#3350's spec wrote a bare `[sc-deferred: ...]`; that shape
 * cannot target one criterion, so a single marker would have excused an entire list — which is
 * exactly the "prose explaining why it was skipped reads as coverage" failure the marker
 * convention exists to prevent.
 */
export function extractScDeferralMarker(prBody: string, criterionNumber: number): string | null {
  const match = prBody.match(new RegExp(`\\[sc${criterionNumber}-deferred:\\s*([^\\]]+)\\]`, "i"));
  return match ? (match[1] ?? "").trim() : null;
}

/** True when a `[scN-deferred: ...]` marker exists for this criterion number. */
export function isCriterionDeferred(prBody: string, criterionNumber: number): boolean {
  return extractScDeferralMarker(prBody, criterionNumber) !== null;
}

/** Result of cross-referencing a task's executable success criteria against a PR body. */
export interface ScCoverageResult {
  /** False when the task has zero executable criteria — the check does not apply. */
  applicable: boolean;
  /** Criteria classified executable (after the positive-match filter). */
  executableCriteria: SuccessCriterionItem[];
  /** Executable criteria neither addressed in the evidence nor deferred. */
  unaddressedCriteria: SuccessCriterionItem[];
}

/**
 * Core coverage check (pure, injectable — mirrors `checkAcceptanceTestCoverage`'s shape).
 *
 * `evidenceText` is supplied by the caller rather than extracted here; see this module's
 * header for why importing the evidence hook would be a cycle.
 *
 * A criterion counts as addressed when ANY of these holds:
 *   - a `[scN-deferred: mt#NNNN]` marker exists for it anywhere in the PR body, OR
 *   - the PR body has a dedicated `SC<N>` heading section for it, OR
 *   - the evidence text references it by number, OR
 *   - the evidence text shares a distinctive keyword with its text.
 */
export function checkSuccessCriteriaCoverage(
  specContent: string,
  prBody: string,
  evidenceText: string
): ScCoverageResult {
  const all = parseSuccessCriteria(specContent);
  const executableCriteria = all.filter((c) => isExecutableSuccessCriterion(c.text));

  if (executableCriteria.length === 0) {
    return { applicable: false, executableCriteria: [], unaddressedCriteria: [] };
  }

  const scHeadings = findScHeadingNumbers(prBody);
  const unaddressedCriteria = executableCriteria.filter((c) => {
    if (isCriterionDeferred(prBody, c.number)) return false;
    if (scHeadings.has(c.number)) return false;
    if (isCriterionReferencedByNumber(c, evidenceText)) return false;
    if (isCriterionReferencedByKeyword(c, evidenceText)) return false;
    return true;
  });

  return { applicable: true, executableCriteria, unaddressedCriteria };
}

/** Override env var (registered in `HOOK_ONLY_ENV_VARS`) — skips the SC-coverage check. */
export const SC_COVERAGE_SKIP_ENV_VAR = "MINSKY_SKIP_SC_COVERAGE";

/** Calibration log path (mt#2263 ladder) — repo-root relative. */
export const SC_COVERAGE_CALIBRATION_LOG =
  ".minsky/execution-evidence-sc-coverage-calibration.jsonl";

/** True when the SC-coverage check is skipped via env var. */
export function isScCoverageSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[SC_COVERAGE_SKIP_ENV_VAR];
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

/** Result of running the SC-coverage calibration surface for one merge attempt. */
export interface ScCoverageCalibrationRunResult {
  /** True when the check actually ran (not skipped, spec content present). */
  ranCheck: boolean;
  /** A WARN string for `additionalContext`, if any executable criterion is unaddressed. */
  warning?: string;
  /** The record to append to the calibration log, when there is one. */
  calibrationRecord?: Record<string, unknown>;
}

/**
 * Runs the SC-coverage calibration for one merge attempt and returns what the caller should
 * emit — never performs I/O of its own, so the caller owns both the log write and the warning.
 *
 * Log-only by construction (mt#2263 ladder): this returns a warning, never a deny, and the
 * caller must never let it alter the gate's blocking decision.
 */
export function runScCoverageCalibration(
  task: string,
  prNumber: number,
  specContent: string,
  prBody: string,
  evidenceText: string,
  env: NodeJS.ProcessEnv = process.env
): ScCoverageCalibrationRunResult {
  if (isScCoverageSkipped(env)) return { ranCheck: false };

  let coverage: ScCoverageResult;
  try {
    coverage = checkSuccessCriteriaCoverage(specContent, prBody, evidenceText);
  } catch {
    // Fail silent, matching the AT path: a parse failure must never surface as a WARN and
    // never as a block (mt#3033 constraint 3).
    return { ranCheck: false };
  }

  if (!coverage.applicable || coverage.unaddressedCriteria.length === 0) {
    return { ranCheck: true };
  }

  const list = coverage.unaddressedCriteria
    .map((c) => `  - SC${c.number}: ${truncateForWarning(c.text)}`)
    .join("\n");

  const warning =
    `[execution-evidence-sc-coverage] CALIBRATION (log-only, mt#3350 — would block if ` +
    `graduated): ${coverage.unaddressedCriteria.length} of ${coverage.executableCriteria.length} ` +
    `mechanically-executable success criteria for ${task} are not addressed by the ` +
    `\`Execution evidence:\` block (no number/keyword reference, no \`SC<N>\` section, and no ` +
    `\`[scN-deferred: mt#NNNN]\` marker):\n${list}\n\n` +
    `These criteria name a command and an expected result — running one costs a second and is ` +
    `the only thing that settles it. Merge is NOT blocked by this. Override: set ` +
    `${SC_COVERAGE_SKIP_ENV_VAR}=1.`;

  return {
    ranCheck: true,
    warning,
    calibrationRecord: {
      timestamp: new Date().toISOString(),
      task,
      prNumber,
      surface: "execution-evidence-sc-coverage",
      executableCriterionCount: coverage.executableCriteria.length,
      unaddressedCriteria: coverage.unaddressedCriteria.map((c) => ({
        number: c.number,
        text: c.text,
      })),
    },
  };
}

/** Criteria in this repo run long; the warning names them without reproducing a paragraph. */
function truncateForWarning(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
