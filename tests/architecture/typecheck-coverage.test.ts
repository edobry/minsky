/**
 * Tests for the typecheck-coverage invariant (mt#3780).
 *
 * The comparison logic is a pure function, so it is tested here against
 * synthetic file sets rather than by spawning ten compilers (mem#316 —
 * functional core, imperative shell). The real sweep runs as its own CI step
 * (`bun run check:typecheck-coverage`); what this file guards is that the
 * comparison and the allowlist schema behave correctly, including the failure
 * direction — a check that cannot fail is not verification (mem#704).
 */
import { describe, test, expect } from "bun:test";
import {
  COVERAGE_ALLOWLIST,
  attributeTreesToProjects,
  compareCoverage,
  isAllowlisted,
  treeOf,
  validateAllowlist,
  type AllowlistEntry,
} from "../../scripts/typecheck-coverage";

describe("compareCoverage", () => {
  test("a tracked file in no run project, with no allowlist entry, is a violation", () => {
    const result = compareCoverage(["src/a.ts", "orphan/b.ts"], new Set(["src/a.ts"]), []);

    expect(result.uncovered).toEqual(["orphan/b.ts"]);
    expect(result.allowlisted).toEqual([]);
  });

  test("an allowlisted file is reported separately, not as a violation", () => {
    const allowlist: AllowlistEntry[] = [{ prefix: "orphan/", reason: "tracked by mt#9999" }];

    const result = compareCoverage(["src/a.ts", "orphan/b.ts"], new Set(["src/a.ts"]), allowlist);

    expect(result.uncovered).toEqual([]);
    expect(result.allowlisted).toEqual(["orphan/b.ts"]);
  });

  test("full coverage yields no violations", () => {
    const result = compareCoverage(["src/a.ts"], new Set(["src/a.ts"]), []);

    expect(result.uncovered).toEqual([]);
    expect(result.allowlisted).toEqual([]);
  });

  test("an allowlist prefix matching nothing is reported as stale", () => {
    const allowlist: AllowlistEntry[] = [
      { prefix: "gone/", reason: "the gap this named is closed" },
    ];

    const result = compareCoverage(["src/a.ts"], new Set(["src/a.ts"]), allowlist);

    expect(result.unusedAllowlistPrefixes).toEqual(["gone/"]);
  });

  test("an exact-path allowlist entry matches only that file, not siblings", () => {
    const allowlist: AllowlistEntry[] = [{ prefix: "cfg/one.ts", reason: "just this one" }];

    const result = compareCoverage(["cfg/one.ts", "cfg/two.ts"], new Set(), allowlist);

    expect(result.allowlisted).toEqual(["cfg/one.ts"]);
    expect(result.uncovered).toEqual(["cfg/two.ts"]);
  });

  test("covering a file that was uncovered removes the violation — the fix direction", () => {
    const tracked = ["src/a.ts", "newly/b.ts"];

    const before = compareCoverage(tracked, new Set(["src/a.ts"]), []);
    const after = compareCoverage(tracked, new Set(["src/a.ts", "newly/b.ts"]), []);

    expect(before.uncovered).toEqual(["newly/b.ts"]);
    expect(after.uncovered).toEqual([]);
  });
});

describe("validateAllowlist", () => {
  test("an entry with no reason is rejected — an exclusion must be a recorded decision", () => {
    const problems = validateAllowlist([{ prefix: "orphan/", reason: "" }]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain("reason");
  });

  test("a whitespace-only reason is rejected too", () => {
    const problems = validateAllowlist([{ prefix: "orphan/", reason: "   " }]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain("reason");
  });

  test("an entry with a real reason passes", () => {
    expect(validateAllowlist([{ prefix: "orphan/", reason: "invalid by design" }])).toEqual([]);
  });

  test("the shipped allowlist is valid", () => {
    expect(validateAllowlist(COVERAGE_ALLOWLIST)).toEqual([]);
  });
});

describe("isAllowlisted", () => {
  test("matches a directory prefix and an exact path, but not an unrelated sibling", () => {
    const allowlist: AllowlistEntry[] = [
      { prefix: "tests/fixtures/", reason: "test data" },
      { prefix: "vite.config.ts", reason: "root build config" },
    ];

    expect(isAllowlisted("tests/fixtures/nested/x.ts", allowlist)).toBe(true);
    expect(isAllowlisted("vite.config.ts", allowlist)).toBe(true);
    expect(isAllowlisted("src/vite.config.ts", allowlist)).toBe(false);
    expect(isAllowlisted("tests/unit/x.test.ts", allowlist)).toBe(false);
  });
});

describe("treeOf", () => {
  test("groups by two directory segments, so sibling packages stay distinct", () => {
    expect(treeOf("packages/domain/src/tasks/x.ts")).toBe("packages/domain");
    expect(treeOf("packages/shared/src/x.ts")).toBe("packages/shared");
    expect(treeOf("src/cockpit/web/x.tsx")).toBe("src/cockpit");
  });

  test("a one-segment directory stays whole, and a root-level file groups under '.'", () => {
    expect(treeOf("scripts/x.ts")).toBe("scripts");
    expect(treeOf("vite.config.ts")).toBe(".");
  });
});

describe("attributeTreesToProjects", () => {
  const ROOT_PROJECT = "tsconfig.json";
  const DOMAIN_PROJECT = "packages/domain/tsconfig.json";
  const DOMAIN_TREE = "packages/domain";
  const SHARED_FILE = "packages/domain/src/c.ts";

  test("names the project covering each tree — SC4's legibility requirement", () => {
    const attribution = attributeTreesToProjects(
      new Map([
        [ROOT_PROJECT, ["src/adapters/a.ts", "tests/unit/b.ts"]],
        [DOMAIN_PROJECT, [SHARED_FILE]],
      ])
    );

    expect(attribution).toEqual([
      { tree: DOMAIN_TREE, projects: [DOMAIN_PROJECT], fileCount: 1 },
      { tree: "src/adapters", projects: [ROOT_PROJECT], fileCount: 1 },
      { tree: "tests/unit", projects: [ROOT_PROJECT], fileCount: 1 },
    ]);
  });

  test("a tree covered by several projects lists them all, and counts each file once", () => {
    const attribution = attributeTreesToProjects(
      new Map([
        [ROOT_PROJECT, [SHARED_FILE]],
        [DOMAIN_PROJECT, [SHARED_FILE, "packages/domain/src/d.ts"]],
      ])
    );

    expect(attribution).toEqual([
      {
        tree: DOMAIN_TREE,
        // Sorted, so the report is stable across runs rather than reflecting
        // whatever order the projects happened to be swept in.
        projects: [DOMAIN_PROJECT, ROOT_PROJECT],
        // 2, not 3: the shared file is claimed by both projects but is one file.
        fileCount: 2,
      },
    ]);
  });

  test("no projects yields no attribution rather than throwing", () => {
    expect(attributeTreesToProjects(new Map())).toEqual([]);
  });
});

describe("the shipped allowlist", () => {
  test("every temporary entry names a tracking task; permanent ones explain why they are permanent", () => {
    for (const entry of COVERAGE_ALLOWLIST) {
      if (entry.tracking !== undefined) {
        expect(entry.tracking).toMatch(/^mt#\d+$/);
      } else {
        // A permanent exclusion must say so in its reason — otherwise it reads
        // as an untracked gap that someone forgot to file.
        expect(entry.reason.toLowerCase()).toMatch(/by design|test data|excludes them/);
      }
    }
  });
});
