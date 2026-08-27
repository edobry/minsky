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
 * failure that may live in another, which is the attribution error mt#4650's
 * planning pass surfaced.
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
 * This script buckets each injected claim by which sub-operation's defect
 * explains it, so a mechanism decision rests on where the pressure actually is.
 *
 * ## Egress
 *
 * stdout ONLY. No network calls, no files written, no subprocess receives claim
 * text -- the only subprocess is `grep -rl <symbol>`, which receives a single
 * identifier token. Judged excerpts are read to locate sentence boundaries and
 * are never printed; only symbol/predicate token pairs reach stdout.
 *
 * ## Usage
 *
 *   bun scripts/measure-cma-fp-attribution.ts
 *   bun scripts/measure-cma-fp-attribution.ts --since 2026-08-21 --until 2026-08-27T01:00
 *   bun scripts/measure-cma-fp-attribution.ts --json
 *
 * Exit 0 = measured (including a legitimately empty window). Exit 1 = the log is
 * unreadable. Exit 2 = the window contains no injected claims AND the log has
 * records, which means the window bounds are probably wrong rather than the
 * corpus being quiet.
 */

import { existsSync, readFileSync } from "node:fs";

const DEFAULT_LOG = ".minsky/code-mechanism-assertion-calibration.jsonl";

/**
 * Roots a repo-membership test searches. Deliberately WIDER than the TS-export
 * index ADR-034 evaluated -- it includes `scripts/` and `.minsky/hooks`, so MCP
 * tool ids, guard names and env vars count as members. A narrower test would
 * flatter the membership hypothesis by construction.
 */
const REPO_ROOTS = ["src", "packages", "scripts", ".minsky/hooks"];

/**
 * Sentence split. Approximate by construction: a newline ends a sentence, as does
 * `.`/`!`/`?` followed by whitespace. Abbreviation-internal periods are NOT
 * handled, which biases the cross-sentence count DOWN (an abbreviation splits a
 * sentence that should have stayed whole, so a pair inside it reads as crossing).
 * Stated rather than hidden: the figure this produces is a floor, not a point
 * estimate.
 */
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n/;

interface Claim {
  timestamp: string;
  symbol: string;
  predicate: string;
  sameSentence: boolean;
  symbolLocated: boolean;
  inRepo: boolean;
  isArtifact: boolean;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const logPath = arg("log") ?? DEFAULT_LOG;
const since = arg("since") ?? "2026-08-21";
const until = arg("until") ?? "2026-08-27T01:00";
const asJson = process.argv.includes("--json");

if (!existsSync(logPath)) {
  console.error(`SKIP: calibration log not found at ${logPath}`);
  process.exit(1);
}

let raw: string;
try {
  raw = readFileSync(logPath, "utf8");
} catch (err) {
  console.error(`FAIL: could not read ${logPath}: ${(err as Error).message}`);
  process.exit(1);
}

const membershipCache = new Map<string, boolean>();

/**
 * Repo membership by content search, not by symbol index -- the repo ships no
 * identifier index (verified 2026-08-27, and the reason ADR-034's condition 3 has
 * not fired). A token appearing anywhere under the roots counts as a member.
 */
function inRepo(symbol: string): boolean {
  const cached = membershipCache.get(symbol);
  if (cached !== undefined) return cached;
  const res = Bun.spawnSync(
    ["grep", "-rl", "--binary-files=without-match", "-F", "--", symbol, ...REPO_ROOTS],
    { stdout: "pipe", stderr: "pipe" }
  );
  // grep exits 1 for "no match" and 2 for a real error; only 0 means found.
  const found = res.exitCode === 0 && res.stdout.toString().trim().length > 0;
  membershipCache.set(symbol, found);
  return found;
}

let totalRecords = 0;
const claims: Claim[] = [];

for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // intentional-swallow: a partially-flushed trailing line is expected on a
    // live append-only log and must not abort the measurement.
    continue;
  }
  totalRecords += 1;

  const ts = typeof rec.timestamp === "string" ? rec.timestamp : "";
  if (ts < since || ts > until) continue;

  // "Injected" approximates the sweep's own definition (`!isSuppressedRecord &&
  // !isRevisedAway && !isEvaluationOnlyRecord`) with the two fields a raw reader
  // has: a non-empty claim set and no suppression reason. Stated because the
  // approximation, not the sweep, is what these counts are about.
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
      if (!s.includes(symbol)) continue;
      symbolLocated = true;
      if (predicate && s.includes(predicate)) {
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

/**
 * A "bare word" symbol: a single all-lowercase segment with no identifier
 * punctuation -- no camelCase hump, no `_`, `-`, `.`, `/` or `::`. This is the
 * class where NEITHER discriminator works, and it is the point of the whole
 * measurement:
 *
 *  - SHAPE cannot separate it, because `driver` and `unless` are the same shape.
 *  - MEMBERSHIP cannot separate it either, because an ordinary English word
 *    appears somewhere under the repo roots essentially always -- so it scores
 *    in-repo for a reason that has nothing to do with naming a code mechanism.
 *
 * That second point is what makes membership WORSE than inert here rather than
 * merely unhelpful: it returns a confident "member" for the tokens least likely
 * to be symbols. Known TRUE positives (`driver`) and known FALSE positives
 * (`unless`, `license`) both live in this bucket, which is why it is reported as
 * a shape-ambiguous population rather than as an error count.
 */
const BARE_WORD_RE = /^[a-z]+$/;

const distinctSymbols = new Set(claims.map((c) => c.symbol));
const notInRepo = claims.filter((c) => !c.inRepo);
const bareWord = claims.filter((c) => BARE_WORD_RE.test(c.symbol));
const bareWordInRepo = bareWord.filter((c) => c.inRepo);
const crossSentence = claims.filter((c) => c.symbolLocated && !c.sameSentence);
const artifacts = claims.filter((c) => c.isArtifact);
const unlocated = claims.filter((c) => !c.symbolLocated);

// A claim can sit in more than one bucket -- a non-repo symbol paired across a
// sentence boundary is both. Report the union so the residue is honest: it is
// what NO structural bucket explains, not "everything else".
const explained = claims.filter(
  (c) => !c.inRepo || (c.symbolLocated && !c.sameSentence) || c.isArtifact
);
const residue = claims.filter((c) => c.inRepo && c.sameSentence && !c.isArtifact);

const report = {
  window: { since, until },
  logPath,
  totalRecordsInLog: totalRecords,
  injectedClaims: claims.length,
  distinctSymbols: distinctSymbols.size,
  buckets: {
    admission_symbolNotInRepo: notInRepo.length,
    pairing_crossSentence: crossSentence.length,
    artifact_symbolEqualsPredicate: artifacts.length,
    unlocated_symbolNotFoundInExcerpt: unlocated.length,
    shapeAmbiguous_bareLowercaseWord: bareWord.length,
    shapeAmbiguous_bareWordScoringInRepo: bareWordInRepo.length,
  },
  explainedByAStructuralBucket: explained.length,
  residueRequiringJudgment: residue.length,
  detail: {
    admission: notInRepo.map((c) => `${c.symbol} / ${c.predicate}`),
    pairing: crossSentence.map((c) => `${c.symbol} / ${c.predicate}`),
    artifact: artifacts.map((c) => `${c.symbol} / ${c.predicate}`),
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`=== code-mechanism-assertion FP attribution (mt#4650 SC2) ===`);
console.log(`window:            ${since} .. ${until}`);
console.log(`log:               ${logPath} (${totalRecords} records)`);
console.log(`injected claims:   ${claims.length}  (${distinctSymbols.size} distinct symbols)`);
console.log(``);
console.log(`Sub-operation buckets (OVERLAPPING -- a claim may sit in several):`);
console.log(`  (3) admission  -- symbol not in repo:        ${notInRepo.length}`);
console.log(`  (2/4) pairing  -- predicate crosses sentence: ${crossSentence.length}`);
console.log(`  (4) artifact   -- symbol == predicate:        ${artifacts.length}`);
console.log(`      unlocated  -- symbol absent from excerpt: ${unlocated.length}`);
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
if (artifacts.length > 0) {
  console.log(``);
  console.log(`ARTIFACT (already filtered by mt#4387):`);
  for (const c of artifacts) console.log(`  ${c.symbol} / ${c.predicate}`);
}
process.exit(0);
