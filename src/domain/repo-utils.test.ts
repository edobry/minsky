import { describe, test, expect } from "bun:test";
import { resolveRepoPath, normalizeRepoName } from "./repo-utils";

describe("Repo Utils", () => {
  test("normalizeRepoName extracts repo name from URL", () => {
    expect(normalizeRepoName("https://github.com/user/repo.git")).toBe("user/repo");
    expect(normalizeRepoName("https://github.com/user/repo")).toBe("user/repo");
    expect(normalizeRepoName("git@github.com:user/repo.git")).toBe("user/repo");
    expect(normalizeRepoName("git@github.com:user/repo")).toBe("user/repo");
    expect(normalizeRepoName("/path/to/repo")).toBe("local/repo");
    expect(normalizeRepoName("file:///path/to/repo")).toBe("local/repo");
  });

  test("resolveRepoPath uses provided repo path", async () => {
    const result = await resolveRepoPath({ repo: "/test/path" });
    expect(result).toBe("/test/path");
  });
});
