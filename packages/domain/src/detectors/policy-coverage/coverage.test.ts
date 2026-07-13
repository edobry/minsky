/**
 * Tests for the coverage decision function.
 *
 * Acceptance:
 *   - Golden: an action whose category is named in policy with an authority
 *     keyword in the same statement is `covered: true`.
 *   - Negative: an action whose category appears WITHOUT authority is uncovered.
 *   - Decision Defaults wiring: an action covered by `decision-defaults.mdc`
 *     content is considered covered.
 *
 * Reference: mt#1575 §Acceptance Tests, ADR-008 §Router
 */

import { describe, it, expect } from "bun:test";
import { decideCoverage, __TEST_ONLY } from "./coverage";
import type { ActionDescriptor } from "./coverage";
import type { PolicyCorpus, PolicyEntry } from "./corpus-loader";

function makeEntry(overrides: Partial<PolicyEntry> = {}): PolicyEntry {
  return {
    source: "test-source.md",
    ref: "/tmp/test-source.md",
    content: "",
    category: "claude-md",
    ...overrides,
  };
}

function makeCorpus(entries: PolicyEntry[]): PolicyCorpus {
  return {
    entries,
    loadedCount: entries.length,
    unavailableCount: 0,
  };
}

describe("decideCoverage", () => {
  describe("golden case: category + authority in same statement → covered", () => {
    it("covers a new-config-key when policy mentions 'config' + 'default'", () => {
      const entry = makeEntry({
        content: [
          "# Defaults",
          "",
          "All config defaults are set in src/defaults.ts. The default timeout is 30000.",
          "",
        ].join("\n"),
      });
      const corpus = makeCorpus([entry]);
      const action: ActionDescriptor = {
        reason: "new-config-key",
        detail: "edit to src/options.json",
        filePath: "src/options.json",
      };
      const result = decideCoverage(action, corpus);
      expect(result.covered).toBe(true);
      if (result.covered) {
        expect(result.evidence).toHaveLength(1);
        expect(result.evidence[0]?.policySource).toBe("test-source.md");
      }
    });

    it("covers a new-dependency when policy says 'dependency must be approved'", () => {
      const entry = makeEntry({
        content: "Every new dependency must be reviewed and approved by the architect.",
      });
      const corpus = makeCorpus([entry]);
      const action: ActionDescriptor = {
        reason: "new-dependency",
        detail: "edit to package.json",
        filePath: "package.json",
      };
      const result = decideCoverage(action, corpus);
      expect(result.covered).toBe(true);
    });

    it("covers via list-item statement", () => {
      const entry = makeEntry({
        content: [
          "# Conventions",
          "",
          "- Naming: prefer PascalCase for new exported classes.",
          "- Tests live under __tests__.",
        ].join("\n"),
      });
      const corpus = makeCorpus([entry]);
      const action: ActionDescriptor = {
        reason: "new-top-level-export",
        detail: "new exported class",
        filePath: "src/foo.ts",
      };
      const result = decideCoverage(action, corpus);
      expect(result.covered).toBe(true);
    });
  });

  describe("negative case: category without authority → uncovered", () => {
    it("does not cover when 'config' appears without an authority keyword", () => {
      const entry = makeEntry({
        content: "We have a config object somewhere in the code.",
      });
      const corpus = makeCorpus([entry]);
      const action: ActionDescriptor = {
        reason: "new-config-key",
        detail: "edit to src/options.json",
        filePath: "src/options.json",
      };
      const result = decideCoverage(action, corpus);
      expect(result.covered).toBe(false);
    });

    it("does not cover when authority keyword is in a different paragraph", () => {
      const entry = makeEntry({
        content: [
          "We use a config object.",
          "",
          "All authority decisions must go through the council.",
        ].join("\n"),
      });
      const corpus = makeCorpus([entry]);
      const action: ActionDescriptor = {
        reason: "new-config-key",
        detail: "edit to options.json",
        filePath: "options.json",
      };
      // category in para 1, authority in para 2 — should NOT cover
      const result = decideCoverage(action, corpus);
      expect(result.covered).toBe(false);
    });
  });

  describe("decision-defaults.mdc wiring", () => {
    it("covers Postgres-as-datastore choice via decision-defaults excerpt", () => {
      const entry = makeEntry({
        source: "decision-defaults.mdc",
        content: [
          "## Datastores: Postgres-via-Supabase by default",
          "",
          "When you need persistence, pubsub, or ephemeral state: Postgres.",
          "A second store (Redis, MinIO, Mongo, etc.) requires a workload",
          "Postgres can't serve. Minsky is single-node + single-store by default.",
          "",
          '**Generic-SE override:** "use Redis for queues."',
        ].join("\n"),
      });
      const corpus = makeCorpus([entry]);
      const action: ActionDescriptor = {
        reason: "new-dependency",
        detail: "Adding postgres dependency",
        filePath: "package.json",
      };
      const result = decideCoverage(action, corpus);
      expect(result.covered).toBe(true);
      if (result.covered) {
        expect(result.evidence[0]?.policySource).toBe("decision-defaults.mdc");
      }
    });
  });

  describe("entry ordering", () => {
    it("returns evidence from first matching entry; later entries are not consulted", () => {
      const entry1 = makeEntry({
        source: "first.md",
        content: "Every new dependency must be approved.",
      });
      const entry2 = makeEntry({
        source: "second.md",
        content: "Every new dependency is permitted.",
      });
      const corpus = makeCorpus([entry1, entry2]);
      const action: ActionDescriptor = {
        reason: "new-dependency",
        detail: "x",
        filePath: "package.json",
      };
      const result = decideCoverage(action, corpus);
      expect(result.covered).toBe(true);
      if (result.covered) {
        expect(result.evidence[0]?.policySource).toBe("first.md");
        // Should only have one evidence entry — short-circuited
        expect(result.evidence).toHaveLength(1);
      }
    });

    it("skips entries with category 'unavailable'", () => {
      const unavailable = makeEntry({
        source: "broken.md",
        category: "unavailable",
        content: "Every new dependency must be approved.",
      });
      const corpus = makeCorpus([unavailable]);
      const action: ActionDescriptor = {
        reason: "new-dependency",
        detail: "x",
      };
      const result = decideCoverage(action, corpus);
      expect(result.covered).toBe(false);
    });
  });

  describe("empty corpus", () => {
    it("returns uncovered for an empty corpus", () => {
      const corpus = makeCorpus([]);
      const action: ActionDescriptor = {
        reason: "new-file",
        detail: "x",
        filePath: "src/foo.ts",
      };
      const result = decideCoverage(action, corpus);
      expect(result.covered).toBe(false);
    });
  });

  describe("internal helpers", () => {
    it("extractStatements splits paragraphs and list items", () => {
      const lines = [
        "Para one line one",
        "Para one line two",
        "",
        "- Item A",
        "- Item B",
        "",
        "Para two",
      ];
      const statements = __TEST_ONLY.extractStatements(lines);
      // Should produce: para1, item-A, item-B, para2 = 4 statements
      expect(statements).toHaveLength(4);
    });

    it("truncateSpan caps long text", () => {
      const long = "a".repeat(500);
      const truncated = __TEST_ONLY.truncateSpan(long);
      expect(truncated.length).toBeLessThanOrEqual(240);
      expect(truncated.endsWith("...")).toBe(true);
    });

    it("CATEGORY_KEYWORDS covers all five filter reasons", () => {
      const reasons: Array<keyof typeof __TEST_ONLY.CATEGORY_KEYWORDS> = [
        "new-file",
        "new-dependency",
        "new-config-key",
        "new-user-facing-string",
        "new-top-level-export",
      ];
      for (const r of reasons) {
        expect(__TEST_ONLY.CATEGORY_KEYWORDS[r].length).toBeGreaterThan(0);
      }
    });
  });
});
