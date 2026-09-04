/**
 * Re-init config merge (mt#4866 SC2).
 *
 * `init` returns early when `.minsky/config.yaml` exists and `--overwrite` is not
 * set, so `--overwrite` is the ONLY re-init path. It used to write the freshly
 * generated file unconditionally via `createFileIfNotExists(..., overwrite=true)`,
 * which deleted every top-level key `init` does not itself emit.
 *
 * Measured live 2026-09-04 at `d667c9634`: a scratch config carrying a `rules:`
 * block and an unrelated `someUnrelatedKey: preserve-me` lost BOTH. The loss is
 * general, not `rules:`-specific — which is why this merges by top-level key
 * rather than special-casing `rules:`.
 *
 * The governing RFC ("The rules Minsky ships", Accepted 2026-09-04): *"Handled by
 * making `--overwrite` merge: every top-level key `init` does not emit is
 * preserved, the vendor's keys are refreshed."*
 *
 * **Known limitation, deliberate.** The merge round-trips through the YAML parser,
 * so comments in the existing file are lost. The same limitation already applies
 * to `rules enable|disable` (noted in the RFC as "noted, not fixed here") and SC2
 * scopes comment preservation out. A comment-preserving edit needs a CST-level
 * round-trip (`yaml`'s `parseDocument`), which is a larger change than Phase 0.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Merge a freshly generated project config over an existing one, preserving every
 * top-level key the fresh content does not carry.
 *
 * Merge is TOP-LEVEL ONLY and the fresh value wins outright for any key it
 * defines. It is deliberately not a deep merge: `init` owns whole sections
 * (`tasks`, `persistence`, `logger`, …), and deep-merging them would resurrect
 * stale sub-keys the vendor deliberately stopped emitting — exactly what mt#4699
 * removed when it dropped `tasks.strictIds` and the `mcp:` block.
 *
 * A key `init` emits only CONDITIONALLY (`repository`, `project`) is preserved
 * from the existing file when this run does not produce it. "Preserve what is not
 * emitted" is evaluated against THIS run's output, so a re-init in a directory
 * whose git remote has gone away does not silently drop the recorded repository.
 *
 * @param existingYaml the current file's contents, or `null` when there is none
 * @param freshYaml    the newly generated config (from `getMinskyConfigContentYaml`)
 */
export function mergeProjectConfigYaml(existingYaml: string | null, freshYaml: string): string {
  if (existingYaml === null) return freshYaml;

  let existing: unknown;
  try {
    existing = parseYaml(existingYaml);
  } catch {
    // An unparseable existing config cannot be merged into safely: we would have
    // to guess which bytes were keys. Overwriting with a valid config is the
    // recoverable outcome, and matches the pre-mt#4866 behaviour for this case.
    // intentional-swallow: the parse error carries no information the caller can
    // act on; the fallback is total and deliberate.
    return freshYaml;
  }

  // A YAML document that is empty, or is a scalar/sequence rather than a mapping,
  // has no top-level keys to preserve.
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    return freshYaml;
  }

  const fresh = parseYaml(freshYaml) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...(existing as Record<string, unknown>) };

  for (const [key, value] of Object.entries(fresh)) {
    merged[key] = value;
  }

  return stringifyYaml(merged);
}

/**
 * The top-level keys that were preserved from `existingYaml` — i.e. present in the
 * existing config and absent from the fresh one. Exposed so `init` can report what
 * it kept rather than merging silently.
 */
export function preservedTopLevelKeys(existingYaml: string | null, freshYaml: string): string[] {
  if (existingYaml === null) return [];

  let existing: unknown;
  try {
    existing = parseYaml(existingYaml);
  } catch {
    // intentional-swallow: mirrors mergeProjectConfigYaml's fallback — an
    // unparseable file preserves nothing, so the honest answer is the empty list.
    return [];
  }
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) return [];

  const fresh = parseYaml(freshYaml) as Record<string, unknown>;
  const freshKeys = new Set(Object.keys(fresh ?? {}));
  return Object.keys(existing as Record<string, unknown>).filter((k) => !freshKeys.has(k));
}
