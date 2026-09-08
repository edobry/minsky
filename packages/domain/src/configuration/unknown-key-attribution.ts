/**
 * Attribution for unrecognized top-level configuration keys (mt#5033).
 *
 * `warnUnknownTopLevelKeys` (mt#2161) told the operator WHICH key was
 * unrecognized and then guessed at the remedy: "fix the key name in your config
 * file." That guess is wrong for the most common cause. `envVarToConfigPath`
 * (`sources/environment.ts`) maps ANY unregistered `MINSKY_*` variable through a
 * default branch, so a typo'd, stale, or invented variable manufactures a config
 * key that no file contains — and the reader is sent to search files that are
 * correct.
 *
 * Measured cost (mt#5033): `MINSKY_CONFIG_DIR`, a variable this repo has no
 * reader for, was set by a test harness building onboarding sandboxes. The
 * resulting warning was read as a product defect on the onboarding path and
 * propagated as settled fact through four artifacts before anyone re-ran the
 * command without it. `sources/environment.ts` records the same shape for
 * `MINSKY_SKIP_*` → `skip`, noting it "makes the documented escape hatch noisy
 * enough to look broken."
 *
 * Nothing new is plumbed to fix this: every configuration source already reports
 * enough to attribute a key. The environment source publishes
 * `metadata.mappings` (env var → config dot-path); the project and user sources
 * publish `metadata.configFile` (the file actually loaded). This module reads
 * those and renders a message that names the real origin.
 *
 * Kept out of `loader.ts` deliberately — that file is already past the 400-line
 * warn threshold, and a pure formatter is testable without touching the logger.
 */

/**
 * The subset of a configuration source's load result this attribution needs.
 *
 * Deliberately structural rather than an import of `ConfigurationSourceResult`
 * from `loader.ts`: the loader imports THIS module, so depending on its types
 * would close an import cycle. `ConfigurationSourceResult` satisfies this shape
 * structurally.
 */
export interface AttributableSourceResult {
  readonly source: { readonly name: string };
  readonly config: unknown;
  readonly metadata: Record<string, unknown>;
  readonly success: boolean;
}

/** Where an unrecognized key came from, as far as the source metadata can say. */
export type UnknownKeyOrigin =
  | { readonly kind: "environment"; readonly sourceName: string; readonly envVars: string[] }
  | { readonly kind: "file"; readonly sourceName: string; readonly filePath: string }
  | { readonly kind: "unattributed"; readonly sourceName: string };

/**
 * The first dot-separated segment of a config path — the top-level key it writes.
 *
 * `config.dir` → `config`; a path with no dot is already top-level.
 */
function topLevelSegment(configPath: string): string {
  const dot = configPath.indexOf(".");
  return dot === -1 ? configPath : configPath.slice(0, dot);
}

/**
 * Environment variables from this source's `mappings` whose config path writes
 * `key` at the top level. Sorted so the message is stable across runs
 * (`process.env` enumeration order is not guaranteed).
 */
function envVarsWritingKey(key: string, metadata: Record<string, unknown>): string[] {
  const mappings = metadata.mappings;
  if (typeof mappings !== "object" || mappings === null) return [];

  const matches: string[] = [];
  for (const [envVar, configPath] of Object.entries(mappings as Record<string, unknown>)) {
    if (typeof configPath !== "string") continue;
    if (topLevelSegment(configPath) === key) matches.push(envVar);
  }
  return matches.sort();
}

/** The config file this source actually loaded, when it names one. */
function configFileOf(metadata: Record<string, unknown>): string | undefined {
  const configFile = metadata.configFile;
  return typeof configFile === "string" && configFile.length > 0 ? configFile : undefined;
}

/**
 * Whether this source's own config object carries `key` at the top level.
 *
 * `hasOwnProperty` rather than `in` so an inherited prototype member cannot
 * attribute a key to a source that never set it.
 */
function contributesKey(config: unknown, key: string): boolean {
  return (
    typeof config === "object" &&
    config !== null &&
    Object.prototype.hasOwnProperty.call(config, key)
  );
}

/**
 * Every source that contributed `key`, in load order.
 *
 * More than one can: an env var and a config file may write the same
 * unrecognized top-level key, and the operator needs to fix both.
 */
export function attributeUnknownTopLevelKey(
  key: string,
  sourceResults: readonly AttributableSourceResult[]
): UnknownKeyOrigin[] {
  const origins: UnknownKeyOrigin[] = [];

  for (const result of sourceResults) {
    if (!result.success) continue;
    if (!contributesKey(result.config, key)) continue;

    const sourceName = result.source.name;
    const envVars = envVarsWritingKey(key, result.metadata);
    if (envVars.length > 0) {
      origins.push({ kind: "environment", sourceName, envVars });
      continue;
    }

    const filePath = configFileOf(result.metadata);
    if (filePath) {
      origins.push({ kind: "file", sourceName, filePath });
      continue;
    }

    origins.push({ kind: "unattributed", sourceName });
  }

  return origins;
}

function describeOrigin(origin: UnknownKeyOrigin): string {
  switch (origin.kind) {
    case "environment": {
      const label = origin.envVars.length === 1 ? "variable" : "variables";
      return (
        `It came from the environment ${label} ${origin.envVars.join(", ")} — Minsky maps ` +
        `any unrecognized MINSKY_* variable to a config path, so this is usually a stale or ` +
        `misspelled variable rather than anything wrong with your configuration files. Unset ` +
        `it, or correct the spelling.`
      );
    }
    case "file":
      return (
        `It came from ${origin.filePath} — fix the key name there, or remove it. If the key ` +
        `was added by a newer Minsky version, update your installation.`
      );
    case "unattributed":
      return `It came from the ${origin.sourceName} configuration source.`;
  }
}

/**
 * The operator-facing warning for one unrecognized top-level key.
 *
 * Pure: the loader logs the returned string. Keeping the rendering separate from
 * the emission is what lets the tests assert the message without patching the
 * logger.
 */
export function formatUnknownTopLevelKeyWarning(
  key: string,
  origins: readonly UnknownKeyOrigin[]
): string {
  const head = `Unrecognized top-level config key: ${key}. It will be ignored.`;

  if (origins.length === 0) {
    return (
      `${head} Its source could not be determined. If it is a typo in a config file, fix the ` +
      `key name there; if it came from a MINSKY_* environment variable, unset that variable.`
    );
  }

  return `${head} ${origins.map(describeOrigin).join(" ")}`;
}
