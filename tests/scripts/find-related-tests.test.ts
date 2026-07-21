import { describe, test, expect } from "bun:test";
import { createMockFilesystem } from "../../src/utils/test-utils/filesystem/mock-filesystem";
import {
  extractImportSpecifiers,
  resolveRelativeSpecifier,
  resolvePackageSpecifier,
  loadPackageExportsMaps,
  discoverWorkspacePackageDirs,
  findRelatedTestFiles,
  type FsLike,
} from "../../scripts/find-related-tests";

// mt#2932: all filesystem access here goes through the injectable FsLike
// (createMockFilesystem, an in-memory mock) rather than real disk I/O --
// this is the dependency-injection shape eslint-rules/no-real-fs-in-tests.js
// requires for test files.

describe("extractImportSpecifiers (mt#2932)", () => {
  test("extracts static import/export-from specifiers", () => {
    const content = [
      'import { foo } from "./foo";',
      "import bar from '../bar';",
      'export { baz } from "./baz";',
    ].join("\n");
    expect(extractImportSpecifiers(content)).toEqual(["./foo", "../bar", "./baz"]);
  });

  test("extracts require() and dynamic import() specifiers", () => {
    const content = ['const x = require("./x");', 'const y = await import("./y");'].join("\n");
    expect(extractImportSpecifiers(content).sort()).toEqual(["./x", "./y"]);
  });

  test("dedupes repeated specifiers", () => {
    const content = 'import { a } from "./mod";\nimport { b } from "./mod";';
    expect(extractImportSpecifiers(content)).toEqual(["./mod"]);
  });

  test("returns empty array for content with no imports", () => {
    expect(extractImportSpecifiers("const x = 1;")).toEqual([]);
  });
});

describe("resolvePackageSpecifier (mt#2932)", () => {
  const pkgExportsMap = new Map([
    [
      "@minsky/domain",
      {
        name: "@minsky/domain",
        root: "packages/domain",
        exports: { "./errors": "./src/errors/index.ts", "./*": "./src/*.ts" },
      },
    ],
    [
      "@minsky/shared",
      {
        name: "@minsky/shared",
        root: "packages/shared",
        exports: { ".": "./src/index.ts", "./logger": "./src/logger.ts" },
      },
    ],
  ]);

  test("resolves an exact explicit export entry", () => {
    expect(resolvePackageSpecifier("@minsky/domain/errors", pkgExportsMap)).toBe(
      "packages/domain/src/errors/index.ts"
    );
  });

  test("resolves via a wildcard export pattern", () => {
    expect(resolvePackageSpecifier("@minsky/domain/session", pkgExportsMap)).toBe(
      "packages/domain/src/session.ts"
    );
  });

  test('resolves the bare package root export (".")', () => {
    expect(resolvePackageSpecifier("@minsky/shared", pkgExportsMap)).toBe(
      "packages/shared/src/index.ts"
    );
  });

  test("resolves an explicit subpath export (no wildcard needed)", () => {
    expect(resolvePackageSpecifier("@minsky/shared/logger", pkgExportsMap)).toBe(
      "packages/shared/src/logger.ts"
    );
  });

  test("returns null for an unresolvable / external specifier", () => {
    expect(resolvePackageSpecifier("lodash", pkgExportsMap)).toBeNull();
    expect(resolvePackageSpecifier("@minsky/unknown-pkg/x", pkgExportsMap)).toBeNull();
  });
});

describe("discoverWorkspacePackageDirs (mt#2932, mock filesystem)", () => {
  const repoRoot = "/repo";

  test("expands a `<dir>/*` glob entry to its concrete subdirectories", () => {
    const mockFs = createMockFilesystem({
      [`${repoRoot}/package.json`]: JSON.stringify({ workspaces: ["packages/*"] }),
      [`${repoRoot}/packages/domain/package.json`]: JSON.stringify({ name: "@minsky/domain" }),
      [`${repoRoot}/packages/shared/package.json`]: JSON.stringify({ name: "@minsky/shared" }),
    });
    const dirs = discoverWorkspacePackageDirs(repoRoot, mockFs as unknown as FsLike);
    expect(dirs.sort()).toEqual(["packages/domain", "packages/shared"]);
  });

  test("keeps a literal (non-glob) workspaces entry as-is", () => {
    const mockFs = createMockFilesystem({
      [`${repoRoot}/package.json`]: JSON.stringify({ workspaces: ["packages/domain"] }),
      [`${repoRoot}/packages/domain/package.json`]: JSON.stringify({ name: "@minsky/domain" }),
    });
    const dirs = discoverWorkspacePackageDirs(repoRoot, mockFs as unknown as FsLike);
    expect(dirs).toEqual(["packages/domain"]);
  });

  test("returns an empty list when the root package.json is missing", () => {
    const mockFs = createMockFilesystem({});
    expect(discoverWorkspacePackageDirs(repoRoot, mockFs as unknown as FsLike)).toEqual([]);
  });

  test("returns an empty list when workspaces is absent", () => {
    const mockFs = createMockFilesystem({
      [`${repoRoot}/package.json`]: JSON.stringify({ name: "root" }),
    });
    expect(discoverWorkspacePackageDirs(repoRoot, mockFs as unknown as FsLike)).toEqual([]);
  });
});

describe("loadPackageExportsMaps (mt#2932, mock filesystem)", () => {
  test("loads @minsky/domain and @minsky/shared package.json exports maps via workspaces glob", () => {
    const repoRoot = "/repo";
    const mockFs = createMockFilesystem({
      [`${repoRoot}/package.json`]: JSON.stringify({ workspaces: ["packages/*"] }),
      [`${repoRoot}/packages/domain/package.json`]: JSON.stringify({
        name: "@minsky/domain",
        exports: { "./errors": "./src/errors/index.ts" },
      }),
      [`${repoRoot}/packages/shared/package.json`]: JSON.stringify({
        name: "@minsky/shared",
        exports: { ".": "./src/index.ts" },
      }),
    });
    const map = loadPackageExportsMaps(repoRoot, mockFs as unknown as FsLike);
    expect(map.has("@minsky/domain")).toBe(true);
    expect(map.has("@minsky/shared")).toBe(true);
  });

  test("picks up a NEW workspace package with no code changes to this module", () => {
    // Reviewer finding (PR #2117): the old hardcoded candidateDirs list would
    // silently miss a newly-added @minsky/* package. Confirm a package not
    // present in any prior fixture is still discovered via the glob.
    const repoRoot = "/repo";
    const mockFs = createMockFilesystem({
      [`${repoRoot}/package.json`]: JSON.stringify({ workspaces: ["packages/*"] }),
      [`${repoRoot}/packages/new-thing/package.json`]: JSON.stringify({
        name: "@minsky/new-thing",
        exports: { ".": "./src/index.ts" },
      }),
    });
    const map = loadPackageExportsMaps(repoRoot, mockFs as unknown as FsLike);
    expect(map.has("@minsky/new-thing")).toBe(true);
  });

  test("skips a missing package.json without throwing", () => {
    const repoRoot = "/repo";
    const mockFs = createMockFilesystem({});
    const map = loadPackageExportsMaps(repoRoot, mockFs as unknown as FsLike);
    expect(map.size).toBe(0);
  });
});

describe("resolveRelativeSpecifier + findRelatedTestFiles (mt#2932, mock filesystem)", () => {
  const repoRoot = "/repo";

  function buildFixtureFs() {
    return createMockFilesystem({
      [`${repoRoot}/src/foo.ts`]: "export const foo = 1;\n",
      [`${repoRoot}/src/foo.test.ts`]: 'import { foo } from "./foo";\ntest("foo", () => foo);\n',
      [`${repoRoot}/src/bar.ts`]: 'import { foo } from "./foo";\nexport const bar = foo + 1;\n',
      [`${repoRoot}/src/bar.test.ts`]: 'import { bar } from "./bar";\ntest("bar", () => bar);\n',
      [`${repoRoot}/src/nested/index.ts`]: "export const nested = true;\n",
      [`${repoRoot}/src/uses-index.ts`]:
        'import { nested } from "./nested";\nexport const usesIndex = nested;\n',
    });
  }

  test("resolveRelativeSpecifier resolves an extensionless sibling import", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    expect(resolveRelativeSpecifier("src/bar.ts", "./foo", repoRoot, fs)).toBe("src/foo.ts");
  });

  test("resolveRelativeSpecifier resolves a directory import via index.ts", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    expect(resolveRelativeSpecifier("src/uses-index.ts", "./nested", repoRoot, fs)).toBe(
      "src/nested/index.ts"
    );
  });

  test("resolveRelativeSpecifier returns null for a nonexistent specifier", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    expect(resolveRelativeSpecifier("src/bar.ts", "./nope", repoRoot, fs)).toBeNull();
  });

  test("a changed non-test file finds its sibling test AND transitive importers' tests", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const related = findRelatedTestFiles(["src/foo.ts"], repoRoot, { fs });
    // foo.test.ts: sibling. bar.test.ts: bar.ts imports foo.ts (depth 1),
    // bar.test.ts imports bar.ts (depth 2) -- exercises the graph walk, not
    // just the sibling heuristic.
    expect(related).toEqual(["src/bar.test.ts", "src/foo.test.ts"]);
  });

  test("a changed test file is related to itself", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    expect(findRelatedTestFiles(["src/bar.test.ts"], repoRoot, { fs })).toEqual([
      "src/bar.test.ts",
    ]);
  });

  test("a changed file with no test anywhere in its dependency chain returns empty", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    // nested/index.ts has no sibling test and no test file imports it (only
    // uses-index.ts does, which is not itself a test).
    expect(findRelatedTestFiles(["src/nested/index.ts"], repoRoot, { fs })).toEqual([]);
  });

  test("ignores non-.ts/.tsx changed files", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    expect(findRelatedTestFiles(["README.md", "package.json"], repoRoot, { fs })).toEqual([]);
  });

  test("ignores a changed path that does not exist on disk", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    expect(findRelatedTestFiles(["src/does-not-exist.ts"], repoRoot, { fs })).toEqual([]);
  });

  test("respects maxDepth: a depth-1 walk misses a depth-2-only related test", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const related = findRelatedTestFiles(["src/foo.ts"], repoRoot, { fs, maxDepth: 1 });
    // bar.ts (depth 1, not a test) is reached, but bar.test.ts (depth 2) is not.
    expect(related).toEqual(["src/foo.test.ts"]);
  });
});
