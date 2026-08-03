/**
 * Unit coverage for the doc-impact replay harness's evidence classifier (mt#3527).
 *
 * The harness reports whether a verdict's `evidence` actually quotes the doc
 * sentence the diff falsifies — the artifact the invalidation instruction asks
 * for, and the difference between a finding an author can act on and one that
 * only names a file. That classification has to be mechanical, or the
 * before/after measurement becomes a reading exercise.
 *
 * Importing this module is safe: `replay-doc-impact.ts` guards its entrypoint
 * behind `import.meta.main`, so no replay runs here.
 */

import { describe, expect, test } from "bun:test";

import { evidenceQuotesDocProse, resolveRepoCoordinates } from "./replay-doc-impact";

describe("evidenceQuotesDocProse", () => {
  test("detects a straight-quoted doc sentence", () => {
    const evidence =
      'docs/principal-channel.md still opens with "One standing driven session — a long-lived ' +
      'claude conversation, reused across messages", which this PR falsifies.';
    expect(evidenceQuotesDocProse(evidence)).toBe(true);
  });

  test("detects a curly-quoted doc sentence", () => {
    const evidence =
      "The doc asserts “the channel reuses one conversation across every message”, no longer true.";
    expect(evidenceQuotesDocProse(evidence)).toBe(true);
  });

  test("detects a backticked prose span", () => {
    const evidence =
      "Stale line: `One standing driven session, reused across messages` in docs/principal-channel.md.";
    expect(evidenceQuotesDocProse(evidence)).toBe(true);
  });

  test("does NOT count a bare identifier in backticks as quoted prose", () => {
    // This is the shape of an additive finding — it names a symbol, not a claim.
    const evidence = "Existing `docs/principal-channel.md` omits `/bind`.";
    expect(evidenceQuotesDocProse(evidence)).toBe(false);
  });

  test("does NOT count the PR #2508 miss's evidence as quoted prose", () => {
    // Verbatim from PR #2508's fourth review — the reasoning under test.
    const evidence =
      "This PR implements internal transport fields, DB schema, and cockpit daemon behavior " +
      "for Telegram topic-mode without changing any public CLI, HTTP API, or documented " +
      "operator workflows. No docs in-repo reference these new internals.";
    expect(evidenceQuotesDocProse(evidence)).toBe(false);
  });

  test("handles empty evidence without throwing", () => {
    expect(evidenceQuotesDocProse("")).toBe(false);
  });

  test("does not treat an apostrophe pair spanning words as a quote", () => {
    // Two apostrophes far apart would otherwise look like a quoted span.
    const evidence = "The reviewer's verdict rests on the author's summary, not on a doc read.";
    expect(evidenceQuotesDocProse(evidence)).toBe(false);
  });
});

describe("resolveRepoCoordinates", () => {
  test("falls back to the documented default when nothing is supplied", () => {
    expect(resolveRepoCoordinates([], {})).toEqual({ owner: "edobry", repo: "minsky" });
  });

  test("reads GITHUB_REPOSITORY", () => {
    expect(resolveRepoCoordinates([], { GITHUB_REPOSITORY: "acme/widgets" })).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  test("flags win over the environment", () => {
    expect(
      resolveRepoCoordinates(["--owner=fork-owner", "--repo=fork-repo"], {
        GITHUB_REPOSITORY: "acme/widgets",
      })
    ).toEqual({ owner: "fork-owner", repo: "fork-repo" });
  });

  test("a partial flag override keeps the other half from the environment", () => {
    expect(
      resolveRepoCoordinates(["--repo=mirror"], { GITHUB_REPOSITORY: "acme/widgets" })
    ).toEqual({ owner: "acme", repo: "mirror" });
  });

  test("ignores a malformed GITHUB_REPOSITORY rather than splitting it wrongly", () => {
    // No slash: not "owner/repo", so it tells us nothing about either half.
    expect(resolveRepoCoordinates([], { GITHUB_REPOSITORY: "widgets" })).toEqual({
      owner: "edobry",
      repo: "minsky",
    });
  });

  test("ignores an empty flag value instead of resolving to an empty owner", () => {
    expect(resolveRepoCoordinates(["--owner="], { GITHUB_REPOSITORY: "acme/widgets" })).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });
});
