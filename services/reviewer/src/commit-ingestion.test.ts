import { describe, test, expect } from "bun:test";
import { ingestCommitMessagesSinceLastReview } from "./commit-ingestion";
import type { PullRequestCommit } from "./github-client";
import type { Octokit } from "@octokit/rest";

const FAKE_OCTOKIT = {} as Octokit;

describe("ingestCommitMessagesSinceLastReview", () => {
  test("returns messages and a rendered markdown block on success", async () => {
    const commits: PullRequestCommit[] = [
      { sha: "aaaaaaaaaaaa", message: "fix(mt#2789): add PG17 psql transcript" },
      { sha: "bbbbbbbbbbbb", message: "test: pin GREATEST regression case" },
    ];
    const result = await ingestCommitMessagesSinceLastReview({
      fetcher: async () => commits,
      octokit: FAKE_OCTOKIT,
      owner: "owner",
      repo: "repo",
      prNumber: 1,
      sinceIso: "2026-07-15T00:00:00Z",
    });

    expect(result.error).toBeUndefined();
    expect(result.messages).toEqual([
      "fix(mt#2789): add PG17 psql transcript",
      "test: pin GREATEST regression case",
    ]);
    expect(result.markdown).toContain("## Commits Since Last Review (2)");
    expect(result.markdown).toContain("aaaaaaaa");
    expect(result.markdown).toContain("PG17 psql transcript");
  });

  test("returns an empty, non-error result when there are no commits", async () => {
    const result = await ingestCommitMessagesSinceLastReview({
      fetcher: async () => [],
      octokit: FAKE_OCTOKIT,
      owner: "owner",
      repo: "repo",
      prNumber: 1,
      sinceIso: "2026-07-15T00:00:00Z",
    });

    expect(result.error).toBeUndefined();
    expect(result.messages).toEqual([]);
    expect(result.markdown).toBe("");
  });

  test("degrades gracefully and reports the error when the fetch throws", async () => {
    const result = await ingestCommitMessagesSinceLastReview({
      fetcher: async () => {
        throw new Error("GitHub API rate limit exceeded");
      },
      octokit: FAKE_OCTOKIT,
      owner: "owner",
      repo: "repo",
      prNumber: 1,
      sinceIso: "2026-07-15T00:00:00Z",
    });

    expect(result.error).toBe("GitHub API rate limit exceeded");
    expect(result.messages).toEqual([]);
    expect(result.markdown).toBe("");
  });

  test("omits commits beyond the markdown cap but keeps them in the raw messages array", async () => {
    const commits: PullRequestCommit[] = Array.from({ length: 35 }, (_, i) => ({
      sha: `sha${i}`.padEnd(12, "0"),
      message: `commit number ${i}`,
    }));
    const result = await ingestCommitMessagesSinceLastReview({
      fetcher: async () => commits,
      octokit: FAKE_OCTOKIT,
      owner: "owner",
      repo: "repo",
      prNumber: 1,
      sinceIso: "2026-07-15T00:00:00Z",
    });

    expect(result.messages).toHaveLength(35);
    expect(result.markdown).toContain("older commit");
  });
});
