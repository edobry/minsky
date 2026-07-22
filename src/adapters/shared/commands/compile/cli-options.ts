/**
 * Shared option helpers for the `compile` command's two independent entry
 * points — this directory's `compile-commands.ts` (the shared-registry
 * surface that drives the MCP tool) and `src/commands/compile/index.ts`
 * (the direct Commander.js CLI surface; see that file's module doc for why
 * two registrations exist). Both surfaces need the SAME `memory.loadingMode`
 * config read and the SAME size-budget-override object construction; this
 * module is the single place that logic lives so the two entry points can't
 * drift (mt#2992 review R1, non-blocking finding 1).
 */

import type { MemoryLoadingMode } from "@minsky/domain/configuration/schemas/memory";

/**
 * Read `memory.loadingMode` from config. Returns `undefined` (the
 * `claude.md` target's own default, `"on_demand"`, then applies) when
 * config is not yet initialized or unavailable — mirrors the identical
 * try/catch both compile entry points previously duplicated inline. Only
 * the `claude.md` target reads this value.
 */
export async function resolveMemoryLoadingMode(): Promise<MemoryLoadingMode | undefined> {
  try {
    const { getConfigurationProvider } = await import("@minsky/domain/configuration/index");
    const config = getConfigurationProvider().getConfig();
    return config.memory?.loadingMode;
  } catch {
    return undefined;
  }
}

/**
 * Validate a RAW CLI option value (string, number, or `undefined` —
 * whatever Commander.js hands back for `--warn-chars <n>` / `--fail-chars
 * <n>`) as a positive-integer character count, matching the shared-registry
 * param schema exactly (`z.number().int().positive().optional()` — see
 * `src/adapters/shared/commands/rules/rules-parameters.ts:210-218` for the
 * established precedent this mirrors). Returns `undefined` only when the
 * flag was not supplied at all. Throws a clear, flag-named `Error` on ANY
 * invalid value — never silently coerces or clamps a bad value into
 * "the default fires anyway."
 *
 * **The failure mode this guards against (mt#2992 review R1, BLOCKING):**
 * a bare `Number(opts.warnChars)` on an unvalidated CLI string turns a typo
 * like `--warn-chars abc` into `NaN`. `NaN !== undefined`, so it survives
 * into the size-budget override object, and `resolveSizeBudget` merges via
 * `override?.warnChars ?? defaultBudget.warnChars` — `??` only falls
 * through on `null`/`undefined`, so `NaN` WINS over the real default. Every
 * subsequent `size > threshold` comparison against `NaN` is `false`, so the
 * size-budget check silently never fires — a user typo disables the guard
 * with no error at all. This function's whole job is making that failure
 * mode impossible: reject before the value ever reaches `resolveSizeBudget`.
 */
export function parseCliSizeBudgetChars(flagLabel: string, rawValue: unknown): number | undefined {
  if (rawValue === undefined) return undefined;
  const parsed = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${flagLabel} value ${JSON.stringify(rawValue)}: must be a positive integer (character count).`
    );
  }
  return parsed;
}

/**
 * Build the size-budget override object with ONLY the fields actually
 * supplied — never `{ warnChars: undefined, failChars: undefined }` (an
 * absent field must fall back to the target default inside
 * `resolveSizeBudget`, not be forced into the override object as an
 * explicit `undefined`). Shared by both compile entry points; callers pass
 * already-validated numbers — the shared-registry side via its zod schema
 * (enforced at the parameter-parsing boundary, `schema-bridge.ts`'s
 * `parseOptionsToParameters` / the MCP tool-call validator), the direct-CLI
 * side via `parseCliSizeBudgetChars` above.
 */
export function buildSizeBudgetOverride(
  warnChars: number | undefined,
  failChars: number | undefined
): { warnChars?: number; failChars?: number } | undefined {
  const override: { warnChars?: number; failChars?: number } = {};
  if (warnChars !== undefined) override.warnChars = warnChars;
  if (failChars !== undefined) override.failChars = failChars;
  return Object.keys(override).length > 0 ? override : undefined;
}
