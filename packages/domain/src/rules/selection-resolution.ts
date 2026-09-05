/**
 * Reading a project's rule selection, for the two readers of `.minsky/rules/`.
 *
 * ## Why this is its own module (mt#573 SC2)
 *
 * Selection has to be applied in two places that share no code path:
 * `discoverRuleSources` (`../compile/rule-sources.ts`, which every compile
 * target passes through) and `RuleService.listRules` (`./rule-service.ts`,
 * which feeds the agent context assembler, the rules embeddings index and
 * `rules list`). The obvious home — `operations/config-operations.ts`, which
 * already reads this config — imports `RuleService` and `loadRuleCorpus`, so
 * importing it FROM either reader would be a cycle. This module holds only the
 * config read and the "is anything selected?" predicate, depends on nothing in
 * the rules domain, and both readers plus `config-operations.ts` consume it.
 *
 * ## The `isSelectionConfigured` short-circuit is load-bearing, not an optimisation
 *
 * Applying selection needs each rule's `tier`, which means parsing frontmatter.
 * Both compile readers already parse every `.mdc` AFTER discovery, so doing it
 * again inside discovery would double the parse for every rule in every target
 * on every compile — paid by every project, to answer a question that is "no
 * filter" for all of them today (Minsky's own `.minsky/config.yaml` has no
 * `rules:` block, and neither does a freshly-initialized project).
 *
 * So the readers ask this predicate first and skip the whole path when nothing
 * is selected. The behaviour is identical either way; what differs is that an
 * unselecting project pays one `readFile` of a small YAML file instead of a
 * full second parse of its corpus.
 */

import { join } from "path";
import { parse as parseYaml } from "yaml";

import type { RuleRung } from "../definitions/types";

/** The filesystem surface this module needs — one read, injectable for tests. */
export interface SelectionConfigFsDeps {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
}

/**
 * A project's rule selection, as committed in `.minsky/config.yaml`.
 *
 * `rung` is the project's adoption rung (mem#340's ladder). Absent means "no
 * rung filter" rather than T0: the canonical ladder doc is still unwritten
 * (RFC `3ce937f0` §Sequencing), so a project that has never declared a rung
 * must not silently lose rules to a rung comparison it never opted into.
 */
export interface RuleSelectionConfig {
  presets: string[];
  enabled: string[];
  disabled: string[];
  rung?: RuleRung;
  /**
   * Set when the config file EXISTS but could not be parsed (PR #3651 R1).
   *
   * "No config yet" and "a YAML typo in the config" both used to produce the
   * same empty selection, so a malformed file silently made selection
   * inoperative — the operator's `disabled` entries would quietly stop being
   * honoured with nothing said. That is the exact class this task exists to
   * remove, reproduced one layer down. Distinguishing them costs one `code`
   * check; the message is threaded into `compile`'s run-level report.
   *
   * Deliberately NOT thrown: a compile that refuses to run because a project's
   * config has a typo is worse than one that emits its full corpus and says
   * why.
   */
  parseError?: string;
}

const RUNG_VALUES: readonly string[] = ["T0", "T1", "T2", "T3", "T4"];

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value.filter((v) => typeof v === "string") as string[]) : [];
}

function asRung(value: unknown): RuleRung | undefined {
  return typeof value === "string" && RUNG_VALUES.includes(value) ? (value as RuleRung) : undefined;
}

/** Path of the project config this reads. Exported so callers can name it in errors. */
export function projectConfigPath(workspacePath: string): string {
  return join(workspacePath, ".minsky", "config.yaml");
}

/** Is this a "no such file" failure, as opposed to a real read/parse problem? */
function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Read the selection block from `.minsky/config.yaml`.
 *
 * Never throws — the empty selection is returned in both failure cases, because
 * a compile that refuses to run because a project has not been initialized is
 * worse than one that emits its full corpus. But the two cases are DISTINGUISHED
 * (PR #3651 R1): a missing file is the ordinary uninitialized project and is
 * silent, while a file that exists and cannot be read or parsed sets
 * `parseError`, which `compile` reports. Folding them together let a YAML typo
 * silently disable every selection the operator had made.
 */
export async function readRuleSelectionConfig(
  workspacePath: string,
  fs: SelectionConfigFsDeps
): Promise<RuleSelectionConfig> {
  const configPath = projectConfigPath(workspacePath);
  const empty = { presets: [], enabled: [], disabled: [] };

  let content: string;
  try {
    content = String(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return empty; // uninitialized project — expected
    return {
      ...empty,
      parseError: `could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let raw: Record<string, unknown> = {};
  try {
    raw = (parseYaml(content) as Record<string, unknown> | null) ?? {};
  } catch (error) {
    return {
      ...empty,
      parseError: `could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const rules = (raw?.rules as Record<string, unknown>) ?? {};
  return {
    presets: asStringArray(rules.presets),
    enabled: asStringArray(rules.enabled),
    disabled: asStringArray(rules.disabled),
    rung: asRung(rules.rung),
  };
}

/**
 * Does this config express any selection at all?
 *
 * False means the reader can return its full corpus without parsing a single
 * frontmatter block — see the module docblock. Note `rung` counts: a project
 * that declares only a rung has still expressed a selection, because a rung
 * filters `minimumRung`-carrying rules out of the base set.
 */
export function isSelectionConfigured(config: RuleSelectionConfig): boolean {
  return (
    config.presets.length > 0 ||
    config.enabled.length > 0 ||
    config.disabled.length > 0 ||
    config.rung !== undefined ||
    // A file that exists and does not parse counts as configured, so the
    // selection pass runs far enough to REPORT it. Treating it as unconfigured
    // would take the silent short-circuit and drop the very message that makes
    // the typo visible.
    config.parseError !== undefined
  );
}
