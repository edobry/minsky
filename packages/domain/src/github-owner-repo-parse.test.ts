/**
 * Regression tests for `parseGitHubOwnerRepo` (mt#4671).
 *
 * Eight call sites across four modules captured the repo segment as `([^.]+)`,
 * which stops at the first dot — so any repository whose NAME contains a dot
 * parsed wrong. `edobry/minsky` has no dot, which is why a year of
 * single-project use never surfaced it; onboarding `edobry/peezombie.me` did,
 * immediately.
 */
import { describe, test, expect } from "bun:test";
import { parseGitHubOwnerRepo } from "./uri-utils";
import { extractOwnerRepo } from "./project/slug";

describe("parseGitHubOwnerRepo (mt#4671)", () => {
  describe("dotted repository names — the originating defect", () => {
    const dotted: Array<[string, string]> = [
      ["https://github.com/edobry/peezombie.me.git", "peezombie.me"],
      ["https://github.com/edobry/peezombie.me", "peezombie.me"],
      ["git@github.com:edobry/peezombie.me.git", "peezombie.me"],
      ["git@github.com:edobry/peezombie.me", "peezombie.me"],
      ["https://github.com/socketio/socket.io.git", "socket.io"],
      ["https://github.com/foo/a.b.c.d.git", "a.b.c.d"],
    ];
    for (const [url, expected] of dotted) {
      test(`${url} -> ${expected}`, () => {
        expect(parseGitHubOwnerRepo(url)?.repo).toBe(expected);
      });
    }
  });

  describe("undotted names are unchanged (no regression)", () => {
    const plain: Array<[string, string]> = [
      ["https://github.com/edobry/minsky.git", "minsky"],
      ["https://github.com/edobry/minsky", "minsky"],
      ["git@github.com:edobry/minsky.git", "minsky"],
      ["git@github.com:edobry/minsky", "minsky"],
    ];
    for (const [url, expected] of plain) {
      test(`${url} -> ${expected}`, () => {
        expect(parseGitHubOwnerRepo(url)?.repo).toBe(expected);
      });
    }
  });

  test("a dotted OWNER round-trips — repository/github.ts:153 captured this as ([^.]+) too", () => {
    expect(parseGitHubOwnerRepo("https://github.com/my.org/my.repo.git")).toEqual({
      owner: "my.org",
      repo: "my.repo",
    });
  });

  test("owner is parsed alongside repo", () => {
    expect(parseGitHubOwnerRepo("https://github.com/edobry/peezombie.me.git")).toEqual({
      owner: "edobry",
      repo: "peezombie.me",
    });
  });

  describe("non-GitHub and malformed input returns null — callers fall through on it", () => {
    for (const url of [
      "",
      "https://gitlab.com/edobry/peezombie.me.git",
      "/Users/edobry/Projects/peezombie.me",
      "not a url at all",
    ]) {
      test(JSON.stringify(url), () => {
        expect(parseGitHubOwnerRepo(url)).toBeNull();
      });
    }
  });

  describe("query strings and fragments — reviewer finding, PR #3408", () => {
    // Before this, `([^/]+)` swallowed the query so `.git$` never matched and
    // the suffix survived into the repo name.
    test("query string does not defeat .git stripping", () => {
      expect(parseGitHubOwnerRepo("https://github.com/o/r.git?foo=1")?.repo).toBe("r");
    });
    test("fragment does not defeat .git stripping", () => {
      expect(parseGitHubOwnerRepo("https://github.com/o/r.git#frag")?.repo).toBe("r");
    });
    test("a dotted name with a query keeps its dots", () => {
      expect(parseGitHubOwnerRepo("https://github.com/edobry/peezombie.me.git?x=1")?.repo).toBe(
        "peezombie.me"
      );
    });
  });

  test("extra path segments still yield the repo (permissive, as before the fix)", () => {
    expect(parseGitHubOwnerRepo("https://github.com/edobry/peezombie.me/pull/1")?.repo).toBe(
      "peezombie.me"
    );
  });
});

describe("extractOwnerRepo is unchanged by the convergence (mt#4671)", () => {
  // slug.ts was already correct — it is why `project.slug` resolved to
  // `edobry/peezombie.me` and project isolation worked while every
  // GitHub-backend path was truncating. Assert it stays that way.
  test("dotted repo", () => {
    expect(extractOwnerRepo("https://github.com/edobry/peezombie.me.git")).toBe(
      "edobry/peezombie.me"
    );
  });
  test("undotted repo", () => {
    expect(extractOwnerRepo("https://github.com/edobry/minsky.git")).toBe("edobry/minsky");
  });
});
