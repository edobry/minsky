import { describe, expect, it } from "bun:test";
import {
  ENFORCEMENT_MAPPINGS,
  getEnforcement,
  getEnforcedRules,
  getUnenforced,
} from "./enforcement-mapping";
import { first } from "../../utils/array-safety";

const TEMPLATE_LITERALS_RULE_ID = "template-literals";

describe("getEnforcement", () => {
  it("returns the mapping for a known rule ID", () => {
    const result = getEnforcement("file-size");
    expect(result).toBeDefined();
    expect(result?.ruleId).toBe("file-size");
    expect(result?.mechanisms.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown rule ID", () => {
    const result = getEnforcement("nonexistent-rule-xyz");
    expect(result).toBeUndefined();
  });

  it("returned mapping contains well-formed mechanisms", () => {
    const result = getEnforcement(TEMPLATE_LITERALS_RULE_ID);
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
    expect(ids).toContain("file-size");
    expect(ids).toContain(TEMPLATE_LITERALS_RULE_ID);
    expect(ids).toContain("bun-test-patterns");
    expect(ids).toContain("git-usage-policy");
    expect(ids).toContain("no-skipped-tests");
  });

  it("returns exactly as many IDs as there are mappings", () => {
    const ids = getEnforcedRules();
    expect(ids.length).toBe(ENFORCEMENT_MAPPINGS.length);
  });
});

describe("getUnenforced", () => {
  it("returns rules that are not in ENFORCEMENT_MAPPINGS", () => {
    const allRules = ["file-size", TEMPLATE_LITERALS_RULE_ID, "some-unenforced-rule"];
    const unenforced = getUnenforced(allRules);
    expect(unenforced).toContain("some-unenforced-rule");
    expect(unenforced).not.toContain("file-size");
    expect(unenforced).not.toContain(TEMPLATE_LITERALS_RULE_ID);
  });

  it("returns an empty array when every supplied rule is enforced", () => {
    const allRules = ["file-size", TEMPLATE_LITERALS_RULE_ID];
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
    const allRules = ["file-size", "file-size", "unknown-rule"];
    const unenforced = getUnenforced(allRules);
    // file-size is enforced, so only the unknown-rule entries remain
    expect(unenforced).toContain("unknown-rule");
    expect(unenforced).not.toContain("file-size");
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
    const validTypes = new Set(["eslint", "git-hook", "ci-check", "test", "script"]);
    for (const mapping of ENFORCEMENT_MAPPINGS) {
      for (const mechanism of mapping.mechanisms) {
        expect(validTypes.has(mechanism.type)).toBe(true);
      }
    }
  });

  it("rule IDs are unique across the mappings array", () => {
    const ids = ENFORCEMENT_MAPPINGS.map((m) => m.ruleId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
