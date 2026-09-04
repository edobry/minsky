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
 * **This module FAILS CLOSED on a config it cannot read (PR #3623 R1).** The first
 * implementation fell back to the fresh content when the existing file would not
 * parse, on the reasoning that "overwriting with a valid config is recoverable and
 * matches the pre-mt#4866 behaviour". Both halves of that were wrong for this task:
 * pre-mt#4866 behaviour is precisely the data loss SC2 exists to stop, and the
 * fallback is unrecoverable for the user's keys, which are gone. Worse, it was
 * SILENT — no warning at all on that path — so a `--overwrite` in CI would destroy
 * a hand-edited config and report success. SC2 says every unowned key is preserved;
 * when the file cannot be read there is no way to honour that, so refusing is the
 * only faithful outcome. The caller is told which file to repair or remove.
 *
 * **Known limitation, deliberate.** A successful merge round-trips through the YAML
 * parser, so it is byte-identical for input in the serializer's canonical block
 * form — what `init` and `rules enable|disable` themselves write — but normalizes
 * flow style and drops comments in hand-authored input. SC2 scopes comment
 * preservation out, and the RFC records it as "noted, not fixed here". Byte-exact
 * preservation needs a CST-level round-trip (`yaml`'s `parseDocument`), which is
 * deliberately not taken here: it would preserve comments in `init`'s merge while
 * `rules enable|disable` strip them on the very next command. RFC Phase 2 (mt#573)
 * owns doing both together.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Thrown when an existing `.minsky/config.yaml` is present but cannot be parsed,
 * so its top-level keys cannot be preserved across a `--overwrite` re-init.
 *
 * A distinct class rather than a bare `Error` so `init` can tell "this config is
 * unusable" apart from any other failure and render its own guidance.
 */
export class UnmergeableConfigError extends Error {
  constructor(
    readonly configPath: string,
    readonly cause?: unknown
  ) {
    super(
      `Cannot merge into the existing config at ${configPath}: it is not valid YAML, ` +
        `so the keys \`minsky init\` does not own cannot be preserved. Refusing to ` +
        `overwrite — that would silently discard them.\n\n` +
        `Repair the file, or move it aside and re-run \`minsky init --overwrite\` to ` +
        `generate a fresh one.`
    );
    this.name = "UnmergeableConfigError";
  }
}

export interface ConfigMergeResult {
  /** The YAML to write. */
  merged: string;
  /**
   * Top-level keys carried over from the existing config — present there and
   * absent from the freshly generated content. Exposed so `init` can report what
   * it kept rather than merging silently.
   */
  preservedKeys: string[];
}

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
 * @param configPath   used only to name the file in {@link UnmergeableConfigError}
 * @throws {UnmergeableConfigError} when `existingYaml` is present but unparseable
 */
export function mergeProjectConfigYaml(
  existingYaml: string | null,
  freshYaml: string,
  configPath = ".minsky/config.yaml"
): ConfigMergeResult {
  if (existingYaml === null) return { merged: freshYaml, preservedKeys: [] };

  let existing: unknown;
  try {
    existing = parseYaml(existingYaml);
  } catch (error) {
    // Fail closed — see the module docblock. Silently replacing an unparseable
    // config is the exact data loss this task exists to stop.
    throw new UnmergeableConfigError(configPath, error);
  }

  // An empty document, or a scalar/sequence rather than a mapping, PARSES fine and
  // simply has no top-level keys to preserve. That is not the failure above: there
  // is nothing to lose, so writing the fresh content is correct and silent.
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    return { merged: freshYaml, preservedKeys: [] };
  }

  const existingMap = existing as Record<string, unknown>;
  const fresh = (parseYaml(freshYaml) ?? {}) as Record<string, unknown>;
  const freshKeys = new Set(Object.keys(fresh));

  const merged: Record<string, unknown> = { ...existingMap };
  for (const [key, value] of Object.entries(fresh)) {
    merged[key] = value;
  }

  return {
    merged: stringifyYaml(merged),
    preservedKeys: Object.keys(existingMap).filter((k) => !freshKeys.has(k)),
  };
}
