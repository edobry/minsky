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

/**
 * Read the selection block from `.minsky/config.yaml`.
 *
 * An unreadable or unparseable file yields the empty selection rather than
 * throwing. That is deliberate and matches the pre-existing reader in
 * `config-operations.ts`: the overwhelmingly common cause is "the project has
 * no config yet", and a compile that refuses to run because a project has not
 * been initialized is worse than one that emits its full corpus.
 */
export async function readRuleSelectionConfig(
  workspacePath: string,
  fs: SelectionConfigFsDeps
): Promise<RuleSelectionConfig> {
  let raw: Record<string, unknown> = {};
  try {
    const content = String(await fs.readFile(projectConfigPath(workspacePath), "utf8"));
    raw = (parseYaml(content) as Record<string, unknown> | null) ?? {};
  } catch {
    // intentional-swallow: no config, or an unparseable one, is the
    // no-selection case. See the docblock.
    return { presets: [], enabled: [], disabled: [] };
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
    config.rung !== undefined
  );
}
