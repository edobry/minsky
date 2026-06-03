import { describe, test, expect } from "bun:test";
import path from "path";
import { findRepoRoot, cockpitWebDistDir, cockpitIndexHtml } from "./web-dist";

describe("cockpit web-dist resolution (mt#2283)", () => {
  const repo = path.join(path.sep, "repo");
  // Injected predicate: only `<repo>/src/cockpit/web` "exists" — no real fs.
  const exists = (p: string) => p === path.join(repo, "src", "cockpit", "web");

  test("findRepoRoot ascends from a bundle location (<repo>/dist) to the repo", () => {
    expect(findRepoRoot([path.join(repo, "dist")], exists)).toBe(repo);
  });

  test("findRepoRoot ascends from a source location to the repo", () => {
    expect(findRepoRoot([path.join(repo, "src", "commands", "cockpit")], exists)).toBe(repo);
    expect(findRepoRoot([path.join(repo, "src", "cockpit")], exists)).toBe(repo);
  });

  test("findRepoRoot returns the repo when it is the start dir", () => {
    expect(findRepoRoot([repo], exists)).toBe(repo);
  });

  test("findRepoRoot returns undefined when no ancestor contains src/cockpit/web", () => {
    expect(findRepoRoot([path.join(path.sep, "elsewhere", "deep")], () => false)).toBeUndefined();
  });

  test("helpers compose web-dist + index.html under the resolved root", () => {
    const moduleDir = path.join(repo, "dist");
    expect(cockpitWebDistDir(moduleDir, exists)).toBe(
      path.join(repo, "src", "cockpit", "web", "dist")
    );
    expect(cockpitIndexHtml(moduleDir, exists)).toBe(
      path.join(repo, "src", "cockpit", "web", "dist", "index.html")
    );
  });
});
