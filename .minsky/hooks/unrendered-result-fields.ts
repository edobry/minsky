// Plumbed-but-unrendered result fields — the pure core (mt#3913).
//
// Answers one question about a unified diff: does this change ADD a counter or
// flag to a `*Result` interface that no operator-facing output site renders?
//
// ## Why this exists
//
// mt#3514 added `orphansDeleted` and `orphanDeleteFailed` to `WriteTurnsResult`,
// threaded them through the classification into `ExtractAllTurnsResult`, and
// shipped with no output site rendering either. Typecheck passed (the types line
// up), the tests passed (`expect(result.orphansDeleted).toBe(3)` is exactly the
// assertion a never-rendered field satisfies), and two reviewer rounds passed.
// Every one of those gates measures internal correctness; none can tell "this
// field is correct" from "a human can see this field."
//
// The cost landed an hour later: the orphan DELETE silently failed to fire and
// the command printed an ordinary success line, because the two fields built to
// report exactly that condition were never surfaced (mt#3911). The diagnosis had
// to be rebuilt from raw SQL.
//
// ## The discriminator, and why the obvious one is wrong
//
// A field counts as RENDERED when its name appears in a string / template /
// array literal that is NOT inside a logger call.
//
// The obvious rule — "flag it if the name appears in no string literal, template
// literal, **or log call**" — is the one this task was originally specified
// with, and it FAILS on its own fixture. `orphansDeleted` appears in
// `logSink.warn(\`… removed ${orphansDeleted} …\`, { orphansDeleted, … })`, so
// that rule would have missed the exact field the incident turned on, while
// correctly flagging its sibling `orphanDeleteFailed` (no literal references at
// all). A rule that half-passes its regression fixture is not a regression
// fixture.
//
// A log sink is not an operator-facing output site. That is the whole
// distinction: the incident IS "it was logged somewhere nobody was reading, and
// the command printed success."

import { literalSpanList, stripLiterals, isExcludedPath } from "./output-label-tokens";

/**
 * Does `text` mention `name` as a whole identifier?
 *
 * Boundary-aware so `orphansDeleted` does not match inside
 * `orphansDeletedCount` (PR #2982 R1). The name comes from a parsed field
 * declaration and is `\w`-only by construction, so it needs no escaping — the
 * character class in `COUNTER_FIELD` is what guarantees that.
 */
function mentionsIdentifier(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
}

/**
 * Module roots whose `*Result` types are DECISION types, not operator payloads.
 *
 * A guard, hook, or detector's `*Result` is the return of a pure decision
 * function: `ChainScanResult.chained`, `QuestionAnswerResult.matched`,
 * `RenderPathEvidenceResult.hasArtifact`. Its fields feed the CALLER'S control
 * flow, and nothing was ever meant to render them — so "no output site renders
 * this field" is true of every one of them and says nothing. mt#4134's replay
 * measured them at **16 of 24 fires** over a pinned 400-commit range: the
 * dominant false-positive class, and one that grows with the corpus, since this
 * repo adds a detector most weeks.
 *
 * Note this is a DECLARATION-site exclusion, a different question from
 * `isExcludedPath` in `./output-label-tokens`, which excludes tests and docs
 * from counting as RENDER sites. A type declared here is not considered at all;
 * a render found here would still count.
 *
 * ## Why a path predicate, against ADR-034's preference
 *
 * ADR-034 decided the analogous axis for `code-mechanism-assertion` — "Symbol
 * identification stays shape-based. The repo-symbol allowlist is REJECTED as a
 * gate" — so a path list needs its deviation argued rather than assumed.
 *
 * Two things separate this case from that one:
 *
 *  1. **The objection there was COVERAGE, and it does not transfer.** ADR-034
 *     rejected the allowlist because "most true-positive claims are about
 *     identifiers outside any TS symbol index" — the space of identifiers is
 *     open and unenumerable. Module roots are neither: `**\/hooks/**` and
 *     `**\/detectors/**` are a closed, stable set that the repo's own layout
 *     maintains, with no index to build and none to go stale.
 *  2. **Its reopen condition 2 is met here.** ADR-034 gates a mechanism change
 *     on "a measured FP rate above 10% on a classified corpus"; this guard's is
 *     67% at minimum (16 of 24), measured and hand-classified under mt#4134.
 *
 * Shape-based alternatives were tried first and FALSIFIED against the real
 * fixture rather than rejected on taste — see the sibling note on
 * `findUnrenderedResultFields`.
 *
 * ## What this deliberately does not cover
 *
 * Four measured false positives are declared OUTSIDE these roots and still fire:
 * `SweepTickResult` (`src/cockpit/sweepers.ts`), `EnsureTokenResult`
 * (`src/mcp/daemon/`), `MaximalCollapseResult` (`packages/domain/src/engprod/`),
 * `BunTestRunResult` (`scripts/`). Widening to reach them would start the arms
 * race ADR-024 §Context names; they stay as measured residue, and the fire count
 * this narrowing produces is the honest one rather than a tuned one.
 */
export function isDecisionModulePath(path: string): boolean {
  return path.includes("/hooks/") || path.includes("/detectors/");
}

/** A counter or flag added to a `*Result` type with nothing rendering it. */
export interface UnrenderedField {
  /** The field name, e.g. `orphansDeleted`. */
  readonly name: string;
  /** The `*Result` interface it was added to. */
  readonly owner: string;
  /** Repo-relative path of the file declaring it. */
  readonly file: string;
}

/**
 * Types whose fields this detector considers.
 *
 * Deliberately narrow — a low-false-positive slice, not full coverage of
 * "observability nobody can see". A field on a non-`*Result` type is out of
 * scope by construction.
 */
const RESULT_INTERFACE = /^\s*export\s+interface\s+(\w*Result)\b/;

/** The observability shapes: a count or a flag, optional or not. */
const COUNTER_FIELD = /^\s*(\w+)\??:\s*(number|boolean)\s*;/;

/** A logger call opening on this line. */
const LOGGER_CALL = /\b(log(Sink)?|logger|console)\.\w+\s*\(/;

/** Strip the diff's leading +/-/space marker, leaving source text. */
function sourceOf(line: string): string {
  return line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")
    ? line.slice(1)
    : line;
}

/**
 * Line indices that fall inside a logger call.
 *
 * Multi-line by necessity: in the fixture the call opens on one line and the
 * field appears on two more, so a per-line test cannot see it. Paren depth is
 * tracked from the opening line until it balances, counted over the line with
 * literal INTERIORS blanked out.
 *
 * That blanking is load-bearing (PR #2982 R1). An earlier cut counted every
 * paren, with a comment claiming the error "can only ever END the span late …
 * never early." That claim is false, and the counter-example is one line long:
 *
 *   logger.warn(
 *     `something )`,
 *     { x }
 *   );
 *
 * The `)` inside the template drops depth to 0 on the opening line, so the span
 * ends immediately and the following lines read as ordinary code — which is the
 * DANGEROUS direction, because a logger-only reference then counts as a render
 * and a true finding is suppressed. Verified by running the count before fixing.
 */
export function loggerCallLines(lines: string[]): Set<number> {
  const inLogger = new Set<number>();
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const src = sourceOf(lines[i] ?? "");
    if (depth === 0 && !LOGGER_CALL.test(src)) continue;

    if (depth === 0) {
      // The opening line itself: count from the logger call onward, so a
      // preceding `)` on the same line does not close a span not yet open.
      const start = src.search(LOGGER_CALL);
      const tail = stripLiterals(src.slice(start));
      inLogger.add(i);
      depth = countParens(tail);
      if (depth <= 0) depth = 0;
      continue;
    }

    inLogger.add(i);
    depth += countParens(stripLiterals(src));
    if (depth <= 0) depth = 0;
  }
  return inLogger;
}

function countParens(text: string): number {
  let d = 0;
  for (const ch of text) {
    if (ch === "(") d++;
    else if (ch === ")") d--;
  }
  return d;
}

/**
 * Find counter/flag fields this diff ADDS to a `*Result` type that nothing
 * renders.
 *
 * Pure: diff text in, findings out. Never throws on malformed input — a diff it
 * cannot parse yields no findings, which the caller records as a clean
 * evaluation rather than a failure.
 *
 * ## A shape-based discriminator was tried first, and the fixture killed it
 *
 * Before the path predicate in {@link isDecisionModulePath}, mt#4147 tried the
 * more principled rule: **suppress when NO field of the owning type is rendered
 * anywhere in the diff** — the reasoning being that a field nobody renders, on a
 * type nobody renders, is an internal type, whereas the real defect is a field
 * nobody renders on a type that IS rendered.
 *
 * It is falsified by this detector's own regression fixture. In mt#3514's actual
 * diff, `WriteTurnsResult`'s only visible sibling is `erroredChunks`, which
 * nothing in that diff renders either — so the rule suppresses the exact true
 * positive the guard was built for. Two further shape candidates failed the same
 * way: "the field is consumed by a conditional" (mt#3514 wraps `orphansDeleted`
 * in `if (orphansDeleted > 0)`), and field-name vocabulary (`orphanDeleteFailed`
 * is boolean-verdict-shaped and is a true positive).
 *
 * This is the fourth time in this guard family that a defensible-on-inspection
 * rule failed on the real diff (mem#1035 records the first three). Recorded so
 * the next author re-derives it from the fixture rather than from the idea.
 */
export function findUnrenderedResultFields(diff: string): UnrenderedField[] {
  if (!diff) return [];

  const lines = diff.split("\n");
  const loggerLines = loggerCallLines(lines);

  // Pass 1 — added counter/flag fields inside a `*Result` interface.
  const added: UnrenderedField[] = [];
  let file = "";
  let owner: string | null = null;
  let braceDepth = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      file = raw === "/dev/null" ? "" : raw.replace(/^b\//, "");
      owner = null;
      braceDepth = 0;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) continue;
    if (line.startsWith("@@")) {
      // Hunk boundaries break interface tracking: the lines between hunks are
      // not shown, so a brace count carried across them is meaningless.
      //
      // But the header itself CARRIES the enclosing declaration — git appends
      // the section heading after the second `@@`, and for a field added to an
      // existing interface that heading is the only place the interface name
      // appears in the whole diff. mt#3514's fixture is exactly this shape:
      //
      //   @@ -59,6 +59,29 @@ export interface WriteTurnsResult {
      //
      // Resetting without reading it means no added field is ever attributed to
      // an owner, and the detector reports nothing on its own regression
      // fixture — silently, since "no owner" and "no fields" look identical
      // downstream. Found by running this against the real diff rather than a
      // hand-written one.
      const heading = line.replace(/^@@[^@]*@@/, "");
      const reopened = heading.match(RESULT_INTERFACE);
      owner = reopened?.[1] ?? null;
      braceDepth = owner ? Math.max(countBraces(heading), 1) : 0;
      continue;
    }
    if (!file || file.includes(".test.") || file.includes(".spec.")) continue;
    // A decision type's fields were never meant to be rendered, so "nothing
    // renders this" carries no information about them (mt#4147).
    if (isDecisionModulePath(file)) continue;

    const src = sourceOf(line);
    const opening = src.match(RESULT_INTERFACE);
    if (opening) {
      owner = opening[1] ?? null;
      braceDepth = countBraces(src);
      continue;
    }
    if (owner) {
      braceDepth += countBraces(src);
      if (braceDepth <= 0) {
        owner = null;
        braceDepth = 0;
        continue;
      }
      const field = line.startsWith("+") ? src.match(COUNTER_FIELD) : null;
      const name = field?.[1];
      if (name) added.push({ name, owner, file });
    }
  }

  if (added.length === 0) return [];

  // Pass 2 — does anything RENDER each field? A literal reference outside a
  // logger call counts; a reference inside one does not, which is the whole
  // discrimination (see the module header).
  //
  // File scoping is applied here too (PR #2982 R1). Without it this very PR
  // would suppress its own finding: its own `docs/architecture/hooks` page mentions
  // `orphansDeleted` in backticks, and a backticked word in Markdown is a
  // literal span exactly like one in code. A prose mention is not a render.
  const rendered = new Set<string>();
  let scanFile = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      scanFile = raw === "/dev/null" ? "" : raw.replace(/^b\//, "");
      continue;
    }
    if (loggerLines.has(i)) continue;
    if (line.startsWith("-")) continue;
    if (!scanFile || isExcludedPath(scanFile)) continue;
    // Per-span, with identifier boundaries: `spans.join()` then `includes()`
    // matched `orphansDeleted` inside `orphansDeletedCount`, and could match
    // across two spans that were never adjacent in the source.
    for (const span of literalSpanList(sourceOf(line))) {
      for (const f of added) {
        if (mentionsIdentifier(span, f.name)) rendered.add(f.name);
      }
    }
  }

  // A name added to MORE THAN ONE `*Result` type in the same diff cannot be
  // resolved from the render side, because a render site names the field and
  // never its owner. Rather than let one rendered occurrence silently mask an
  // unrendered sibling, report every field carrying an ambiguous name — a
  // log-only advisory should fail toward surfacing, and the alternative is the
  // false NEGATIVE this detector exists to prevent.
  const nameCounts = new Map<string, number>();
  for (const f of added) nameCounts.set(f.name, (nameCounts.get(f.name) ?? 0) + 1);

  const out = added.filter((f) => {
    const ambiguous = (nameCounts.get(f.name) ?? 0) > 1;
    return ambiguous || !rendered.has(f.name);
  });
  // Stable order so the warning text and the calibration record are
  // reproducible across runs on the same diff.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function countBraces(text: string): number {
  let d = 0;
  for (const ch of text) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}
