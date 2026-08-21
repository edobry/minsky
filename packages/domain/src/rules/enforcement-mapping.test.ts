import { describe, expect, it } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed .claude/settings.json, mirroring enforcement-mapping.ts's own production read path; mocking it would defeat the parity check's purpose (mt#975)
import * as fs from "fs";
import * as path from "path";
import {
  ENFORCEMENT_MAPPINGS,
  NON_ENFORCEMENT_CLAUDE_HOOKS,
  getEnforcement,
  getEnforcedRules,
  getUnenforced,
} from "./enforcement-mapping";
import { first } from "@minsky/shared/array-safety";

const NAMING_CONVENTIONS_RULE_ID = "meta-cognitive-boundary-protocol";
const BUN_TEST_PATTERNS_RULE_ID = "bun-test-patterns";

// Claude Code hook rule IDs — extracted to avoid magic-string-duplication warnings
const CLAUDE_HOOK_RULE_IDS = [
  "prompt-watermark-enforcement",
  "mcp-tool-preference",
  "review-before-merge",
  "pr-identity-provenance",
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
    expect(ids).toContain("testing-standards");
    expect(ids).toContain("git-safety");
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

// ── settings.json parity (mt#975) ─────────────────────────────────────────
//
// require-acceptance-tests-before-done.ts sat in .minsky/hooks/ for months,
// registered NOWHERE in .claude/settings.json, while an unrelated
// enforcement-mapping.ts entry kept claiming it was live. Neither direction
// of that mismatch had a test:
//   - forward: a settings.json-registered hook with no ENFORCEMENT_MAPPINGS
//     entry and no NON_ENFORCEMENT_CLAUDE_HOOKS allowlist entry can rot
//     untriaged indefinitely.
//   - reverse: an ENFORCEMENT_MAPPINGS entry whose configPath no longer
//     matches any settings.json command is exactly the stale reference this
//     task found and removed for require-acceptance-tests-before-done.ts.
// These tests close both gaps.

/**
 * The subject this parity check reads, named as a RESOLVABLE string literal (mt#4367).
 *
 * The declaration is the load-bearing part, not the value. `scripts/find-related-tests.ts`
 * builds a DATA-READ edge (mt#4224) only from a quoted literal that resolves to a file which
 * exists, and this test used to assemble its subject fragment-by-fragment —
 * `path.join(dir, ".claude", "settings.json")` — which mt#4224's SC5 bounds out by
 * construction. The contiguous string did appear in this file, but only in comments and an
 * error message, neither of which the extractor can turn into an edge. So
 * `findRelatedTestFiles([".claude/settings.json"])` returned `[]`, and a hook registered in
 * settings.json without an `enforcement-mapping.ts` entry was invisible to the pre-commit
 * gate — first surfaced by a full CI run, after the PR had already been approved (mt#1880).
 *
 * Naming it is the affordance mt#4224's own docblock documents: a `join(REPO_ROOT, relPath)`
 * whose `relPath` is a named constant works, because the CONSTANT's declaration carries the
 * literal and the extractor scans the whole file rather than the call site. No selector
 * change and no widening of mt#4224's deliberate bound is needed — the shipped mechanism
 * already handles this shape once the test names its subject.
 */
const SETTINGS_JSON_RELATIVE_PATH = ".claude/settings.json";

/** Locate the repo's .claude/settings.json by walking up from a starting directory. */
function findSettingsJsonPath(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, SETTINGS_JSON_RELATIVE_PATH);
    // eslint-disable-next-line custom/no-real-fs-in-tests -- locating the real settings.json is the point of this parity check, not test-state faking (mt#975)
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate ${SETTINGS_JSON_RELATIVE_PATH} above ${startDir}`);
}

/** Extract every unique ".claude/hooks/*.ts" path referenced by a "command" field in settings.json. */
function readClaudeHookCommands(settingsPath: string): Set<string> {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed settings.json to catch real drift between it and enforcement-mapping.ts; an in-memory fixture couldn't detect a hook that rots undetected in the actual file (mt#975)
  const raw = fs.readFileSync(settingsPath, "utf8");
  const settings: unknown = JSON.parse(raw);
  const configPaths = new Set<string>();
  const HOOK_COMMAND_PATTERN = /\.claude\/hooks\/[^/"]+\.ts$/;

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "command" && typeof value === "string") {
          const match = value.match(HOOK_COMMAND_PATTERN);
          if (match) configPaths.add(match[0]);
          continue;
        }
        walk(value);
      }
    }
  }

  walk(settings);
  return configPaths;
}

describe("settings.json hook parity", () => {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- real cwd is required to locate the real, committed settings.json this test validates against (mt#975)
  const settingsPath = findSettingsJsonPath(process.cwd());
  const registeredHooks = readClaudeHookCommands(settingsPath);

  const enforcementConfigPaths = new Set(
    ENFORCEMENT_MAPPINGS.flatMap((m) => m.mechanisms)
      .filter((mech) => mech.type === CLAUDE_CODE_HOOK_TYPE)
      .map((mech) => mech.configPath)
      .filter((p): p is string => Boolean(p))
  );

  const allowlistedConfigPaths = new Set(NON_ENFORCEMENT_CLAUDE_HOOKS.map((h) => h.configPath));

  it("finds a non-empty set of hooks registered in settings.json (sanity check)", () => {
    expect(registeredHooks.size).toBeGreaterThan(10);
  });

  it("every hook registered in settings.json is either an ENFORCEMENT_MAPPINGS entry or an explicitly-reasoned NON_ENFORCEMENT_CLAUDE_HOOKS entry", () => {
    const untriaged = [...registeredHooks].filter(
      (configPath) =>
        !enforcementConfigPaths.has(configPath) && !allowlistedConfigPaths.has(configPath)
    );
    expect(
      untriaged,
      `Untriaged .claude/settings.json hooks (add to ENFORCEMENT_MAPPINGS or NON_ENFORCEMENT_CLAUDE_HOOKS in enforcement-mapping.ts): ${untriaged.join(", ")}`
    ).toEqual([]);
  });

  it("no hook is both an ENFORCEMENT_MAPPINGS entry and a NON_ENFORCEMENT_CLAUDE_HOOKS entry", () => {
    const overlap = [...enforcementConfigPaths].filter((p) => allowlistedConfigPaths.has(p));
    expect(overlap).toEqual([]);
  });

  it("every claude-code-hook ENFORCEMENT_MAPPINGS configPath is an actual settings.json command (catches stale references to deleted/renamed hooks)", () => {
    const stale = [...enforcementConfigPaths].filter((p) => !registeredHooks.has(p));
    expect(
      stale,
      `ENFORCEMENT_MAPPINGS entries pointing at hooks no longer registered in settings.json: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("every NON_ENFORCEMENT_CLAUDE_HOOKS configPath is an actual settings.json command (catches stale allowlist entries)", () => {
    const stale = [...allowlistedConfigPaths].filter((p) => !registeredHooks.has(p));
    expect(
      stale,
      `NON_ENFORCEMENT_CLAUDE_HOOKS entries pointing at hooks no longer registered in settings.json: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("every NON_ENFORCEMENT_CLAUDE_HOOKS entry has a non-empty reason", () => {
    for (const hook of NON_ENFORCEMENT_CLAUDE_HOOKS) {
      expect(hook.reason.length).toBeGreaterThan(10);
    }
  });
});
