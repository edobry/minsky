/**
 * Tests for the changeset id codec (mt#4724).
 *
 * The load-bearing property is the BACK-COMPAT one: a bare number must keep
 * parsing to "the default project's PR N", because every already-emitted
 * `minsky://changeset/<n>` link says exactly that and ADR-029 fixes the emitted
 * form. The qualified form is the new capability layered beside it.
 */
import { describe, test, expect } from "bun:test";
import {
  parseChangesetId,
  formatChangesetId,
  parseGitHubRepoRef,
  repoRefFromProjectSlug,
  repoUrlFromRepoRef,
  sameRepoRef,
  changesetIdFor,
  isChangesetId,
} from "./changeset-id";

/** The canonical cross-project example: a PR #1 that is NOT the default repo's PR #1. */
const PEEZOMBIE_PR1 = "edobry/peezombie.me#1";

describe("parseChangesetId — bare form", () => {
  test("parses a bare PR number with no repo (default project)", () => {
    expect(parseChangesetId("1")).toEqual({ repo: null, prNumber: 1, canonical: "1" });
    expect(parseChangesetId("3423")).toEqual({ repo: null, prNumber: 3423, canonical: "3423" });
  });

  test("rejects zero, negatives, decimals and non-numeric junk", () => {
    for (const raw of ["0", "-1", "1.5", "abc", "", "  ", "#1", "1#"]) {
      expect(parseChangesetId(raw)).toBeNull();
    }
  });
});

describe("parseChangesetId — qualified form", () => {
  test("parses owner/repo#N (mt#1207's convention)", () => {
    expect(parseChangesetId(PEEZOMBIE_PR1)).toEqual({
      repo: { owner: "edobry", repo: "peezombie.me" },
      prNumber: 1,
      canonical: PEEZOMBIE_PR1,
    });
  });

  test("accepts dots, dashes and underscores in the repo segment", () => {
    expect(parseChangesetId("some-org/my_repo.js#42")?.repo).toEqual({
      owner: "some-org",
      repo: "my_repo.js",
    });
  });

  test("rejects malformed qualified spellings", () => {
    for (const raw of [
      "edobry/peezombie.me#0",
      "edobry/peezombie.me",
      "edobry#1",
      "edobry/a/b#1",
      "/repo#1",
      "owner/#1",
      "owner/repo#abc",
    ]) {
      expect(parseChangesetId(raw)).toBeNull();
    }
  });

  test("isChangesetId agrees with parseChangesetId", () => {
    expect(isChangesetId("1")).toBe(true);
    expect(isChangesetId("edobry/minsky#7")).toBe(true);
    expect(isChangesetId("nope")).toBe(false);
  });
});

describe("formatChangesetId", () => {
  test("null repo yields the bare form", () => {
    expect(formatChangesetId(null, 12)).toBe("12");
  });

  test("a repo yields owner/repo#N", () => {
    expect(formatChangesetId({ owner: "edobry", repo: "minsky" }, 12)).toBe("edobry/minsky#12");
  });

  test("round-trips through parseChangesetId", () => {
    const id = formatChangesetId({ owner: "edobry", repo: "peezombie.me" }, 1);
    expect(parseChangesetId(id)?.canonical).toBe(id);
  });
});

describe("parseGitHubRepoRef", () => {
  test("https, with and without .git and trailing slash", () => {
    const expected = { owner: "edobry", repo: "minsky" };
    expect(parseGitHubRepoRef("https://github.com/edobry/minsky.git")).toEqual(expected);
    expect(parseGitHubRepoRef("https://github.com/edobry/minsky")).toEqual(expected);
    expect(parseGitHubRepoRef("https://github.com/edobry/minsky/")).toEqual(expected);
  });

  test("ssh forms", () => {
    const expected = { owner: "edobry", repo: "peezombie.me" };
    expect(parseGitHubRepoRef("git@github.com:edobry/peezombie.me.git")).toEqual(expected);
    expect(parseGitHubRepoRef("ssh://git@github.com/edobry/peezombie.me.git")).toEqual(expected);
  });

  test("non-GitHub and empty remotes yield null", () => {
    expect(parseGitHubRepoRef("https://gitlab.com/edobry/minsky.git")).toBeNull();
    expect(parseGitHubRepoRef("/local/path/repo")).toBeNull();
    expect(parseGitHubRepoRef(null)).toBeNull();
    expect(parseGitHubRepoRef(undefined)).toBeNull();
  });
});

describe("repoRefFromProjectSlug", () => {
  test("owner/repo slugs parse", () => {
    expect(repoRefFromProjectSlug("edobry/peezombie.me")).toEqual({
      owner: "edobry",
      repo: "peezombie.me",
    });
  });

  test("non-owner/repo slugs yield null rather than a bogus ref", () => {
    expect(repoRefFromProjectSlug("just-a-name")).toBeNull();
    expect(repoRefFromProjectSlug("a/b/c")).toBeNull();
    expect(repoRefFromProjectSlug(undefined)).toBeNull();
  });
});

describe("repoUrlFromRepoRef / sameRepoRef", () => {
  test("builds the canonical https clone url", () => {
    expect(repoUrlFromRepoRef({ owner: "edobry", repo: "minsky" })).toBe(
      "https://github.com/edobry/minsky.git"
    );
  });

  test("sameRepoRef is case-insensitive and null-safe", () => {
    expect(
      sameRepoRef({ owner: "Edobry", repo: "Minsky" }, { owner: "edobry", repo: "minsky" })
    ).toBe(true);
    expect(
      sameRepoRef({ owner: "edobry", repo: "minsky" }, { owner: "edobry", repo: "other" })
    ).toBe(false);
    expect(sameRepoRef(null, { owner: "edobry", repo: "minsky" })).toBe(false);
    expect(sameRepoRef({ owner: "edobry", repo: "minsky" }, null)).toBe(false);
  });
});

describe("changesetIdFor — the back-compat rule", () => {
  const defaultRepo = { owner: "edobry", repo: "minsky" };

  test("a PR in the DEFAULT repo keeps its bare id (already-emitted links keep resolving)", () => {
    expect(changesetIdFor("https://github.com/edobry/minsky.git", 3423, defaultRepo)).toBe("3423");
    expect(changesetIdFor("git@github.com:edobry/minsky.git", 3423, defaultRepo)).toBe("3423");
  });

  test("a PR in another repo is qualified", () => {
    expect(changesetIdFor("https://github.com/edobry/peezombie.me.git", 1, defaultRepo)).toBe(
      PEEZOMBIE_PR1
    );
  });

  test("two projects sharing PR #1 get DISTINCT ids", () => {
    const a = changesetIdFor("https://github.com/edobry/minsky.git", 1, defaultRepo);
    const b = changesetIdFor("https://github.com/edobry/peezombie.me.git", 1, defaultRepo);
    expect(a).not.toBe(b);
  });

  test("an unparseable repo url degrades to the bare id rather than inventing a qualifier", () => {
    expect(changesetIdFor(null, 5, defaultRepo)).toBe("5");
    expect(changesetIdFor("/some/local/path", 5, defaultRepo)).toBe("5");
  });

  test("with no default repo known, every parseable repo is qualified", () => {
    expect(changesetIdFor("https://github.com/edobry/minsky.git", 3423, null)).toBe(
      "edobry/minsky#3423"
    );
  });
});
