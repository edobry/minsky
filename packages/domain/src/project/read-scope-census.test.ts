/**
 * Read-scope census enforcement (mt#5155). See `read-scope-census.ts`.
 *
 * A failure here means a read site resolves project scope from the process
 * cwd directly. Route it through `resolveReadScope` (which honours the caller's
 * `workspace` / `repo` first) rather than adding it to the allowlist.
 */
import { describe, test, expect } from "bun:test";
import {
  CENSUS_ALLOWLIST,
  CWD_SCOPE_PATTERN,
  findCwdScopeSites,
  listCensusFiles,
} from "./read-scope-census";

describe("read-scope census (mt#5155)", () => {
  test("the census actually walks the served trees", () => {
    const files = listCensusFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("packages/domain/src/project/read-scope.ts");
    expect(files).toContain("src/mcp/server.ts");
  });

  test("the pattern matches the defect's shape and not an explicit-path resolution", () => {
    expect(CWD_SCOPE_PATTERN.test("resolveProjectIdentity({ repoPath: process.cwd() })")).toBe(
      true
    );
    // Prettier's multi-line spelling, trailing comma included.
    expect(CWD_SCOPE_PATTERN.test("resolveProjectIdentity({\n  repoPath: process.cwd(),\n})")).toBe(
      true
    );
    expect(CWD_SCOPE_PATTERN.test("resolveProjectIdentity({ repoPath: location })")).toBe(false);
    expect(CWD_SCOPE_PATTERN.test("resolveProjectIdentity({ repoPath })")).toBe(false);
  });

  test("no served read site resolves scope from process.cwd() outside the helper", () => {
    const allow = new Set(CENSUS_ALLOWLIST.map((e) => e.file));
    const offenders = findCwdScopeSites().filter((f) => !allow.has(f));
    expect(offenders).toEqual([]);
  });

  test("every allowlist entry is a live file that still carries the pattern", () => {
    const live = new Set(listCensusFiles());
    const sites = new Set(findCwdScopeSites());
    for (const entry of CENSUS_ALLOWLIST) {
      expect(live.has(entry.file)).toBe(true);
      expect(sites.has(entry.file)).toBe(true);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
