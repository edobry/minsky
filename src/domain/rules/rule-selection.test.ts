import { describe, it, expect } from "bun:test";
import { resolveActiveRules } from "./rule-selection";
import { RULE_PRESETS } from "../configuration/schemas/rules";

const PR_PREPARATION_WORKFLOW_ID = "pr-preparation-workflow";

const ALL_RULES = [
  "minsky-workflow",
  "task-status-protocol",
  PR_PREPARATION_WORKFLOW_ID,
  "creating-tasks",
  "template-literals",
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

  it("expands a single preset to its rules", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: ["minsky-core"],
      enabled: [],
      disabled: [],
    });
    const expected = new Set(RULE_PRESETS["minsky-core"]);
    expect(active).toEqual(expected);
  });

  it("combines multiple presets", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: ["minsky-core", "typescript-strict"],
      enabled: [],
      disabled: [],
    });
    const expected = new Set([
      ...(RULE_PRESETS["minsky-core"] ?? []),
      ...(RULE_PRESETS["typescript-strict"] ?? []),
    ]);
    expect(active).toEqual(expected);
  });

  it("adds individually enabled rules", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: [],
      enabled: ["custom-rule-a"],
      disabled: [],
    });
    expect(active.has("custom-rule-a")).toBe(true);
    expect(active.size).toBe(1);
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
    // Only the enabled rule should be active
    expect(active.size).toBe(1);
    expect(active.has("custom-rule-a")).toBe(true);
  });

  it("disabled overrides enabled (disabled wins)", () => {
    const active = resolveActiveRules(ALL_RULES, {
      presets: [],
      enabled: ["custom-rule-a"],
      disabled: ["custom-rule-a"],
    });
    expect(active.has("custom-rule-a")).toBe(false);
    expect(active.size).toBe(0);
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
