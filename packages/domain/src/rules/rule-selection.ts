/**
 * Rule Selection
 *
 * Resolves which rules are active for a project, and derives the preset
 * bundles a project can offer, from the tier metadata each rule carries.
 */

import type { RuleRung, RuleTier } from "../definitions/types";
import type { RuleSelectionConfig } from "./selection-resolution";

/**
 * What the resolver needs to know about one rule. A rule that carries no
 * `tier` is UNTIERED, which is a real and common state — the 54 rules this
 * repository authored before the plane split carry none, and so does every
 * rule a user writes themselves.
 */
export interface RuleTierInfo {
  readonly id: string;
  readonly tier?: RuleTier;
  readonly minimumRung?: RuleRung;
}

/** Ladder order (mem#340). Index comparison only — never expose the numbers. */
const RUNG_ORDER: readonly RuleRung[] = ["T0", "T1", "T2", "T3", "T4"];

/**
 * Is this rule proposed at the project's rung?
 *
 * Absent project rung means NO rung filter, not T0 — see
 * `RuleSelectionConfig.rung`. Absent `minimumRung` on the rule means it applies
 * at every rung.
 */
function rungAllows(minimumRung: RuleRung | undefined, projectRung: RuleRung | undefined): boolean {
  if (projectRung === undefined || minimumRung === undefined) return true;
  return RUNG_ORDER.indexOf(projectRung) >= RUNG_ORDER.indexOf(minimumRung);
}

/**
 * Is a rule of this tier ON by default?
 *
 * `base` and `opinionated` are both on; `style` is off and opt-in (ask#11286).
 * **Untiered is ON**, and that is the load-bearing case rather than a fallback:
 * every rule in this repository and every rule a user authors is untiered, so
 * treating absence as "off" would empty the corpus of a project that never
 * adopted tiers at all.
 */
function defaultsOn(tier: RuleTier | undefined): boolean {
  return tier !== "style";
}

/** Index a tier list by rule id, for O(1) lookup during resolution. */
function indexTiers(tiers: readonly RuleTierInfo[]): Map<string, RuleTierInfo> {
  return new Map(tiers.map((t) => [t.id, t]));
}

/**
 * Derive the preset bundles this project can offer (mt#573 SC1).
 *
 * One preset per tier, named for the tier, computed from the SHIPPED corpus's
 * metadata and intersected with the ids the project actually has. Both halves
 * matter and they answer different questions: the corpus knows what a tier
 * MEANS (the project's own rules are untiered and would derive nothing), and
 * the intersection is what makes `rules presets` list only rules the project
 * can receive.
 *
 * This replaces a hand-typed `Record<string, string[]>` of six bundles naming
 * 22 ids, of which 13 existed only in Minsky's own repository and 3 existed
 * nowhere. A hand-typed table has no way to notice that a rule it names was
 * renamed or retired; a derivation cannot name a rule the corpus does not have.
 *
 * A preset may legitimately be EMPTY — today `opinionated` is, in a freshly
 * initialized project, because `init` scaffolds only the `base` tier until the
 * selection surface (Phase 3, mt#4872) can ask the user about the rest. Empty
 * is the honest answer and is what SC5's resolvability test asserts against;
 * the pre-fix behaviour was six presets naming ids that were simply absent.
 */
export function deriveRulePresets(
  corpusTiers: readonly RuleTierInfo[],
  projectRuleIds: Iterable<string>,
  projectRung?: RuleRung
): Record<string, string[]> {
  const present = new Set(projectRuleIds);
  const presets: Record<string, string[]> = {};

  for (const info of corpusTiers) {
    if (info.tier === undefined) continue; // untiered rules belong to no preset
    if (!rungAllows(info.minimumRung, projectRung)) continue;
    if (!present.has(info.id)) continue;
    (presets[info.tier] ??= []).push(info.id);
  }

  // Every tier gets a key even when it resolves to nothing, so `rules presets`
  // can say "opinionated: 0 rules" rather than omitting the bundle entirely —
  // an absent bundle reads as "no such tier", which is a different fact.
  for (const tier of ["base", "opinionated", "style"] satisfies RuleTier[]) {
    presets[tier] ??= [];
  }

  for (const ids of Object.values(presets)) ids.sort();
  return presets;
}

/** Options carrying the metadata the resolver needs beyond the raw id list. */
export interface ResolveActiveRulesOptions {
  /** Tier metadata per rule. Omitted → every rule is untiered → all default on. */
  readonly tiers?: readonly RuleTierInfo[];
  /** Preset name → member ids, from {@link deriveRulePresets}. */
  readonly presets?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Resolve which rules are active for a project.
 *
 * **Semantics.** The active set starts from the TIER DEFAULTS at the project's
 * rung — every rule that is not `style` and is proposed at that rung. `presets`
 * and `enabled` ADD to it, `disabled` SUBTRACTS, and every add is intersected
 * with the corpus so a selection naming a rule this project does not have
 * cannot inflate the set.
 *
 * **`base` is not declinable, and `disabled` cannot remove it** (ask#11286:
 * base means "declining it breaks Minsky"). A `disabled` entry naming a base
 * rule is ignored rather than rejected — validation belongs at the `rules
 * disable` surface, which already refuses unknown ids (mt#4866 SC1), and a
 * compile is the wrong place to fail a project over a config line it can simply
 * not honour. `explainRuleSelection` reports the ignored entries so the refusal
 * is visible rather than silent.
 *
 * **Where this came from.** mt#4866 made the base set the WHOLE corpus as an
 * explicit Phase-0 substitution, recorded in this docblock, because tiers did
 * not exist yet: "tier defaults at the project's rung" degenerates to "the
 * whole corpus" when nothing is tiered. mt#4974 shipped the tiers and this task
 * re-derives the base set from them, which is what that substitution said had
 * to happen rather than be inherited as though the RFC had said it.
 *
 * The degenerate case still holds and is still exercised: with `tiers` omitted,
 * or with a corpus in which nothing carries a tier — which is Minsky's own
 * repository, and every project that has not adopted the shipped corpus — every
 * rule is untiered, every untiered rule defaults on, and the base set is again
 * the whole corpus. That is why this change is behaviour-preserving for every
 * existing project and mechanism-bearing for a new one.
 */
export function resolveActiveRules(
  allRuleIds: string[],
  config: RuleSelectionConfig,
  options: ResolveActiveRulesOptions = {}
): Set<string> {
  return explainRuleSelection(allRuleIds, config, options).active;
}

/** The resolution, plus what it could not honour. */
export interface RuleSelectionExplanation {
  /** The resolved active set. */
  readonly active: Set<string>;
  /** `disabled` entries naming a `base` rule, which cannot be declined. */
  readonly refusedDisables: string[];
  /**
   * Ids named by `presets` / `enabled` / `disabled` that this project does not
   * have. SC5: `compile` reports these rather than skipping them silently.
   */
  readonly unresolvedIds: string[];
}

export function explainRuleSelection(
  allRuleIds: string[],
  config: RuleSelectionConfig,
  options: ResolveActiveRulesOptions = {}
): RuleSelectionExplanation {
  const corpus = new Set(allRuleIds);
  const tierIndex = indexTiers(options.tiers ?? []);
  const presets = options.presets ?? {};

  // Base set: the tier defaults at the project's rung.
  const active = new Set<string>();
  for (const id of corpus) {
    const info = tierIndex.get(id);
    if (!defaultsOn(info?.tier)) continue;
    if (!rungAllows(info?.minimumRung, config.rung)) continue;
    active.add(id);
  }

  const unresolvedIds: string[] = [];
  const addNamed = (id: string): void => {
    if (corpus.has(id)) active.add(id);
    else unresolvedIds.push(id);
  };

  // Presets add. A preset name this project does not know is itself
  // unresolvable — reported, not silently ignored.
  for (const presetName of config.presets) {
    const members = presets[presetName];
    if (members === undefined) {
      unresolvedIds.push(presetName);
      continue;
    }
    for (const id of members) addNamed(id);
  }

  for (const id of config.enabled) addNamed(id);

  // Disabled subtracts, and wins over both of the above — except over `base`.
  const refusedDisables: string[] = [];
  for (const id of config.disabled) {
    if (!corpus.has(id)) {
      unresolvedIds.push(id);
      continue;
    }
    if (tierIndex.get(id)?.tier === "base") {
      refusedDisables.push(id);
      continue;
    }
    active.delete(id);
  }

  return {
    active,
    refusedDisables: [...new Set(refusedDisables)].sort(),
    unresolvedIds: [...new Set(unresolvedIds)].sort(),
  };
}
