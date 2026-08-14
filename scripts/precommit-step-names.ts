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

/**
 * Every name passed to `PreCommitValidator.instrumented()` in `source`, sorted
 * and deduped.
 *
 * Split from the file read so the parse — the part with the interesting
 * behavior — is a pure function of a string, testable without a fixture tree
 * on disk.
 *
 * Returns null rather than an empty array when nothing matches. An empty set
 * is the dangerous return: it resolves as "no pre-commit step is known", which
 * reports every legitimate step as unknown at once. A checker that cries wolf
 * gets discounted, and takes its true positives with it (mem#719).
 */
export function parsePrecommitStepNames(source: string): string[] | null {
  const names = new Set<string>();
  for (const match of source.matchAll(/this\.instrumented\(\s*"([a-z0-9-]+)"/g)) {
    const name = match[1];
    if (name) names.add(name);
  }
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
