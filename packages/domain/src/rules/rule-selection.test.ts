import { describe, it, expect } from "bun:test";
import {
  deriveRulePresets,
  explainRuleSelection,
  resolveActiveRules,
  type RuleTierInfo,
} from "./rule-selection";
import type { RuleSelectionConfig } from "./selection-resolution";

const PR_PREPARATION_WORKFLOW_ID = "pr-preparation-workflow";

const ALL_RULES = [
  "minsky-workflow",
  "task-status-protocol",
  PR_PREPARATION_WORKFLOW_ID,
  "no-dynamic-imports",
  "designing-tests",
  "bun-test-patterns",
  "custom-rule-a",
  "custom-rule-b",
];

/**
 * The hand-typed `RULE_PRESETS` table these tests used to import is gone
 * (mt#573 SC1) — presets are derived from tier metadata now. Where a case only
 * needs "some preset with some members", it supplies them explicitly, which
 * also removes the old coupling: several assertions below used to be partly
 * vacuous because the table's members were mostly absent from `ALL_RULES`.
 */
const MINSKY_CORE = ["minsky-workflow", "task-status-protocol", PR_PREPARATION_WORKFLOW_ID];
const TYPESCRIPT_STRICT = ["no-dynamic-imports", "custom-rule-b"];
const PRESETS = { "minsky-core": MINSKY_CORE, "typescript-strict": TYPESCRIPT_STRICT };

function config(partial: Partial<RuleSelectionConfig> = {}): RuleSelectionConfig {
  return { presets: [], enabled: [], disabled: [], ...partial };
}

describe("resolveActiveRules — mt#4866 semantics, preserved", () => {
  it("returns all rules when no config is specified", () => {
    const active = resolveActiveRules(ALL_RULES, config());
    expect(active).toEqual(new Set(ALL_RULES));
  });

  // mt#4866 SC6 changed these from ALLOW-LIST to ADDITIVE assertions. Under the
  // pre-mt#4866 resolver a preset or an `enabled` entry NARROWED the corpus to
  // itself; it adds to the base set instead. The RFC's own words: "`presets` and
  // `enabled` add, `disabled` subtracts".
  it("a preset's members are active (and non-members are not excluded)", () => {
    const active = resolveActiveRules(ALL_RULES, config({ presets: ["minsky-core"] }), {
      presets: PRESETS,
    });
    for (const id of MINSKY_CORE) expect(active.has(id)).toBe(true);
    expect(active).toEqual(new Set(ALL_RULES));
  });

  it("combines multiple presets without narrowing the corpus", () => {
    const active = resolveActiveRules(
      ALL_RULES,
      config({ presets: ["minsky-core", "typescript-strict"] }),
      { presets: PRESETS }
    );
    for (const id of [...MINSKY_CORE, ...TYPESCRIPT_STRICT]) expect(active.has(id)).toBe(true);
    expect(active).toEqual(new Set(ALL_RULES));
  });

  it("an individually enabled rule is active, and the rest of the corpus stays active", () => {
    const active = resolveActiveRules(ALL_RULES, config({ enabled: ["custom-rule-a"] }));
    expect(active.has("custom-rule-a")).toBe(true);
    expect(active.size).toBe(ALL_RULES.length);
  });

  it("mt#4866: an id named by a selection but absent from the corpus is not added", () => {
    const active = resolveActiveRules(["a", "b"], config({ enabled: ["not-in-this-corpus"] }));
    expect(active.has("not-in-this-corpus")).toBe(false);
    expect(active).toEqual(new Set(["a", "b"]));
  });

  it("removes disabled rules from preset results", () => {
    const active = resolveActiveRules(
      ALL_RULES,
      config({ presets: ["minsky-core"], disabled: ["minsky-workflow"] }),
      { presets: PRESETS }
    );
    expect(active.has("minsky-workflow")).toBe(false);
    expect(active.has("task-status-protocol")).toBe(true);
  });

  it("an unknown preset contributes nothing and throws nothing", () => {
    const active = resolveActiveRules(
      ALL_RULES,
      config({ presets: ["nonexistent-preset"], enabled: ["custom-rule-a"] }),
      { presets: PRESETS }
    );
    expect(active.has("custom-rule-a")).toBe(true);
    expect(active).toEqual(new Set(ALL_RULES));
  });

  it("disabled overrides enabled (disabled wins)", () => {
    const active = resolveActiveRules(
      ALL_RULES,
      config({ enabled: ["custom-rule-a"], disabled: ["custom-rule-a"] })
    );
    expect(active.has("custom-rule-a")).toBe(false);
    expect(active.size).toBe(ALL_RULES.length - 1);
  });

  // Pre-fix control (measured 2026-09-04 at d667c9634, before mt#4866): this
  // exact input resolved to the EMPTY set, because any non-empty selection field
  // flipped the resolver into allow-list mode starting from nothing.
  it("mt#4866: a lone `disabled` entry subtracts from the corpus, never empties it", () => {
    const active = resolveActiveRules(["a", "x", "b"], config({ disabled: ["x"] }));
    expect(active).toEqual(new Set(["a", "b"]));
  });
});

const BASE_ID = "base-rule";
const OPINIONATED_ID = "opinionated-rule";
const STYLE_ID = "style-rule";
const UNTIERED_ID = "untiered-rule";

describe("resolveActiveRules — tier defaults (mt#573 SC1/SC2)", () => {
  const tiers: RuleTierInfo[] = [
    { id: BASE_ID, tier: "base" },
    { id: OPINIONATED_ID, tier: "opinionated" },
    { id: STYLE_ID, tier: "style" },
    { id: UNTIERED_ID },
  ];
  const ids = tiers.map((t) => t.id);

  it("base and opinionated default ON, style defaults OFF", () => {
    const active = resolveActiveRules(ids, config(), { tiers });
    expect(active.has(BASE_ID)).toBe(true);
    expect(active.has(OPINIONATED_ID)).toBe(true);
    expect(active.has(STYLE_ID)).toBe(false);
  });

  // The load-bearing case, not a fallback: every rule in Minsky's own repository
  // and every rule a user writes carries no `tier:`. Treating absence as "off"
  // would empty the corpus of any project that never adopted tiers.
  it("an UNTIERED rule defaults ON", () => {
    const active = resolveActiveRules(ids, config(), { tiers });
    expect(active.has(UNTIERED_ID)).toBe(true);
  });

  it("a style rule becomes active when explicitly enabled", () => {
    const active = resolveActiveRules(ids, config({ enabled: [STYLE_ID] }), { tiers });
    expect(active.has(STYLE_ID)).toBe(true);
  });

  // ask#11286: base means "declining it breaks Minsky".
  it("`disabled` CANNOT remove a base rule, and the refusal is reported", () => {
    const { active, refusedDisables } = explainRuleSelection(
      ids,
      config({ disabled: [BASE_ID, OPINIONATED_ID] }),
      { tiers }
    );
    expect(active.has(BASE_ID)).toBe(true);
    expect(active.has(OPINIONATED_ID)).toBe(false);
    expect(refusedDisables).toEqual([BASE_ID]);
  });

  // The mt#4866 substitution, still exercised: with no tier metadata every rule
  // is untiered, every untiered rule defaults on, and the base set is again the
  // whole corpus. This is why the change is behaviour-preserving for every
  // project that has not adopted the shipped corpus — including this one.
  it("with NO tier metadata the base set degenerates to the whole corpus", () => {
    expect(resolveActiveRules(ids, config())).toEqual(new Set(ids));
  });
});

describe("resolveActiveRules — rung (mt#573 SC1)", () => {
  const tiers: RuleTierInfo[] = [
    { id: "everywhere", tier: "opinionated" },
    { id: "from-t1", tier: "opinionated", minimumRung: "T1" },
    { id: "from-t4", tier: "opinionated", minimumRung: "T4" },
  ];
  const ids = tiers.map((t) => t.id);

  it("a project rung excludes rules proposed only at a higher rung", () => {
    const active = resolveActiveRules(ids, config({ rung: "T1" }), { tiers });
    expect(active).toEqual(new Set(["everywhere", "from-t1"]));
  });

  it("a project at the top rung receives every rung's rules", () => {
    expect(resolveActiveRules(ids, config({ rung: "T4" }), { tiers })).toEqual(new Set(ids));
  });

  // Absent rung means NO filter, not T0 — a project that never declared a rung
  // must not silently lose rules to a comparison it did not opt into.
  it("an ABSENT project rung applies no rung filter at all", () => {
    expect(resolveActiveRules(ids, config(), { tiers })).toEqual(new Set(ids));
  });

  it("an explicitly enabled rule still gets in from below its rung", () => {
    const active = resolveActiveRules(ids, config({ rung: "T1", enabled: ["from-t4"] }), { tiers });
    expect(active.has("from-t4")).toBe(true);
  });
});

describe("explainRuleSelection — what could not be honoured (mt#573 SC5)", () => {
  const tiers: RuleTierInfo[] = [{ id: "a" }, { id: "b" }];

  it("reports ids named by the selection that this project does not have", () => {
    const { unresolvedIds } = explainRuleSelection(
      ["a", "b"],
      config({ enabled: ["ghost"], disabled: ["phantom"] }),
      { tiers }
    );
    expect(unresolvedIds).toEqual(["ghost", "phantom"]);
  });

  it("reports a preset NAME the project cannot resolve", () => {
    const { unresolvedIds } = explainRuleSelection(["a", "b"], config({ presets: ["no-such"] }), {
      tiers,
      presets: {},
    });
    expect(unresolvedIds).toEqual(["no-such"]);
  });

  it("reports a preset MEMBER the project does not have", () => {
    const { unresolvedIds } = explainRuleSelection(["a"], config({ presets: ["p"] }), {
      tiers: [{ id: "a" }],
      presets: { p: ["a", "deleted-by-hand"] },
    });
    expect(unresolvedIds).toEqual(["deleted-by-hand"]);
  });

  it("says nothing when the selection resolves cleanly", () => {
    const { unresolvedIds, refusedDisables } = explainRuleSelection(
      ["a", "b"],
      config({ disabled: ["b"] }),
      { tiers }
    );
    expect(unresolvedIds).toEqual([]);
    expect(refusedDisables).toEqual([]);
  });
});

describe("deriveRulePresets (mt#573 SC1)", () => {
  const corpus: RuleTierInfo[] = [
    { id: "base-1", tier: "base" },
    { id: "base-2", tier: "base", minimumRung: "T3" },
    { id: "opin-1", tier: "opinionated" },
    { id: "untiered", tier: undefined },
  ];

  it("derives one preset per tier, named for the tier", () => {
    const presets = deriveRulePresets(corpus, ["base-1", "base-2", "opin-1", "untiered"]);
    expect(Object.keys(presets).sort()).toEqual(["base", "opinionated", "style"]);
    expect(presets.base).toEqual(["base-1", "base-2"]);
    expect(presets.opinionated).toEqual(["opin-1"]);
  });

  // AT5, by construction: a preset cannot name an id the project does not have,
  // because the ids are intersected with the project's own corpus. Pre-fix
  // (measured 2026-09-05), 6 of 6 hand-typed presets named an absent id.
  it("never names a rule the project does not have", () => {
    const presets = deriveRulePresets(corpus, ["base-1"]);
    expect(presets.base).toEqual(["base-1"]);
    expect(presets.opinionated).toEqual([]);
  });

  it("an untiered rule belongs to no preset", () => {
    const presets = deriveRulePresets(corpus, ["untiered"]);
    for (const ids of Object.values(presets)) expect(ids).toEqual([]);
  });

  it("respects the project's rung", () => {
    const all = ["base-1", "base-2", "opin-1"];
    expect(deriveRulePresets(corpus, all, "T1").base).toEqual(["base-1"]);
    expect(deriveRulePresets(corpus, all, "T3").base).toEqual(["base-1", "base-2"]);
  });

  // An absent bundle reads as "no such tier", which is a different fact from
  // "that tier has no members here" — so every tier keeps a key.
  it("keeps a key for a tier that resolves to nothing", () => {
    expect(deriveRulePresets([], []).style).toEqual([]);
  });

  it("sorts members deterministically", () => {
    const shuffled: RuleTierInfo[] = [
      { id: "z", tier: "base" },
      { id: "a", tier: "base" },
      { id: "m", tier: "base" },
    ];
    expect(deriveRulePresets(shuffled, ["z", "a", "m"]).base).toEqual(["a", "m", "z"]);
  });
});
