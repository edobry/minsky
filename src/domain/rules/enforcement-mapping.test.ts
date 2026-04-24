import { describe, expect, it } from "bun:test";
import {
  ENFORCEMENT_MAPPINGS,
  getEnforcement,
  getEnforcedRules,
  getUnenforced,
} from "./enforcement-mapping";
import { first } from "../../utils/array-safety";

const NAMING_CONVENTIONS_RULE_ID = "meta-cognitive-boundary-protocol";
const BUN_TEST_PATTERNS_RULE_ID = "bun-test-patterns";

// Claude Code hook rule IDs — extracted to avoid magic-string-duplication warnings
const CLAUDE_HOOK_RULE_IDS = [
  "prompt-watermark-enforcement",
  "mcp-tool-preference",
  "review-before-merge",
  "pr-identity-provenance",
  "acceptance-test-gate",
  "incremental-typecheck",
  "task-spec-validation",
  "post-merge-sync",
  "typecheck-gate",
] as const;

// MCP tool-logic rule IDs
const MCP_TOOL_LOGIC_RULE_IDS = [
  "project-setup-guard",
  "duplicate-pr-prevention",
  "command-validation",
] as const;

const CLAUDE_CODE_HOOK_TYPE = "claude-code-hook" as const;
const MCP_TOOL_LOGIC_TYPE = "mcp-tool-logic" as const;

describe("getEnforcement", () => {
  it("returns the mapping for a known rule ID", () => {
    const result = getEnforcement(BUN_TEST_PATTERNS_RULE_ID);
    expect(result).toBeDefined();
    expect(result?.ruleId).toBe(BUN_TEST_PATTERNS_RULE_ID);
    expect(result?.mechanisms.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown rule ID", () => {
    const result = getEnforcement("nonexistent-rule-xyz");
    expect(result).toBeUndefined();
  });

  it("returned mapping contains well-formed mechanisms", () => {
    const result = getEnforcement(NAMING_CONVENTIONS_RULE_ID);
    expect(result).toBeDefined();
    const mechanism = first(result?.mechanisms ?? []);
    expect(mechanism.type).toBe("eslint");
    expect(typeof mechanism.name).toBe("string");
    expect(mechanism.name.length).toBeGreaterThan(0);
    expect(typeof mechanism.description).toBe("string");
    expect(mechanism.description.length).toBeGreaterThan(0);
  });
});

describe("getEnforcedRules", () => {
  it("returns an array of rule IDs", () => {
    const ids = getEnforcedRules();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("includes every rule present in ENFORCEMENT_MAPPINGS", () => {
    const ids = getEnforcedRules();
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      expect(ids).toContain(mapping.ruleId);
    }
  });

  it("contains known enforced rules", () => {
    const ids = getEnforcedRules();
    expect(ids).toContain(BUN_TEST_PATTERNS_RULE_ID);
    expect(ids).toContain(NAMING_CONVENTIONS_RULE_ID);
    expect(ids).toContain("git-usage-policy");
    expect(ids).toContain("no-skipped-tests");
  });

  it("contains Claude Code hook rule IDs", () => {
    const ids = getEnforcedRules();
    for (const ruleId of CLAUDE_HOOK_RULE_IDS) {
      expect(ids).toContain(ruleId);
    }
  });

  it("contains MCP tool-logic rule IDs", () => {
    const ids = getEnforcedRules();
    for (const ruleId of MCP_TOOL_LOGIC_RULE_IDS) {
      expect(ids).toContain(ruleId);
    }
  });

  it("returns exactly as many IDs as there are mappings", () => {
    const ids = getEnforcedRules();
    expect(ids.length).toBe(ENFORCEMENT_MAPPINGS.length);
  });
});

describe("getUnenforced", () => {
  it("returns rules that are not in ENFORCEMENT_MAPPINGS", () => {
    const allRules = [
      BUN_TEST_PATTERNS_RULE_ID,
      NAMING_CONVENTIONS_RULE_ID,
      "some-unenforced-rule",
    ];
    const unenforced = getUnenforced(allRules);
    expect(unenforced).toContain("some-unenforced-rule");
    expect(unenforced).not.toContain(BUN_TEST_PATTERNS_RULE_ID);
    expect(unenforced).not.toContain(NAMING_CONVENTIONS_RULE_ID);
  });

  it("returns an empty array when every supplied rule is enforced", () => {
    const allRules = [BUN_TEST_PATTERNS_RULE_ID, NAMING_CONVENTIONS_RULE_ID];
    const unenforced = getUnenforced(allRules);
    expect(unenforced).toEqual([]);
  });

  it("returns all rules when none are enforced", () => {
    const allRules = ["rule-a", "rule-b", "rule-c"];
    const unenforced = getUnenforced(allRules);
    expect(unenforced).toEqual(allRules);
  });

  it("handles an empty input array", () => {
    const unenforced = getUnenforced([]);
    expect(unenforced).toEqual([]);
  });

  it("handles duplicate rule IDs in allRuleIds gracefully", () => {
    const allRules = [BUN_TEST_PATTERNS_RULE_ID, BUN_TEST_PATTERNS_RULE_ID, "unknown-rule"];
    const unenforced = getUnenforced(allRules);
    expect(unenforced).toContain("unknown-rule");
    expect(unenforced).not.toContain(BUN_TEST_PATTERNS_RULE_ID);
  });

  it("still works when mixing new and old rule IDs", () => {
    const [firstClaudeHook] = CLAUDE_HOOK_RULE_IDS;
    const [firstMcpRule] = MCP_TOOL_LOGIC_RULE_IDS;
    const allRules = [firstClaudeHook, firstMcpRule, "not-a-real-rule"];
    const unenforced = getUnenforced(allRules);
    expect(unenforced).toEqual(["not-a-real-rule"]);
    expect(unenforced).not.toContain(firstClaudeHook);
    expect(unenforced).not.toContain(firstMcpRule);
  });
});

describe("ENFORCEMENT_MAPPINGS data integrity", () => {
  it("every mapping has a non-empty ruleId", () => {
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      expect(typeof mapping.ruleId).toBe("string");
      expect(mapping.ruleId.length).toBeGreaterThan(0);
    }
  });

  it("every mapping has at least one mechanism", () => {
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      expect(mapping.mechanisms.length).toBeGreaterThan(0);
    }
  });

  it("every mechanism has a valid type", () => {
    const validTypes = new Set([
      "eslint",
      "git-hook",
      "ci-check",
      "test",
      "script",
      CLAUDE_CODE_HOOK_TYPE,
      MCP_TOOL_LOGIC_TYPE,
    ]);
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      for (const mechanism of mapping.mechanisms) {
        expect(validTypes.has(mechanism.type)).toBe(true);
      }
    }
  });

  it("every mechanism has a valid portability value", () => {
    const validPortability = new Set(["portable", "harness-trapped"]);
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      for (const mechanism of mapping.mechanisms) {
        expect(validPortability.has(mechanism.portability)).toBe(true);
      }
    }
  });

  it("all claude-code-hook mechanisms are harness-trapped", () => {
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      for (const mechanism of mapping.mechanisms) {
        if (mechanism.type === CLAUDE_CODE_HOOK_TYPE) {
          expect(mechanism.portability).toBe("harness-trapped");
        }
      }
    }
  });

  it("all non-claude-code-hook mechanisms are portable", () => {
    const portableTypes = new Set([
      "eslint",
      "git-hook",
      "ci-check",
      "test",
      "script",
      MCP_TOOL_LOGIC_TYPE,
    ]);
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      for (const mechanism of mapping.mechanisms) {
        if (portableTypes.has(mechanism.type)) {
          expect(mechanism.portability).toBe("portable");
        }
      }
    }
  });

  it("rule IDs are unique across the mappings array", () => {
    const ids = ENFORCEMENT_MAPPINGS.map((m) => m.ruleId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("every mechanism has a non-empty name and description", () => {
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      for (const mechanism of mapping.mechanisms) {
        expect(typeof mechanism.name).toBe("string");
        expect(mechanism.name.length).toBeGreaterThan(0);
        expect(typeof mechanism.description).toBe("string");
        expect(mechanism.description.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("Claude Code hook coverage", () => {
  it("has an entry for each PreToolUse hook in settings.json", () => {
    expect(getEnforcement("prompt-watermark-enforcement")).toBeDefined();
    expect(getEnforcement("mcp-tool-preference")).toBeDefined();
    expect(getEnforcement("review-before-merge")).toBeDefined();
    expect(getEnforcement("pr-identity-provenance")).toBeDefined();
    expect(getEnforcement("acceptance-test-gate")).toBeDefined();
  });

  it("has an entry for each PostToolUse hook in settings.json", () => {
    expect(getEnforcement("incremental-typecheck")).toBeDefined();
    expect(getEnforcement("task-spec-validation")).toBeDefined();
    expect(getEnforcement("post-merge-sync")).toBeDefined();
  });

  it("has an entry for the Stop/SubagentStop typecheck hook", () => {
    expect(getEnforcement("typecheck-gate")).toBeDefined();
  });

  it("every Claude Code hook entry has type claude-code-hook", () => {
    for (const ruleId of CLAUDE_HOOK_RULE_IDS) {
      const mapping = getEnforcement(ruleId);
      expect(mapping).toBeDefined();
      if (mapping) {
        for (const mechanism of mapping.mechanisms) {
          expect(mechanism.type).toBe(CLAUDE_CODE_HOOK_TYPE);
        }
      }
    }
  });
});

describe("MCP tool-logic enforcement coverage", () => {
  it("has entries for all documented MCP validation functions", () => {
    for (const ruleId of MCP_TOOL_LOGIC_RULE_IDS) {
      expect(getEnforcement(ruleId)).toBeDefined();
    }
  });

  it("every mcp-tool-logic mechanism is portable", () => {
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      for (const mechanism of mapping.mechanisms) {
        if (mechanism.type === MCP_TOOL_LOGIC_TYPE) {
          expect(mechanism.portability).toBe("portable");
        }
      }
    }
  });
});
