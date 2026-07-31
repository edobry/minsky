/**
 * Shared "Unknown compile target" message builder (mt#2995 R1 review).
 *
 * The legacy `cursor-rules` target was retired in mt#2995 — `cursor-rules-ts`
 * is now the sole `.cursor/rules/` writer, registered under BOTH the legacy
 * `rules compile` command's target map (`./compile-service.ts`,
 * `../operations/crud-operations.ts`) and the new `compile` command's target
 * map (`../../compile/compile-service.ts`, `../../compile/compile.ts`) — a
 * user who still types `--target cursor-rules` on EITHER command gets a
 * generic "Unknown compile target" error with no indication of what replaced
 * it. This module is the single source of truth for that migration hint, so
 * all four throw sites emit identical, consistent text.
 *
 * Location note: this file lives under the legacy `rules/compile/` directory
 * (not the new `compile/`) to match the existing cross-directory import
 * precedent — `compile/targets/cursor-rules-ts.ts` already imports
 * `GENERATED_BANNER` from `../../rules/compile/banner-constants` — so the new
 * system importing this hint from here follows the same established
 * direction rather than introducing a new one.
 */

/** The specific migration hint appended when the retired target id is requested. */
export const RETIRED_CURSOR_RULES_TARGET_HINT =
  'The "cursor-rules" target was retired in mt#2995; the new sole .cursor/rules ' +
  'writer is "cursor-rules-ts" — run `minsky compile --target cursor-rules-ts`.';

/**
 * Build the "Unknown compile target" error message, appending the retired-
 * `cursor-rules` migration hint when `targetId` is exactly `"cursor-rules"`.
 * `availableTargets`, when provided, is rendered the same way both existing
 * call sites already render it (comma-joined); omit it for call sites that
 * don't have a target list handy.
 */
export function unknownCompileTargetMessage(targetId: string, availableTargets?: string[]): string {
  const base =
    availableTargets !== undefined
      ? `Unknown compile target: "${targetId}". Available targets: ${availableTargets.join(", ")}`
      : `Unknown compile target: "${targetId}"`;
  return targetId === "cursor-rules" ? `${base} ${RETIRED_CURSOR_RULES_TARGET_HINT}` : base;
}
