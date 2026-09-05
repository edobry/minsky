/* eslint-disable custom/no-real-fs-in-tests -- this check's entire subject is the REAL source
   tree: it asserts that no live-corpus reader resolves an EVALUATION log against the repo root. A
   mocked filesystem would assert that a fixture I wrote contains what I put in it, which is the
   can't-fail probe (mem#704) rather than the check. Same reasoning and the same file-scoped
   exemption as `calibration-log-defaults.test.ts`, whose pure/IO split this file mirrors:
   `findRepoRootedEvaluationLiterals` takes source STRINGS and touches no fs, and the fs is
   confined to `sourceOf`. */
/**
 * mt#4972 — the evaluation-log readers must not resolve a pre-mt#4748 repo path.
 *
 * The evaluation-family sibling of `calibration-log-defaults.test.ts` (mt#4971). Separate file
 * rather than another list in that one because the two families have DIFFERENT resolvers
 * (`evaluationLogPath` vs `calibrationLogPath`) and different filename suffixes, so a single
 * combined list would need a per-entry family tag to assert either property.
 *
 * ## Why a source scan rather than a behavioural assertion
 *
 * Each script's default is a module-level `const` that is not exported, and importing a script
 * executes its `main()`. So the property has to be checked in the source. This inherits a text
 * scan's bound: it sees literals, not computed paths. It is a floor under a class that had no
 * check at all, not a proof of absence.
 *
 * ## Why these files are listed explicitly
 *
 * `scripts/lib/repo-rooted-telemetry-paths.ts` deliberately excludes `scripts/` from its own scan,
 * with a stated reason: *"a one-shot script that reads or consolidates the OLD location is doing
 * its job"*. That exclusion is correct and stays — `consolidate-evaluation-stream-logs.ts`, the
 * `migrate-*`/`backfill-*` scripts, and the scratch-dir writer `probe-mt3743-evaluation-stream.ts`
 * all read or assert the pre-migration location deliberately. So this test names the LIVE-CORPUS
 * readers instead, which is the population that exclusion's reason does not cover.
 *
 * A new replay/measure script over a live evaluation stream belongs in this list. One that
 * intentionally reads the pre-migration location does not.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Scripts whose default evaluation-log path must resolve through the writer's own resolver.
 *
 * Two, not the five mt#4972 was filed with: mt#4978 retired the `stop-at-decision` detector and
 * deleted all three of its replay scripts. Verified 2026-09-05 — `ls scripts/replay-stop-at-decision-*.ts`
 * matches nothing.
 */
export const EVALUATION_LIVE_CORPUS_READERS = [
  "scripts/measure-causal-premise-fn-rate.ts",
  "scripts/measure-negative-existence-recall.ts",
] as const;

/**
 * A repo-rooted evaluation-log literal, in BOTH forms the codebase writes them.
 *
 * The decomposed form is not a stylistic variant — in the calibration half (mt#4971) it is what
 * made the class undercount: a first pass grepped only the slash form and reported eight files
 * when there were ten. Both forms are matched here so the same undercount cannot recur on this
 * family.
 */
const REPO_ROOTED_PATTERNS: readonly RegExp[] = [
  // "…/.minsky/<name>-evaluations.jsonl" — the slash form.
  /["'`][^"'`]*\.minsky\/[a-z0-9-]+-evaluations\.jsonl["'`]/,
  // join/resolve(…, ".minsky", "<name>-evaluations.jsonl") — the decomposed form.
  /["'`]\.minsky["'`]\s*,\s*["'`][a-z0-9-]+-evaluations\.jsonl["'`]/,
];

/**
 * Comments are stripped first: these files legitimately DISCUSS the old path in a docblock
 * explaining the migration, and flagging that prose would make the fix and its own explanation
 * mutually exclusive.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Pure: every repo-rooted evaluation literal in one source string. No fs. */
export function findRepoRootedEvaluationLiterals(source: string): string[] {
  const code = stripComments(source);
  return REPO_ROOTED_PATTERNS.flatMap((p) => {
    const hit = code.match(p);
    return hit ? [hit[0]] : [];
  });
}

function sourceOf(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("mt#4972 — evaluation-log readers resolve through the writer's resolver", () => {
  test("every live-corpus reader calls evaluationLogPath", () => {
    const missing = EVALUATION_LIVE_CORPUS_READERS.filter(
      (p) => !sourceOf(p).includes("evaluationLogPath(")
    );
    expect(missing).toEqual([]);
  });

  test("no live-corpus reader carries a repo-rooted evaluation literal", () => {
    const violations = EVALUATION_LIVE_CORPUS_READERS.flatMap((p) =>
      findRepoRootedEvaluationLiterals(sourceOf(p)).map((literal) => `${p}: ${literal}`)
    );
    expect(violations).toEqual([]);
  });

  test("the patterns match the shapes they are meant to catch", () => {
    // Guards the guard: patterns that matched nothing would let both assertions above pass
    // vacuously, which is the failure mode a source scan is most prone to.
    expect(
      findRepoRootedEvaluationLiterals('const L = ".minsky/causal-premise-evaluations.jsonl";')
    ).toEqual(['".minsky/causal-premise-evaluations.jsonl"']);
    expect(
      findRepoRootedEvaluationLiterals(
        'resolve(dir, "..", ".minsky", "negative-existence-claim-evaluations.jsonl");'
      )
    ).toEqual(['".minsky", "negative-existence-claim-evaluations.jsonl"']);
  });

  test("a docblock mentioning the old path is not a violation", () => {
    // The fix and its own explanation must not be mutually exclusive: both covered files
    // describe the migration in prose, which is why stripComments runs first.
    expect(
      findRepoRootedEvaluationLiterals(
        '/** was ".minsky/causal-premise-evaluations.jsonl" before mt#4748 */\nconst L = resolved;'
      )
    ).toEqual([]);
  });
});
