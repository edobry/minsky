#!/usr/bin/env bun
/**
 * Attribute `code-mechanism-assertion`'s false-positive pressure across the
 * SUB-OPERATIONS of claim construction (mt#4650 SC2).
 *
 * ## Why this exists
 *
 * ADR-034's reopen condition 2 fires on "a measured FP rate above 10% on a
 * classified corpus". That rate is a DETECTOR-level rate, but ADR-034 governs
 * exactly one sub-operation — symbol ADMISSION (`isPlausibleSymbol`). Reading the
 * pooled rate as evidence about admission attributes to one sub-operation a
 * failure that may live in another.
 *
 * Claim construction is not atomic. `buildClaims` in
 * `.minsky/hooks/code-mechanism-assertion-detector.ts` runs, in order:
 *
 *   (1) match a predicate from `PREDICATE_PATTERNS` against the prose
 *   (2) collect symbols within `SYMBOL_PROXIMITY_CHARS` (= 100) of the match
 *       -- `symbolsNear(prose, idx, SYMBOL_PROXIMITY_CHARS)`
 *   (3) admit/reject each by SHAPE -- `isPlausibleSymbol`, the ADR-034 surface
 *   (4) pair symbol with predicate, and drop artifact pairs (`isArtifactPair`, mt#4387)
 *   (5) decide backing / suppression
 *
 * ## What population this measures, and what it does NOT (PR #3406 R1)
 *
 * **The denominator is every INJECTED claim, not the CLASSIFIED-FALSE subset.**
 * That distinction is load-bearing and was originally blurred. The classified-false
 * labels (8 of 11, 10 of 13) live in `/calibration-review` pass output, not in the
 * JSONL, so this script cannot restrict to them -- there is no field to filter on.
 *
 * Rather than silently report a superset, the output states the denominator and
 * carries the structural argument that makes the numbers usable anyway:
 *
 *   **A true positive lands in the residue by construction.** For a claim to be a
 *   genuine unverified-mechanism assertion, its symbol has to be a real repo
 *   identifier (so NOT in the admission bucket) and its predicate has to actually
 *   belong to that symbol (so NOT in the pairing bucket). So the structural buckets
 *   are populated almost entirely by false positives, while true positives
 *   concentrate in the residue.
 *
 * The consequence runs in the conservative direction: measuring against the larger
 * injected denominator UNDERSTATES each bucket's share of the false population. A
 * bucket that is 20% of injected claims is a larger share of the falses.
 *
 * ## Egress
 *
 * stdout ONLY. No network calls, no files written, no subprocess receives claim
 * text -- the only subprocess is `grep -rl <symbol>`, which receives a single
 * identifier token. Judged excerpts are read to locate sentence boundaries and are
 * never printed; only symbol/predicate token pairs reach stdout.
 *
 * ## Usage
 *
 *   bun scripts/measure-cma-fp-attribution.ts
 *   bun scripts/measure-cma-fp-attribution.ts --since 2026-08-21 --until 2026-08-27T01:00
 *   bun scripts/measure-cma-fp-attribution.ts --json
 *
 * Exit 0 = measured. Exit 1 = the log or a search root is unusable, or an argument
 * is malformed. Exit 2 = the window contains no injected claims although the log
 * has records, which means the window bounds are probably wrong rather than the
 * corpus being quiet.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

const DEFAULT_LOG = ".minsky/code-mechanism-assertion-calibration.jsonl";

/**
 * Default window. These are the bounds the mt#4650 measurement was taken over, and
 * they are FROZEN deliberately so the ADR's quoted figures stay reproducible as the
 * live log grows. Pass --since/--until to measure a different window; the output
 * always echoes which bounds were used, so a reader never has to assume.
 */
const DEFAULT_SINCE = "2026-08-21";
const DEFAULT_UNTIL = "2026-08-27T01:00";

/**
 * Roots a repo-membership test searches. Deliberately WIDER than the TS-export
 * index ADR-034 evaluated -- it includes `scripts/` and `.minsky/hooks`, so MCP
 * tool ids, guard names and env vars count as members. A narrower test would
 * flatter the membership hypothesis by construction.
 */
const REPO_ROOTS = ["src", "packages", "scripts", ".minsky/hooks"];

/**
 * Files excluded from the membership search because they are ABOUT the measurement
 * rather than part of the measured corpus.
 *
 * This is not hygiene, it is a correctness fix caught on the first re-run (PR #3406
 * R1). This script's own docblocks quote the symbols it reports -- `unless`,
 * `driver`, `scratchpad/mt4556-poll.log` -- and `scripts/` is a search root, so the
 * artifact contaminated the corpus it measures. The observed effect: the admission
 * bucket fell 9 -> 8 the moment the examples were written down, because
 * `scratchpad/mt4556-poll.log` began grepping as in-repo.
 *
 * The direction matters. Contamination can only move a symbol from "not in repo"
 * toward "in repo", so it SHRINKS the admission bucket -- i.e. it biases the
 * measurement toward this task's own conclusion that admission is a minority
 * contributor. That is the direction a measurement's author is least likely to
 * question, which is why it is excluded explicitly rather than left as a caveat.
 */
const SELF_EXCLUDE = ["scripts/measure-cma-fp-attribution.ts"];

/**
 * Sentence split. Approximate by construction: a newline ends a sentence, as does
 * `.`/`!`/`?` followed by whitespace. Abbreviation-internal periods are NOT
 * handled, which biases the cross-sentence count DOWN (an abbreviation splits a
 * sentence that should have stayed whole, so a pair inside it reads as crossing).
 * Stated rather than hidden: the figure this produces is a floor.
 */
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n/;

/** ISO-ish date or datetime prefix. Anchored, so a typo fails loudly. */
const WINDOW_BOUND_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Token-aware containment (PR #3406 R1). A bare `haystack.includes(needle)` matched
 * `git` inside `github` and `digit`, which inflated both `symbolLocated` and
 * `sameSentence` -- and inflating `sameSentence` DEFLATES the cross-sentence pairing
 * count, i.e. it biased the measurement toward the conclusion that pairing was a
 * small problem.
 *
 * `\b` is not usable here: symbols legitimately contain `.`, `/` and `-`
 * (`environment.ts`, `scratchpad/mt4556-poll.log`, `silent-stretch-detector`), and
 * `\b` would fire in their middles. Instead require that the characters flanking the
 * match are not word characters, which is the property that actually matters.
 */
function containsToken(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : (haystack[i - 1] ?? "");
    const afterIdx = i + needle.length;
    const after = afterIdx >= haystack.length ? "" : (haystack[afterIdx] ?? "");
    const boundedLeft = before === "" || !WORD_CHAR.test(before);
    const boundedRight = after === "" || !WORD_CHAR.test(after);
    if (boundedLeft && boundedRight) return true;
    from = i + 1;
  }
}

interface Claim {
  timestamp: string;
  symbol: string;
  predicate: string;
  sameSentence: boolean;
  symbolLocated: boolean;
  /** `null` = membership could not be determined; NOT the same as `false`. */
  inRepo: boolean | null;
  isArtifact: boolean;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  // A flag present with a missing or flag-shaped value is an error, not a silent
  // fallback to the default -- the default would then be reported as if requested.
  if (v === undefined || v.startsWith("--")) {
    console.error(`FAIL: --${name} requires a value.`);
    process.exit(1);
  }
  return v;
}

function requireWindowBound(name: string, value: string): string {
  if (!WINDOW_BOUND_RE.test(value)) {
    console.error(
      `FAIL: --${name} must be an ISO date or datetime prefix (e.g. 2026-08-21 or ` +
        `2026-08-27T01:00). Got: ${value}`
    );
    process.exit(1);
  }
  return value;
}

const logPath = arg("log") ?? DEFAULT_LOG;
const since = requireWindowBound("since", arg("since") ?? DEFAULT_SINCE);
const until = requireWindowBound("until", arg("until") ?? DEFAULT_UNTIL);
const asJson = process.argv.includes("--json");

if (since > until) {
  console.error(`FAIL: --since (${since}) is after --until (${until}).`);
  process.exit(1);
}

if (!existsSync(logPath)) {
  console.error(`FAIL: calibration log not found at ${logPath}`);
  process.exit(1);
}

// Validate the search roots ONCE, up front. Without this a mistyped or missing root
// makes `grep` exit 2 for every symbol, and a naive "exit 0 means found" reading
// turns that into "nothing is in the repo" -- which would inflate the admission
// bucket to 100% and look like a finding rather than a broken probe (mem#728).
const missingRoots = REPO_ROOTS.filter((r) => !existsSync(r) || !statSync(r).isDirectory());
if (missingRoots.length > 0) {
  console.error(
    `FAIL: search root(s) missing or not a directory: ${missingRoots.join(", ")}. ` +
      `Run from the repository root.`
  );
  process.exit(1);
}

let raw: string;
try {
  raw = readFileSync(logPath, "utf8");
} catch (err) {
  console.error(`FAIL: could not read ${logPath}: ${(err as Error).message}`);
  process.exit(1);
}

const membershipCache = new Map<string, boolean | null>();

/**
 * Repo membership by content search, not by symbol index -- the repo ships no
 * identifier index (verified 2026-08-27, and the reason ADR-034's condition 3 has
 * not fired). A token appearing anywhere under the roots counts as a member.
 *
 * Returns `null` when the search could not be performed, rather than collapsing it
 * onto `false`. grep's exit codes are 0 = matched, 1 = no match, 2 = error; only 1
 * is a real negative.
 */
function inRepo(symbol: string): boolean | null {
  const cached = membershipCache.get(symbol);
  if (cached !== undefined) return cached;
  let result: boolean | null;
  try {
    const res = Bun.spawnSync(
      [
        "grep",
        "-rl",
        "--binary-files=without-match",
        ...SELF_EXCLUDE.map((f) => `--exclude=${f.split("/").pop()}`),
        "-F",
        "--",
        symbol,
        ...REPO_ROOTS,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (res.exitCode === 0) result = true;
    else if (res.exitCode === 1) result = false;
    else {
      console.error(
        `WARN: membership search for ${JSON.stringify(symbol)} failed ` +
          `(grep exit ${res.exitCode}): ${res.stderr.toString().trim()}`
      );
      result = null;
    }
  } catch (err) {
    console.error(
      `WARN: could not spawn grep for ${JSON.stringify(symbol)}: ${(err as Error).message}`
    );
    result = null;
  }
  membershipCache.set(symbol, result);
  return result;
}

/**
 * PROXY for a predicate-EXTRACTION defect: the extracted predicate spans more than
 * one token. Every entry in `PREDICATE_PATTERNS` is documented as a BEHAVIOR verb
 * (`clamps`, `returns`, `drops`), so a single token is the healthy shape and a
 * multi-token capture is usually a noun phrase the matcher swept up.
 *
 * Deliberately labelled a proxy: a legitimate multi-word verb phrase lands here too,
 * so it OVER-counts. Reported to size the class, not to convict individual claims --
 * which is why it is not subtracted from the residue.
 */
const MULTI_TOKEN_PREDICATE_RE = /\s/;

/**
 * A "bare word" symbol: a single all-lowercase segment with no identifier
 * punctuation. This is the class where NEITHER discriminator works:
 *
 *  - SHAPE cannot separate it, because `driver` and `unless` are the same shape.
 *  - MEMBERSHIP cannot either, because an ordinary English word appears somewhere
 *    under the repo roots essentially always -- so it scores in-repo for a reason
 *    unrelated to naming a code mechanism.
 *
 * Known TRUE positives (`driver`) and known FALSE positives (`unless`, `license`)
 * both live here, so it is reported as a shape-ambiguous population, not an error
 * count.
 */
const BARE_WORD_RE = /^[a-z]+$/;

let totalRecords = 0;
let malformedLines = 0;
const claims: Claim[] = [];

for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // A partially-flushed trailing line is expected on a live append-only log. Counted
    // rather than silently dropped, so a systematically corrupt log cannot masquerade
    // as a quiet one.
    malformedLines += 1;
    continue;
  }
  totalRecords += 1;

  const ts = typeof rec.timestamp === "string" ? rec.timestamp : "";
  if (ts < since || ts > until) continue;

  // "Injected" approximates the sweep's own definition (`!isSuppressedRecord &&
  // !isRevisedAway && !isEvaluationOnlyRecord`) with the two fields a raw reader has:
  // a non-empty claim set and no suppression reason.
  const suppression = Array.isArray(rec.suppressionReasons) ? rec.suppressionReasons : [];
  if (suppression.length > 0) continue;
  const recClaims = Array.isArray(rec.claims) ? rec.claims : [];
  if (recClaims.length === 0) continue;

  const judged = rec.judgedInput as { excerpt?: unknown } | undefined;
  const excerpt = typeof judged?.excerpt === "string" ? judged.excerpt : "";
  const sentences = excerpt.split(SENTENCE_SPLIT);

  for (const c of recClaims) {
    const claim = c as { symbol?: unknown; predicate?: unknown };
    const symbol = typeof claim.symbol === "string" ? claim.symbol : "";
    const predicate = typeof claim.predicate === "string" ? claim.predicate : "";
    if (!symbol) continue;

    let symbolLocated = false;
    let sameSentence = false;
    for (const s of sentences) {
      if (!containsToken(s, symbol)) continue;
      symbolLocated = true;
      if (containsToken(s, predicate)) {
        sameSentence = true;
        break;
      }
    }

    claims.push({
      timestamp: ts,
      symbol,
      predicate,
      sameSentence,
      symbolLocated,
      inRepo: inRepo(symbol),
      isArtifact: symbol.toLowerCase() === predicate.toLowerCase(),
    });
  }
}

if (claims.length === 0) {
  console.error(
    `No injected claims in ${since}..${until} (log has ${totalRecords} records). ` +
      `Check the window bounds before reading this as a quiet corpus.`
  );
  process.exit(totalRecords > 0 ? 2 : 0);
}

const distinctSymbols = new Set(claims.map((c) => c.symbol));
const notInRepo = claims.filter((c) => c.inRepo === false);
const membershipUnknown = claims.filter((c) => c.inRepo === null);
const crossSentence = claims.filter((c) => c.symbolLocated && !c.sameSentence);
const artifacts = claims.filter((c) => c.isArtifact);
const unlocated = claims.filter((c) => !c.symbolLocated);
const bareWord = claims.filter((c) => BARE_WORD_RE.test(c.symbol));
const bareWordInRepo = bareWord.filter((c) => c.inRepo === true);
const multiTokenPredicate = claims.filter((c) => MULTI_TOKEN_PREDICATE_RE.test(c.predicate.trim()));

// A claim can sit in more than one bucket -- a non-repo symbol paired across a
// sentence boundary is both. Report the union so the residue is honest: it is what
// NO structural bucket explains, not "everything else".
const explained = claims.filter(
  (c) => c.inRepo === false || (c.symbolLocated && !c.sameSentence) || c.isArtifact
);
const residue = claims.filter((c) => c.inRepo === true && c.sameSentence && !c.isArtifact);

const report = {
  window: { since, until },
  logPath,
  denominator: "all injected claims (NOT the classified-false subset -- see header)",
  totalRecordsInLog: totalRecords,
  malformedLines,
  injectedClaims: claims.length,
  distinctSymbols: distinctSymbols.size,
  buckets: {
    admission_symbolNotInRepo: notInRepo.length,
    pairing_crossSentence: crossSentence.length,
    extraction_multiTokenPredicateProxy: multiTokenPredicate.length,
    artifact_symbolEqualsPredicate: artifacts.length,
    unlocated_symbolNotFoundInExcerpt: unlocated.length,
    membershipUndetermined: membershipUnknown.length,
    shapeAmbiguous_bareLowercaseWord: bareWord.length,
    shapeAmbiguous_bareWordScoringInRepo: bareWordInRepo.length,
  },
  explainedByAStructuralBucket: explained.length,
  residueRequiringJudgment: residue.length,
  detail: {
    admission: notInRepo.map((c) => `${c.symbol} / ${c.predicate}`),
    pairing: crossSentence.map((c) => `${c.symbol} / ${c.predicate}`),
    extraction: [...new Set(multiTokenPredicate.map((c) => c.predicate.trim()))],
    artifact: artifacts.map((c) => `${c.symbol} / ${c.predicate}`),
    membershipUndetermined: membershipUnknown.map((c) => c.symbol),
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`=== code-mechanism-assertion FP attribution (mt#4650 SC2) ===`);
console.log(`window:            ${since} .. ${until}`);
console.log(`log:               ${logPath} (${totalRecords} records, ${malformedLines} malformed)`);
console.log(`injected claims:   ${claims.length}  (${distinctSymbols.size} distinct symbols)`);
console.log(`denominator:       ALL injected claims, not the classified-false subset.`);
console.log(`                   A true positive lands in the residue by construction, so the`);
console.log(`                   structural buckets are almost all false and these shares`);
console.log(`                   UNDERSTATE each bucket's share of the false population.`);
console.log(``);
console.log(`Sub-operation buckets (OVERLAPPING -- a claim may sit in several):`);
console.log(`  (3) admission  -- symbol not in repo:            ${notInRepo.length}`);
console.log(`  (2/4) pairing  -- predicate crosses sentence:    ${crossSentence.length}`);
console.log(`  (1) extraction -- multi-token predicate (proxy): ${multiTokenPredicate.length}`);
console.log(`  (4) artifact   -- symbol == predicate:           ${artifacts.length}`);
console.log(`      unlocated  -- symbol absent from excerpt:    ${unlocated.length}`);
console.log(`      membership undetermined (NOT 'not found'):   ${membershipUnknown.length}`);
console.log(``);
console.log(`explained by >=1 structural bucket: ${explained.length} / ${claims.length}`);
console.log(`residue (in-repo, same-sentence):   ${residue.length} / ${claims.length}`);
console.log(``);
console.log(`Shape-ambiguous class (NEITHER discriminator separates it):`);
console.log(`  bare lowercase word:               ${bareWord.length}`);
console.log(`  ...of which score IN-REPO:         ${bareWordInRepo.length}`);
console.log(`  symbols: ${[...new Set(bareWord.map((c) => c.symbol))].join(", ")}`);
console.log(``);
console.log(`ADMISSION (the ADR-034 surface):`);
for (const c of notInRepo) console.log(`  ${c.symbol} / ${c.predicate}`);
console.log(``);
console.log(`PAIRING (mt#4675):`);
for (const c of crossSentence) console.log(`  ${c.symbol} / ${c.predicate}`);
console.log(``);
console.log(`EXTRACTION (proxy, unowned): ${report.detail.extraction.join(" | ")}`);
if (artifacts.length > 0) {
  console.log(``);
  console.log(`ARTIFACT (already filtered by mt#4387):`);
  for (const c of artifacts) console.log(`  ${c.symbol} / ${c.predicate}`);
}
if (membershipUnknown.length > 0) {
  console.log(``);
  console.log(`MEMBERSHIP UNDETERMINED (excluded from the admission bucket):`);
  for (const s of new Set(membershipUnknown.map((c) => c.symbol))) console.log(`  ${s}`);
}
process.exit(0);
