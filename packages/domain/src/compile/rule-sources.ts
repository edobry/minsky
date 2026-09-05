/**
 * Flat-`.mdc` + `<name>/rule.ts` rule source reader for the new `compile` pipeline.
 *
 * Phase 2 of the compile-pipeline convergence (mt#2994 / ADR-016). The legacy
 * `rules compile` pipeline reads flat `.minsky/rules/*.mdc` rule sources; the new
 * `compile` pipeline previously read ONLY per-directory `.minsky/rules/<name>/rule.ts`
 * sources (see `targets/cursor-rules-ts.ts`). This module lets the new pipeline
 * discover and parse BOTH forms into validated `RuleDefinition`s — mirroring the
 * mt#2279 hybrid `SKILL.md` reader for skills (`targets/claude-skills.ts`:
 * `discoverSkillSources` / `extractSkillDefinitionFromMd`).
 *
 * Scope (mt#2994 — READER only). Wiring the flat-`.mdc`-sourced rules into the
 * `.cursor/rules/` EMITTER — and reconciling byte-parity with the legacy writer,
 * then removing it — is Phase 3 (mt#2995, "dedup the two `.cursor/rules/`
 * writers"): the legacy `.cursor/rules/` output reserializes frontmatter
 * (`jsYaml.dump`, name-first) and differs from the flat source for 47/54 rules,
 * so matching it byte-for-byte is emitter work, not reader work. The monolithic
 * CLAUDE.md/AGENTS.md assembler (Phase 1, mt#2992) also consumes this reader.
 * In Phase 2, `discoverRuleSources` is wired into `cursor-rules-ts` (its
 * production caller); `extractRuleDefinitionFromMdc` is unit-tested here and
 * consumed by Phases 1 and 3.
 */

import { join } from "path";
import matter from "gray-matter";
import { ruleDefinitionSchema } from "../definitions/schemas";
import type { RuleDefinition } from "../definitions/types";
import {
  deriveRulePresets,
  explainRuleSelection,
  type RuleTierInfo,
} from "../rules/rule-selection";
import {
  isSelectionConfigured,
  readRuleSelectionConfig,
  type RuleSelectionConfig,
} from "../rules/selection-resolution";
import type { MinskyCompileFsDeps } from "./types";

/** File name of a TypeScript rule source inside a `.minsky/rules/<name>/` dir. */
export const RULE_TS_SOURCE = "rule.ts";

const MDC_EXT = ".mdc";

/**
 * A discovered rule source. `name` is the rule id — the `<name>/` directory name
 * for a TS source, or the `<name>.mdc` basename for a markdown source.
 *
 * `kind: "both"` marks an ambiguous canonical source (a `<name>/rule.ts` AND a
 * flat `<name>.mdc` exist for the same name). Consumers skip+warn on it rather
 * than silently preferring one format (mirrors mt#2279's ambiguous-skill handling).
 */
export type RuleSource =
  | { kind: "ts"; name: string; path: string }
  | { kind: "mdc"; name: string; path: string }
  | { kind: "both"; name: string; tsPath: string; mdcPath: string };

/** Source directory where rules are authored: `.minsky/rules/`. */
export function ruleSourceDir(workspacePath: string): string {
  return join(workspacePath, ".minsky", "rules");
}

/** Absolute path to a `<name>/rule.ts` TS rule source. */
export function ruleTsPath(workspacePath: string, name: string): string {
  return join(ruleSourceDir(workspacePath), name, RULE_TS_SOURCE);
}

/** Absolute path to a flat `<name>.mdc` markdown rule source. */
export function ruleMdcPath(workspacePath: string, name: string): string {
  return join(ruleSourceDir(workspacePath), `${name}${MDC_EXT}`);
}

async function fileExists(fs: MinskyCompileFsDeps, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** gray-matter yields a scalar for a single-item YAML value; normalize to array. */
function normalizeToStringArray(value: unknown): unknown {
  return typeof value === "string" ? [value] : value;
}

/**
 * Discover rule sources under `.minsky/rules/`. Two forms are recognized:
 *  - a flat `<name>.mdc` file   → `{ kind: "mdc" }`
 *  - a `<name>/rule.ts` module  → `{ kind: "ts" }`
 * When BOTH exist for the same `<name>`, the source is `{ kind: "both" }` (an
 * ambiguous canonical source — consumers skip+warn, per mt#2279).
 *
 * Returns sources sorted by name for deterministic output. A missing/unreadable
 * `.minsky/rules/` directory yields `[]` (not an error) — mirrors the skills reader.
 */
export async function discoverRuleSources(
  workspacePath: string,
  fs: MinskyCompileFsDeps
): Promise<RuleSource[]> {
  const sources = await discoverRuleSourcesUnfiltered(workspacePath, fs);
  return (await applyRuleSelection(sources, workspacePath, fs)).sources;
}

/**
 * Discovery WITHOUT the selection filter (mt#573 SC5).
 *
 * `discoverRuleSources` above is what every compile target calls and is
 * correctly filtered. This is for the one caller that needs to know what the
 * filter DID: `compile`'s selection report has to resolve the selection against
 * the project's full corpus, and running it against an already-filtered set
 * would compare the selection to its own output — every deselected rule would
 * look like an id the project does not have, and the report would name them all
 * as errors.
 */
export async function discoverRuleSourcesUnfiltered(
  workspacePath: string,
  fs: MinskyCompileFsDeps
): Promise<RuleSource[]> {
  const sourceDir = ruleSourceDir(workspacePath);
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return [];
  }

  const mdcNames = new Set<string>();
  const tsNames = new Set<string>();

  for (const entry of entries) {
    if (entry.endsWith(MDC_EXT)) {
      mdcNames.add(entry.slice(0, -MDC_EXT.length));
      continue;
    }
    // A non-`.mdc` entry is a candidate rule dir iff it contains a `rule.ts`.
    if (await fileExists(fs, join(sourceDir, entry, RULE_TS_SOURCE))) {
      tsNames.add(entry);
    }
  }

  const allNames = [...new Set<string>([...mdcNames, ...tsNames])].sort();
  const sources: RuleSource[] = [];
  for (const name of allNames) {
    const hasTs = tsNames.has(name);
    const hasMdc = mdcNames.has(name);
    if (hasTs && hasMdc) {
      sources.push({
        kind: "both",
        name,
        tsPath: ruleTsPath(workspacePath, name),
        mdcPath: ruleMdcPath(workspacePath, name),
      });
    } else if (hasTs) {
      sources.push({ kind: "ts", name, path: ruleTsPath(workspacePath, name) });
    } else {
      sources.push({ kind: "mdc", name, path: ruleMdcPath(workspacePath, name) });
    }
  }
  return sources;
}

/**
 * What a selection pass did, for a caller that wants to report it (SC5).
 *
 * `deselected` and the two unresolved lists are what `compile` surfaces so a
 * selection that names a rule the project does not have is REPORTED rather than
 * skipped silently — the pre-fix behaviour of the whole selection layer, which
 * accepted any id and changed nothing.
 */
export interface RuleSelectionOutcome {
  readonly sources: RuleSource[];
  readonly deselected: string[];
  readonly unresolvedIds: string[];
  /** Preset NAMES that resolve to no bundle — a different remedy from an id. */
  readonly unresolvedPresets: string[];
  readonly refusedDisables: string[];
  /** Set when the project's config exists and could not be read or parsed. */
  readonly parseError?: string;
  /** False when the project expressed no selection and nothing was filtered. */
  readonly applied: boolean;
}

/**
 * Read the source's tier metadata, for selection.
 *
 * A `ts` source is reported UNTIERED rather than imported. Discovery is
 * filesystem-only by construction — importing every `rule.ts` here would give
 * this function the dynamic-import surface (and the failure modes) that the
 * targets deliberately own — and the practical cost is nil: there are zero
 * `rule.ts` sources in existence (ADR-016 §Rule-source ambiguity policy records
 * the same fact). Untiered defaults ON, so a TS rule is never silently dropped;
 * it simply cannot be reached by a tier-derived preset until it has a reader.
 */
async function readTierInfo(
  source: RuleSource,
  fs: MinskyCompileFsDeps
): Promise<RuleTierInfo | undefined> {
  if (source.kind !== "mdc") return { id: source.name };
  let raw: string;
  try {
    raw = await fs.readFile(source.path, "utf-8");
  } catch {
    // intentional-swallow: an unreadable source is the targets' problem to
    // report (they skip+warn per mt#2182); selection must not fail the compile
    // over it, and untiered-defaults-on keeps the rule in the set either way.
    return { id: source.name };
  }
  const extracted = extractRuleDefinitionFromMdc(raw, source.path);
  if ("error" in extracted) return { id: source.name };
  return {
    id: source.name,
    tier: extracted.rule.tier,
    minimumRung: extracted.rule.minimumRung,
  };
}

/**
 * Filter discovered sources down to the project's active selection (SC2).
 *
 * Applied INSIDE `discoverRuleSources` so that every compile target honours it
 * with no change of their own: `cursor-rules-ts` consumes this reader directly,
 * and `claude-md` / `claude-rules` / `agents-md` reach it through
 * `targets/rule-loader.ts`. Filtering in the targets instead would put the same
 * decision in four places, and `listOutputFiles` and `compile` within one target
 * would have to be kept in agreement by hand — a disagreement there makes
 * `--check` report a file as an orphan on one run and expected on the next.
 *
 * Exported so a caller that needs the REPORT (`compile`, per SC5) can have it;
 * `discoverRuleSources` keeps its `RuleSource[]` return so no existing caller
 * changes.
 *
 * The no-selection short-circuit is the common path and skips every frontmatter
 * read — see `rules/selection-resolution.ts` for why that matters.
 */
export async function applyRuleSelection(
  sources: RuleSource[],
  workspacePath: string,
  fs: MinskyCompileFsDeps,
  configOverride?: RuleSelectionConfig
): Promise<RuleSelectionOutcome> {
  const config = configOverride ?? (await readRuleSelectionConfig(workspacePath, fs));
  if (!isSelectionConfigured(config)) {
    return {
      sources,
      deselected: [],
      unresolvedIds: [],
      unresolvedPresets: [],
      refusedDisables: [],
      applied: false,
    };
  }

  const tiers: RuleTierInfo[] = [];
  for (const source of sources) {
    const info = await readTierInfo(source, fs);
    if (info) tiers.push(info);
  }

  const ids = sources.map((s) => s.name);
  const presets = deriveRulePresets(tiers, ids, config.rung);
  const { active, unresolvedIds, unresolvedPresets, refusedDisables } = explainRuleSelection(
    ids,
    config,
    { tiers, presets }
  );

  return {
    sources: sources.filter((s) => active.has(s.name)),
    deselected: ids.filter((id) => !active.has(id)),
    unresolvedIds,
    unresolvedPresets,
    refusedDisables,
    parseError: config.parseError,
    applied: true,
  };
}

/**
 * Parse + validate a rule definition from a flat markdown source (`<name>.mdc`).
 *
 * The YAML frontmatter carries metadata (`description`, `globs`, `alwaysApply`,
 * `tags`, and an optional `name`); the markdown body is the rule content. Maps
 * frontmatter → `RuleDefinition` and validates via `ruleDefinitionSchema` — the
 * SAME schema the TypeScript (`rule.ts`) path uses — so both formats produce
 * identical, validated output.
 *
 * `name` is taken ONLY from the frontmatter (left undefined when absent) — the
 * rule's identity/output-filename comes from the discovered source name
 * (`RuleSource.name`), NOT from a `name` field. This mirrors the legacy writer,
 * which emits a `name:` line only when the source frontmatter carried one (21 of
 * 54 current rules have no `name:`); defaulting it here would add a spurious
 * `name:` line to those files and break `.cursor/rules/` byte-parity.
 *
 * Returns `{ error }` (never throws) on unparseable frontmatter or a
 * schema-invalid definition, so callers skip+warn rather than crash.
 */
export function extractRuleDefinitionFromMdc(
  raw: string,
  sourcePath: string
): { rule: RuleDefinition } | { error: string } {
  let fm: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(raw);
    fm = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { error: `Failed to parse markdown frontmatter at ${sourcePath}: ${reason}` };
  }

  // Map frontmatter → RuleDefinition. Omit undefined keys so schema defaults
  // apply predictably; then reconcile to the legacy RuleService parse (below).
  // `content` is trimmed to match `RuleService` (`content: ruleContent.trim()`),
  // which is what the legacy `.cursor/rules/` output was serialized from —
  // keeping the unified writer byte-identical. (The trimmed trailing newline is
  // the mt#1288/mt#1620 behavior, fixed separately on this unified writer.)
  const candidate: Record<string, unknown> = { content: body.trim() };
  if (fm["name"] !== undefined) candidate["name"] = fm["name"];
  if (fm["description"] !== undefined) candidate["description"] = fm["description"];
  if (fm["globs"] !== undefined) candidate["globs"] = fm["globs"];
  if (fm["alwaysApply"] !== undefined) candidate["alwaysApply"] = fm["alwaysApply"];
  if (fm["tags"] !== undefined) candidate["tags"] = normalizeToStringArray(fm["tags"]);
  // mt#4974 SC1 — plane/tier/rung + the on-demand marker.
  //
  // This block is an ALLOW-LIST, not a spread: a frontmatter key absent from it
  // is dropped at parse, which is why the plane split needed a code change here
  // rather than only a frontmatter convention. Adding a key to a rule's `.mdc`
  // is not enough; it has to be named here too.
  //
  // These do NOT reach `.cursor/rules/*.mdc` (SC2): `buildRuleMdc`
  // (`targets/cursor-rules-ts.ts`) builds its frontmatter from its own
  // five-key allow-list, so the byte-parity contract holds by construction
  // rather than by a filter anyone has to remember. `rule-sources.test.ts`
  // asserts that rather than leaving it to inspection.
  if (fm["plane"] !== undefined) candidate["plane"] = fm["plane"];
  if (fm["tier"] !== undefined) candidate["tier"] = fm["tier"];
  if (fm["minimumRung"] !== undefined) candidate["minimumRung"] = fm["minimumRung"];
  if (fm["onDemand"] !== undefined) candidate["onDemand"] = fm["onDemand"];

  const parsed = ruleDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return { error: `Invalid rule markdown source at ${sourcePath}: ${parsed.error.message}` };
  }
  const rule = parsed.data as RuleDefinition;
  // `ruleDefinitionSchema` defaults `alwaysApply` to `false`, but the legacy
  // `RuleService` leaves it undefined when the source omits it (`alwaysApply:
  // data.alwaysApply`, no default), so the legacy writer emitted no
  // `alwaysApply:` line for those rules. Strip the schema default here when
  // the source had none, so this reader matches that legacy RuleService
  // behavior exactly and keeps `.cursor/rules/` byte-for-byte identical.
  // Assumption this relies on: `undefined` and `false` are equivalent to
  // every consumer of `RuleDefinition.alwaysApply` — both mean
  // "not always-applied" — so stripping the value changes no observable
  // behavior, only the serialized output shape.
  if (fm["alwaysApply"] === undefined) {
    delete (rule as { alwaysApply?: boolean }).alwaysApply;
  }
  return { rule };
}
