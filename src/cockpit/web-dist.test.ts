import { describe, test, expect } from "bun:test";
import path from "path";
import { cockpitWebDistDir, cockpitIndexHtml } from "./web-dist";

describe("cockpit web-dist resolution (mt#2283)", () => {
  // Inject the repo root explicitly (the rule forbids process.cwd() in tests).
  // At runtime the daemon's cwd IS the repo root (mt#2282 / launchd contract),
  // which is the default arg exercised by the live verification, not here.
  test("resolves web-dist + index.html under the given repo root", () => {
    const repo = "/Users/x/Projects/minsky";
    expect(cockpitWebDistDir(repo)).toBe(path.join(repo, "src", "cockpit", "web", "dist"));
    expect(cockpitIndexHtml(repo)).toBe(
      path.join(repo, "src", "cockpit", "web", "dist", "index.html")
    );
  });

  test("index.html is nested inside the web-dist dir", () => {
    const repo = "/tmp/example-repo";
    expect(cockpitIndexHtml(repo)).toBe(path.join(cockpitWebDistDir(repo), "index.html"));
  });
});
