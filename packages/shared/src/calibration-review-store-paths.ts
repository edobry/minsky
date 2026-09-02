/**
 * Shared resolver for the calibration-review STATE stores — mt#4880.
 *
 * Three JSON stores plus one lock, written and read by three modules in three
 * different trees:
 *
 * - `.minsky/hooks/calibration-review-cadence-detector.ts` — writes the watermark
 *   and last-warned stores.
 * - `src/adapters/shared/commands/calibration.ts` — writes the watermark store,
 *   the claim store (mt#4164), and holds the lock across both.
 * - `src/cockpit/ask-state-cache.ts` — READS the watermark store.
 *
 * Until mt#4880 each of those six-plus call sites did its own
 * `join(repoRoot, ".minsky/calibration-review-*.json")`, which put the stores in
 * **every Minsky-managed project's working tree** — the class mt#4748 re-rooted
 * for the calibration/evaluation STREAMS and did not reach for these. Only this
 * repo's own `.gitignore` ever neutralized them, which is a minsky-repo-only
 * property and precisely the premise mt#4748 exists to retire.
 *
 * **Why `packages/shared` and not a per-tree copy.** The established convention
 * for this migration is that each module tree carries its own copy rather than
 * importing across the `.minsky/hooks` ↔ `src` boundary (see `projectStateKey`
 * duplicated in `dispatcher.ts` / `ingest-runtime.ts` / `coverage-receipt.ts`).
 * That convention protects THAT boundary, and this module does not cross it:
 * `@minsky/shared` is the sanctioned shared layer for both sides, and
 * `calibration-review-cadence-detector.ts` already imports `@minsky/shared/paths`
 * for `getMinskyStateDir`. A reader and a writer disagreeing about a store's path
 * IS the mt#4811 failure (17,187 bytes on disk, nothing where the sweep looked),
 * so for a store with a reader in a THIRD tree, one resolver is the point.
 *
 * **Project-keyed, not flat — and that is forced by the key space.** The watermark
 * store's KEYS are calibration-log names in repo-relative form
 * (`.minsky/wall-of-text-calibration.jsonl`), a form `CalibrationLogEntry`'s
 * docblock (`src/domain/calibration/calibration-sweep.ts`) documents as deliberate:
 * "a NAME, not a resolvable filesystem path," translated at consumption time. Every
 * managed project therefore produces the SAME key set, so a FLAT store would
 * conflate two projects' watermarks under one key. That is a correctness failure,
 * not untidiness — and it is why mt#4816's precedent (`subagent-model-mismatch`,
 * state-dir and FLAT) does not transfer: that decision follows `resolveStreamPath`,
 * which project-keys only the `calibration` and `evaluation` STREAM families. These
 * are not streams and never pass through it.
 *
 * @see mt#4880 — this task
 * @see mt#4748 — the migration whose residue this is
 * @see mt#4816 — shipped the check that flagged these three modules, and allowlisted
 *   them as `DELIBERATE, AND UNDECIDED` pending this decision
 * @see mt#4885 — the reader/writer PROJECT-KEY precedence gap, deliberately out of
 *   scope here: this module takes whatever root its caller already passes, so the
 *   move does not change which key a given caller computes
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { getMinskyStateDir } from "./paths";

/** Bare filenames — no `.minsky/` prefix; the resolver supplies the directory. */
export const WATERMARK_STORE_FILENAME = "calibration-review-watermarks.json";
export const WATERMARK_LOCK_FILENAME = "calibration-review-watermarks.lock";
export const LAST_WARNED_STORE_FILENAME = "calibration-review-cadence-last-warned.json";
export const CLAIM_STORE_FILENAME = "calibration-review-claims.json";

/** Every file this family owns, so a migration or a sweep can enumerate them. */
export const CALIBRATION_REVIEW_STORE_FILENAMES = [
  WATERMARK_STORE_FILENAME,
  WATERMARK_LOCK_FILENAME,
  LAST_WARNED_STORE_FILENAME,
  CLAIM_STORE_FILENAME,
] as const;

/**
 * Deterministic sha256 over the resolved absolute repo root, first 16 hex chars.
 *
 * Deliberately byte-identical to the three existing copies (`dispatcher.ts`,
 * `ingest-runtime.ts`, `coverage-receipt.ts`) — the whole contract is "same input →
 * same output", so a store written under this key must land in the same
 * `projects/<key>/` directory the calibration streams already use. Pinned by a test
 * rather than by convention, because a silent divergence here separates a store from
 * the logs it indexes with no error anywhere.
 */
export function projectStateKey(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

/** The project-keyed directory these stores live in. */
export function calibrationReviewStoreDir(repoRoot: string): string {
  return join(getMinskyStateDir(), "projects", projectStateKey(repoRoot));
}

/**
 * Resolve one store file for a given repo root.
 *
 * `repoRoot` is whatever the caller already resolved — this module deliberately
 * does NOT add a `CLAUDE_PROJECT_DIR` or `MINSKY_STATE_DIR` tier of its own.
 * `getMinskyStateDir`'s docblock records why the latter is absent (it would
 * outrank the `XDG_STATE_HOME` override seven test files use), and the former is
 * mt#4885's question, fenced out of this task's scope so the move changes WHERE
 * the stores live without changing WHICH key any caller computes.
 */
export function calibrationReviewStorePath(filename: string, repoRoot: string): string {
  return join(calibrationReviewStoreDir(repoRoot), filename);
}
