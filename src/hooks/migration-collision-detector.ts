/**
 * Detector for concurrent-migration collisions and journal `when` mutations.
 *
 * The 2026-07-19 ~5h production outage was caused by two parallel agents each
 * generating migration 0060; the renumber-resolution rewrote the journal `when`
 * of already-applied migrations 0061/0062 above the prod ledger watermark, so
 * Drizzle's high-water-mark migrator re-applied an already-applied migration on
 * boot → crash (incident memo Notion `3a2937f0`; mechanics memory `0c2427e5`).
 *
 * This guard is the collision-*prevention* complement to the blast-radius fix
 * (mt#2560, auto-migrate default OFF). It blocks, at commit time, any change
 * that would corrupt the journal relative to `origin/main`:
 *
 *   1. `when`-mutation — an entry whose tag is already on origin/main has a
 *      DIFFERENT `when` in the staged tree (a renumber backdated/advanced an
 *      already-shipped migration's timestamp — the 2026-07-19 0061/0062 case).
 *   2. number-collision — a NEW entry (tag not on origin/main) reuses a
 *      migration NUMBER (the NNNN prefix) already present on origin/main.
 *   3. non-monotonic — a NEW entry's `when` is <= the max `when` already on
 *      origin/main (re-introduces the non-monotonic-journal disease `0c2427e5`).
 *
 * Existing guards do NOT cover this: mt#2268 (`immutable-migration-detector`)
 * checks .sql CONTENT only; mt#2086/2087 (`migration-journal-check`) checks
 * sql<->journal SET consistency in the LOCAL tree only (no origin/main baseline,
 * no `when`-value comparison).
 *
 * Tracking task: mt#2948. Pure-function implementation — no I/O; the pre-commit
 * pipeline reads the staged journal and the origin/main baseline and passes
 * both in (mirrors `immutable-migration-detector.ts`).
 */

import type { JournalEntry } from "./migration-journal-check";

/**
 * Env var that, when truthy (`1` / `true` / `yes`), skips this check and emits
 * a one-line audit message. Use only for the rare legitimate reconcile (e.g. a
 * sanctioned prod-ledger realignment). Registered in `HOOK_ONLY_ENV_VARS` at
 * `packages/domain/src/configuration/sources/environment.ts` per the mt#1788
 * ESLint rule contract.
 */
export const MIGRATION_COLLISION_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_MIGRATION_COLLISION_CHECK";

/**
 * True when the env-var value should be interpreted as enabling the override.
 * Matches the casing rules the other hook overrides use (1/true/yes).
 */
export function isMigrationCollisionOverrideTruthy(envValue: string | undefined): boolean {
  if (!envValue) return false;
  const v = envValue.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export type MigrationJournalViolationKind = "when-mutation" | "number-collision" | "non-monotonic";

/**
 * Single source of truth for the violation-kind labels (used by the detector's
 * return objects AND the tests — avoids duplicated string literals).
 */
export const VIOLATION_KIND = {
  whenMutation: "when-mutation",
  numberCollision: "number-collision",
  nonMonotonic: "non-monotonic",
} as const satisfies Record<string, MigrationJournalViolationKind>;

/** A single journal-drift violation against the origin/main baseline. */
export interface MigrationJournalViolation {
  kind: MigrationJournalViolationKind;
  /** The offending migration tag (e.g. "0061_redundant_blue_blade"). */
  tag: string;
  /** Human-readable specifics (values that differ, the colliding on-main tag, etc.). */
  detail: string;
}

/**
 * Parse the leading migration NUMBER (NNNN) from a tag.
 * "0061_redundant_blue_blade" -> "0061"; "meta" -> null.
 */
export function extractMigrationNumber(tag: string): string | null {
  const m = /^(\d+)/.exec(tag);
  return m ? (m[1] as string) : null;
}

/**
 * Detect journal drift of the staged/HEAD journal against the origin/main
 * baseline. Pure function — accepts pre-read entries so unit tests can inject
 * synthetic input without touching git or the filesystem.
 *
 * @param baseEntries - journal entries from `origin/main` (the shipped baseline)
 * @param headEntries - journal entries from the staged/working tree (post-commit state)
 * @returns all violations (empty array = clean)
 */
export function detectMigrationJournalViolations(
  baseEntries: readonly JournalEntry[],
  headEntries: readonly JournalEntry[]
): MigrationJournalViolation[] {
  const violations: MigrationJournalViolation[] = [];

  const baseByTag = new Map<string, JournalEntry>(baseEntries.map((e) => [e.tag, e]));
  // number -> the FIRST on-main tag carrying that number (for collision reporting).
  const baseNumberToTag = new Map<string, string>();
  for (const e of baseEntries) {
    const num = extractMigrationNumber(e.tag);
    if (num !== null && !baseNumberToTag.has(num)) baseNumberToTag.set(num, e.tag);
  }
  const maxBaseWhen = baseEntries.reduce(
    (max, e) => (e.when > max ? e.when : max),
    Number.NEGATIVE_INFINITY
  );

  for (const head of headEntries) {
    const base = baseByTag.get(head.tag);
    if (base) {
      // Tag already on origin/main → its `when` is immutable.
      if (base.when !== head.when) {
        violations.push({
          kind: VIOLATION_KIND.whenMutation,
          tag: head.tag,
          detail: `journal 'when' changed from ${base.when} (origin/main) to ${head.when} (staged) for an already-shipped migration`,
        });
      }
      continue;
    }

    // New entry (tag not on origin/main).
    const num = extractMigrationNumber(head.tag);
    if (num !== null) {
      const collidingTag = baseNumberToTag.get(num);
      if (collidingTag !== undefined && collidingTag !== head.tag) {
        violations.push({
          kind: VIOLATION_KIND.numberCollision,
          tag: head.tag,
          detail: `migration number ${num} already exists on origin/main as '${collidingTag}'`,
        });
        // A colliding entry is already a hard block; don't double-report it as
        // non-monotonic (the regenerate fix resolves both).
        continue;
      }
    }

    if (baseEntries.length > 0 && head.when <= maxBaseWhen) {
      violations.push({
        kind: VIOLATION_KIND.nonMonotonic,
        tag: head.tag,
        detail: `journal 'when' ${head.when} is not strictly greater than the max already on origin/main (${maxBaseWhen})`,
      });
    }
  }

  return violations;
}
