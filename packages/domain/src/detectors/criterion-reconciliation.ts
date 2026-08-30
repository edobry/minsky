/**
 * mt#4213 — a spec explains that a criterion is unmet while leaving that
 * criterion's own text untouched in the same revision.
 *
 * ## The shape
 *
 * Four times between 2026-08-12 and 2026-08-19 an implementer who could not satisfy
 * a Success Criterion or Acceptance Test wrote the reconciliation somewhere that does
 * not GOVERN — a spec `## Outcome` section, an appended `### Acceptance Tests —
 * amended` block — and left the criterion's own normative line saying the opposite.
 * `minsky-reviewer[bot]` read the untouched line and posted BLOCKING each time, at a
 * cost of one review round apiece (R1 mt#4038 / PR #2914, R3 mt#4162 / PR #3053, R4
 * mt#4320 / PR #3161; R2 mt#4076 wrote only to the PR body and never reaches this
 * seam).
 *
 * ## Why the nominating half is a phrase set, and what that obliges
 *
 * mt#4168's correction — *"Key on the TOOL CALL, never on a phrase set"* — applies
 * here and is not dodged. The discharging ACTION (editing the criterion's own text)
 * is structural and joinable, but it cannot be the TRIGGER: every spec patch that
 * does not touch a criterion would fire. So the nominating half is a phrase set by
 * necessity and this check sits ON ADR-024's ladder rather than outside it. Three
 * consequences, all binding:
 *
 * 1. **Rung 1 only** — exact substrings, no similarity metric (mem#819).
 * 2. **The evaluation stream is not garnish.** It makes the MISS rate measurable,
 *    which is the quantity a rung climb is decided on.
 * 3. **If recall proves the binding constraint, the answer is Rung 2 (embedding),
 *    never another regex family.** A widened substring list is the arms race ADR-024
 *    exists to end. This is a live risk rather than a formality: planning measured
 *    R1's spec text as matching NONE of the phrases below, because its author phrased
 *    the reconciliation as an *amendment record* rather than an unmet-assertion.
 *
 * ## Why this module does no IO
 *
 * The confirming half asks whether THIS WRITE touches the named criterion's own
 * normative line. That is answerable from the authored text alone — a patch that does
 * not carry the criterion's entry leaves it byte-identical by construction, because
 * the marker merge preserves what the patch omits. So there is no prior-spec read and
 * no database call, unlike the `spec-criterion-claim-detector` sibling.
 *
 * Known bound, deliberately left to the evaluation stream rather than papered over: a
 * write that re-emits the criterion's line VERBATIM is read here as "touched" and
 * stays silent. Closing it costs a prior-spec read; the stream will say whether that
 * shape ever actually occurs.
 *
 * ## Why the elider is INJECTED
 *
 * Same reason as the sibling: `elideMarkdownNonProse` lives in `.minsky/hooks/`, and a
 * domain module importing from there would invert the dependency. The adapter composes
 * it.
 *
 * @see .minsky/hooks/criterion-reconciliation-scan.ts — the adapter
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 * @see packages/domain/src/detectors/spec-criterion-claim.ts — `extractCriteria`,
 *   reused here per mt#4153's directive that the second-shipping guard share the
 *   first's spec-section parsing rather than stand up a parallel scanner.
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";

import { extractCriteria } from "./spec-criterion-claim";

/**
 * Assertions that a criterion is unmet. EXACT substrings, matched
 * case-insensitively — case is not a paraphrase axis, so folding it costs no recall
 * discipline while catching `NOT satisfied` alongside `not satisfied`.
 *
 * Sourced from the recorded instances' own wording, not invented: R3 (mt#4162) wrote
 * `is NOT satisfied`, R4 (mt#4320) wrote both `cannot be satisfied` and
 * `unsatisfiable`. Do NOT extend this list to chase a miss — see consequence 3 in the
 * module header.
 */
export const UNMET_ASSERTIONS: readonly string[] = [
  "is not satisfied",
  "reported not satisfied",
  "cannot be satisfied",
  "not satisfiable",
  "unsatisfiable",
  "is not met",
  "not met",
];

/**
 * A criterion reference: `SC3`, `AT#4`, `SC 12`. A closed vocabulary — an ordinal
 * against a named section — so this half carries no paraphrase axis.
 */
export const CRITERION_ID = /\b(SC|AT)\s*#?\s*(\d{1,2})\b/gi;

/**
 * Headings whose content RECORDS already-discharged work rather than owing it.
 *
 * `/plan-task` Step 2's own triage problem, in matcher form: a section titled
 * `Required actions resolved` is a discharge record, and re-firing on it would report
 * completed reconciliation as an outstanding one.
 */
export const DISCHARGE_HEADINGS: readonly RegExp[] = [
  /required actions?\s+resolved/i,
  /\bresolved\b.*\(\d{4}-\d{2}-\d{2}\)/i,
  /^changelog/i,
];

/**
 * How far from an unmet-assertion a criterion id may sit and still be "named or
 * adjacent to" it.
 *
 * Characters rather than lines, because this repo wraps prose at 100 columns: a
 * bullet routinely puts the id on one visual line and the assertion on the next, and
 * a line-scoped window would miss exactly the wrapped case that planning measured at
 * 50% of flagged bullets (mt#4582's finding on the sibling stream).
 */
export const ADJACENCY_WINDOW_CHARS = 240;

/** Which sections carry normative criteria. Mirrors `spec-criterion-claim`'s set. */
const SECTION_BY_PREFIX: Readonly<Record<string, string>> = {
  SC: "success criteria",
  AT: "acceptance tests",
};

export interface CriterionReconciliationFinding {
  /** `SC3` / `AT4`, normalized to uppercase with no separator. */
  criterionId: string;
  /** The exact substring from {@link UNMET_ASSERTIONS} that matched. */
  assertion: string;
  /** Bounded excerpt around the assertion, for the calibration record. */
  excerpt: string;
}

export interface CriterionReconciliationResult {
  findings: CriterionReconciliationFinding[];
  /**
   * Criterion ids this write DID amend. Recorded even when there is no finding: it
   * is the compliant shape, and the evaluation stream needs to count it to tell
   * "nothing to see" from "the author did the right thing".
   */
  amended: string[];
}

/** Cap so a calibration record cannot carry an unbounded span of spec prose. */
export const EXCERPT_CAP = 200;

function excerptAround(text: string, index: number, length: number): string {
  const pad = Math.max(0, Math.floor((EXCERPT_CAP - length) / 2));
  const start = Math.max(0, index - pad);
  // `safeTruncate` rather than a bare end-slice: spec prose carries emoji and other
  // non-BMP characters, and splitting a surrogate pair would put a lone half into a
  // calibration record.
  const collapsed = text.slice(start).replace(/\s+/g, " ").trim();
  return safeTruncate(collapsed, EXCERPT_CAP);
}

/**
 * The nearest heading at or above `index`, or null when the hit precedes any heading.
 * Used only for discharge-record suppression.
 */
function enclosingHeading(text: string, index: number): string | null {
  // Not a truncation: a positional split at `index`, which is the offset of an
  // ASCII assertion substring found by `indexOf`, so it cannot fall inside a
  // surrogate pair. `safeTruncate` would be wrong here — it bounds a LENGTH, and
  // what is needed is everything before a known boundary.
  // eslint-disable-next-line custom/no-unsafe-string-truncation
  const before = text.slice(0, index);
  let last: string | null = null;
  const re = /^#{1,6}\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before)) !== null) last = (m[1] ?? "").trim();
  return last;
}

/**
 * The `[start, end)` span of the markdown section containing `index`.
 *
 * The adjacency window is clamped to this, and that clamp is load-bearing rather
 * than tidiness: without it a criterion id mentioned INSIDE another section binds to
 * an assertion that is not about it. This module's own test caught exactly that — a
 * `## Success Criteria` bullet reading `AT3's replacement: …` sat within the
 * character window of an `is not satisfied` in a following `## Outcome`, and AT3 was
 * reported as unamended when the assertion never referred to it.
 *
 * An assertion and the criterion it names are written together, in one section. A
 * window that spans a heading is measuring proximity in the file rather than
 * reference in the prose.
 */
function sectionSpan(text: string, index: number): { start: number; end: number } {
  const re = /^#{1,6}\s+.*$/gm;
  let start = 0;
  let end = text.length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index <= index) start = m.index;
    else {
      end = m.index;
      break;
    }
  }
  return { start, end };
}

/**
 * Which criterion ids does this write actually AMEND?
 *
 * `extractCriteria` returns the bullets under each scanned section in document order,
 * so a criterion's id is its ORDINAL within its section — `SC3` is the third bullet
 * under `## Success Criteria`. That is the numbering convention every spec in this
 * repo and every reviewer finding already uses.
 */
export function amendedCriterionIds(
  authoredText: string,
  elide: (text: string) => string
): string[] {
  const bySection = new Map<string, number>();
  const out: string[] = [];
  for (const c of extractCriteria(authoredText, elide)) {
    const section = c.section.toLowerCase();
    const entry = Object.entries(SECTION_BY_PREFIX).find(([, title]) => section.startsWith(title));
    const prefix = entry?.[0];
    if (prefix === undefined) continue;
    const n = (bySection.get(prefix) ?? 0) + 1;
    bySection.set(prefix, n);
    out.push(`${prefix}${n}`);
  }
  return out;
}

/**
 * Detect explanation-without-amendment in one authored spec write.
 *
 * Fires when the write asserts a criterion is unmet, names that criterion, and does
 * NOT carry that criterion's own normative entry.
 */
export function detectCriterionReconciliation(
  authoredText: string,
  elide: (text: string) => string
): CriterionReconciliationResult {
  const empty: CriterionReconciliationResult = { findings: [], amended: [] };
  if (typeof authoredText !== "string" || authoredText.trim() === "") return empty;

  // Elide first, for the reason `extractCriteria`'s header spells out: a fenced block
  // quoting one of these assertions is an example, not a claim about this spec.
  const elided = elide(authoredText);
  const haystack = elided.toLowerCase();

  const amended = amendedCriterionIds(authoredText, elide);
  const amendedSet = new Set(amended);

  const findings: CriterionReconciliationFinding[] = [];
  const seen = new Set<string>();

  for (const assertion of UNMET_ASSERTIONS) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(assertion, from);
      if (at === -1) break;
      from = at + assertion.length;

      const heading = enclosingHeading(elided, at);
      if (heading !== null && DISCHARGE_HEADINGS.some((re) => re.test(heading))) continue;

      // Clamped to the enclosing section — see `sectionSpan`.
      const span = sectionSpan(elided, at);
      const windowStart = Math.max(span.start, at - ADJACENCY_WINDOW_CHARS);
      const windowEnd = Math.min(span.end, at + assertion.length + ADJACENCY_WINDOW_CHARS);
      const window = elided.slice(windowStart, windowEnd);

      CRITERION_ID.lastIndex = 0;
      let idMatch: RegExpExecArray | null;
      while ((idMatch = CRITERION_ID.exec(window)) !== null) {
        const criterionId = `${(idMatch[1] ?? "").toUpperCase()}${idMatch[2] ?? ""}`;
        if (amendedSet.has(criterionId)) continue;
        const key = `${criterionId}:${assertion}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          criterionId,
          assertion,
          excerpt: excerptAround(elided, at, assertion.length),
        });
      }
    }
  }

  return { findings, amended };
}
