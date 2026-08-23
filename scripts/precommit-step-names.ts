/**
 * Resolve the pre-commit step names from source rather than from a snapshot
 * (mt#4071).
 *
 * `PRECOMMIT_STEP_NAMES` in `.minsky/hooks/known-guard-names.ts` is a
 * hand-maintained fallback, and that module's own header says to prefer fixing
 * the derivation over editing it. `scripts/audit-fire-log.ts` already did —
 * privately. The catalog generator did not, so it resolved its population
 * against the snapshot and omitted `interceptor-catalog-regen`, a pre-commit
 * step that had been firing since mt#4010 shipped it. The name was in neither
 * the oracle nor the descriptions, so it produced no divergence report
 * anywhere: the catalog simply did not contain one of its own build steps.
 *
 * This module is the shared owner, for the same reason
 * `interceptor-coordinate-input.ts` exists: two readers of the same declaring
 * fact must not each keep a copy. A drifting second copy is what PR #2914 R1
 * caught on `DELIBERATELY_UNAUTHORED_NAMES`, and its first symptom is one
 * surface resolving an interceptor while the other reports it as a gap, with
 * no error raised anywhere.
 *
 * @see .minsky/hooks/known-guard-names.ts — the snapshot this supersedes at run time
 * @see scripts/audit-fire-log.ts — the reader this was extracted from
 * @see scripts/build-interceptor-catalog.ts — the reader that was missing it
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PRECOMMIT_STEP_NAMES } from "../.minsky/hooks/known-guard-names";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Every `this.instrumented(` call site, whatever its first argument turns out to be. */
const CALL_SITE_RE = /this\.instrumented\s*\(/g;

/**
 * A call site whose first argument is a plain kebab-case string literal.
 *
 * Tolerates whitespace and line/block comments before the literal, and accepts
 * single, double or backtick quotes — the formatting variations that would
 * otherwise turn a legitimate step into a silent omission.
 */
const NAMED_CALL_RE =
  /this\.instrumented\s*\(\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(["'`])([a-z0-9-]+)\1/g;

/**
 * Every name passed to `PreCommitValidator.instrumented()` in `source`, sorted
 * and deduped — or null when the parse cannot account for every call site.
 *
 * Split from the file read so the parse — the part with the interesting
 * behavior — is a pure function of a string, testable without a fixture tree
 * on disk.
 *
 * **A PARTIAL parse returns null, not the names it managed to find (PR #3002
 * R1).** This is the whole point of the module. Returning a truncated set would
 * hand the catalog a population that silently omits a real enforcement point,
 * with no divergence reported anywhere — which is precisely the mt#4071 defect,
 * reintroduced through the fix for it. So the extracted names are counted
 * against the raw `this.instrumented(` call sites, and any shortfall means some
 * call site used a shape this parser does not read: the honest answer is then "I
 * could not derive this", which routes the caller to the snapshot fallback and
 * makes `audit-fire-log.ts` print `FELL BACK to snapshot`.
 *
 * The count check is deliberately structural rather than an enumeration of
 * syntax variants: it holds for a shape nobody has thought of yet, which an
 * ever-widened literal matcher does not.
 *
 * Null is also the return when nothing matches at all. An empty ARRAY would be
 * the dangerous value: it resolves as "no pre-commit step is known", reporting
 * every legitimate step as unknown at once. A checker that cries wolf gets
 * discounted, and takes its true positives with it (mem#719).
 */
export function parsePrecommitStepNames(source: string): string[] | null {
  const callSites = [...source.matchAll(CALL_SITE_RE)].length;
  if (callSites === 0) return null;

  const names = new Set<string>();
  let named = 0;
  for (const match of source.matchAll(NAMED_CALL_RE)) {
    const name = match[2];
    if (name) {
      names.add(name);
      named++;
    }
  }

  // Compare the MATCH count, not the deduped set size: the same step
  // instrumented twice is one name across two accounted-for call sites.
  if (named < callSites) return null;
  return names.size > 0 ? [...names].sort() : null;
}

/**
 * `parsePrecommitStepNames` applied to `src/hooks/pre-commit.ts` under
 * `repoRoot`, or null when that file cannot be read.
 */
export function derivePrecommitStepNames(repoRoot: string = REPO_ROOT): string[] | null {
  try {
    return parsePrecommitStepNames(
      readFileSync(join(repoRoot, "src", "hooks", "pre-commit.ts"), "utf-8")
    );
  } catch {
    return null;
  }
}

/**
 * The derived names when the parse succeeds, the snapshot when it does not.
 *
 * The derived set REPLACES the snapshot; it is not unioned with it. That is
 * deliberate and load-bearing in both directions: a step DELETED from
 * `pre-commit.ts` must stop being known, and a union would keep it known
 * forever — while a step ADDED to `pre-commit.ts` becomes known without anyone
 * remembering to touch the snapshot, which is the half mt#4071 was filed for.
 * The snapshot is a fallback for a failed parse, not a floor under the
 * derivation.
 */
export function resolvePrecommitStepNames(repoRoot: string = REPO_ROOT): readonly string[] {
  return derivePrecommitStepNames(repoRoot) ?? PRECOMMIT_STEP_NAMES;
}
