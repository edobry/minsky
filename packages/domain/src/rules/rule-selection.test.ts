import { describe, it, expect } from "bun:test";
import { resolveActiveRules } from "./rule-selection";
import { RULE_PRESETS } from "../configuration/schemas/rules";

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

describe("resolveActiveRules", () => {
  it("returns all rules when no config is specified", () => {
    const active = resolveActiveRules(ALL_RULES, { presets: [], enabled: [], disabled: [] });
    expect(active.size).toBe(ALL_RULES.length);
    for (const id of ALL_RULES) {
      expect(active.has(id)).toBe(true);
    }
  });

  // mt#4866 SC6 changed these three from ALLOW-LIST to ADDITIVE assertions. Under
  // the old resolver a preset or an `enabled` entry NARROWED the corpus to itself;
  // it now adds to a base set that is already the whole corpus, so every corpus
  // member stays active. The RFC's own words: "`presets` and `enabled` add,
  // `disabled` subtracts". What each case tests is unchanged — that a preset's
  // members end up active, that multiple presets union, and that an `enabled` id
  // ends up active — only the claim about NON-members is inverted.
  it("a preset's members are active (and non-members are no longer excluded)", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: ["minsky-core"],
      enabled: [],
      disabled: [],
    });
    for (const id of RULE_PRESETS["minsky-core"] ?? []) {
      if (ALL_RULES.includes(id)) expect(active.has(id)).toBe(true);
    }
    expect(active).toEqual(new Set(ALL_RULES));
  });

  it("combines multiple presets without narrowing the corpus", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: ["minsky-core", "typescript-strict"],
      enabled: [],
      disabled: [],
    });
    for (const id of [
      ...(RULE_PRESETS["minsky-core"] ?? []),
      ...(RULE_PRESETS["typescript-strict"] ?? []),
    ]) {
      if (ALL_RULES.includes(id)) expect(active.has(id)).toBe(true);
    }
    expect(active).toEqual(new Set(ALL_RULES));
  });

  it("an individually enabled rule is active, and the rest of the corpus stays active", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: [],
      enabled: ["custom-rule-a"],
      disabled: [],
    });
    expect(active.has("custom-rule-a")).toBe(true);
    expect(active.size).toBe(ALL_RULES.length);
  });

  // mt#4866 SC6, second clause. This is the part of the intersection that is NOT
  // vacuous at Phase 0: RULE_PRESETS names 13 ids that exist only in Minsky's own
  // repository and 3 that exist nowhere, so a preset can name a rule the project
  // does not have. Before the fix such an id was added verbatim and counted toward
  // `activeRuleCount`.
  it("mt#4866: an id named by a preset but absent from the corpus is not added", () => {
    const active = resolveActiveRules(["a", "b"], {
      presets: [],
      enabled: ["not-in-this-corpus"],
      disabled: [],
    });
    expect(active.has("not-in-this-corpus")).toBe(false);
    expect(active).toEqual(new Set(["a", "b"]));
  });

  it("removes disabled rules from preset results", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: ["minsky-core"],
      enabled: [],
      disabled: ["minsky-workflow"],
    });
    expect(active.has("minsky-workflow")).toBe(false);
    // Rest of the preset is still included
    expect(active.has("task-status-protocol")).toBe(true);
  });

  it("silently ignores unknown presets", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: ["nonexistent-preset"],
      enabled: ["custom-rule-a"],
      disabled: [],
    });
    // An unknown preset contributes nothing and throws nothing; the corpus is
    // otherwise untouched (mt#4866 SC6 — was `size === 1` under allow-list mode).
    expect(active.has("custom-rule-a")).toBe(true);
    expect(active).toEqual(new Set(ALL_RULES));
  });

  it("disabled overrides enabled (disabled wins)", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: [],
      enabled: ["custom-rule-a"],
      disabled: ["custom-rule-a"],
    });
    expect(active.has("custom-rule-a")).toBe(false);
    // Precedence is unchanged — `disabled` still wins. What changed is the rest of
    // the corpus: it survives instead of being emptied (mt#4866 SC6).
    expect(active.size).toBe(ALL_RULES.length - 1);
  });

  // ─── mt#4866 SC6: `disabled` is subtractive over the full corpus ───────────
  //
  // Pre-fix control (measured 2026-09-04 at d667c9634, before the resolver
  // change): this exact input resolved to the EMPTY set, because any non-empty
  // selection field flipped the resolver into allow-list mode starting from
  // nothing. `disableRule` writes `disabled: [id]` with the other two empty, so
  // the first `rules disable` a user ran on a fresh project silently resolved to
  // zero rules.
  it("mt#4866: a lone `disabled` entry subtracts from the full corpus, never empties it", () => {
    const active = resolveActiveRules(["a", "x", "b"], {
      presets: [],
      enabled: [],
      disabled: ["x"],
    });
    expect(active).toEqual(new Set(["a", "b"]));
  });

  it("disabled also removes rules that came from a preset", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: ["minsky-core"],
      enabled: [],
      disabled: ["task-status-protocol", PR_PREPARATION_WORKFLOW_ID],
    });
    expect(active.has("task-status-protocol")).toBe(false);
    expect(active.has(PR_PREPARATION_WORKFLOW_ID)).toBe(false);
    // Others from preset still active
    expect(active.has("minsky-workflow")).toBe(true);
  });
});
