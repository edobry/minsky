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

describe("cockpit web-dist bundled-install candidate (mt#3611)", () => {
  const install = path.join(path.sep, "install");
  const moduleDir = path.join(install, "dist");
  const bundledIndex = path.join(moduleDir, "cockpit-web", "index.html");
  // Only the bundled-install index.html "exists" — no `src/cockpit/web`
  // anywhere, simulating a packaged install with no source checkout at all.
  const exists = (p: string) => p === bundledIndex;

  test("resolves the bundled-install layout when it exists, with no ascent", () => {
    expect(cockpitWebDistDir(moduleDir, exists)).toBe(path.join(moduleDir, "cockpit-web"));
    expect(cockpitIndexHtml(moduleDir, exists)).toBe(bundledIndex);
  });

  test("bundled-install candidate is checked before the dev-checkout walk", () => {
    // Both the bundled index.html AND a dev-checkout `src/cockpit/web`
    // reachable by ascending from moduleDir "exist" here — proving the
    // bundled candidate wins on check ORDER, not merely because it's the
    // only one present.
    const devRoot = path.dirname(moduleDir); // ascends to `install` from `install/dist`
    const both = (p: string) =>
      p === bundledIndex || p === path.join(devRoot, "src", "cockpit", "web");
    expect(cockpitWebDistDir(moduleDir, both)).toBe(path.join(moduleDir, "cockpit-web"));
  });

  test("falls through to the dev-checkout walk when the bundled candidate is absent", () => {
    const devRoot = path.dirname(moduleDir);
    const devOnly = (p: string) => p === path.join(devRoot, "src", "cockpit", "web");
    expect(cockpitWebDistDir(moduleDir, devOnly)).toBe(
      path.join(devRoot, "src", "cockpit", "web", "dist")
    );
  });

  test("without a moduleDir, only the dev-checkout walk runs and does not throw", () => {
    // No moduleDir means no bundled candidate can even be constructed. With
    // nothing "existing", it falls back to the documented cwd-based "not
    // built" path — asserted by suffix so the test stays cwd-independent.
    const result = cockpitWebDistDir(undefined, () => false);
    expect(result.endsWith(path.join("src", "cockpit", "web", "dist"))).toBe(true);
  });
});
