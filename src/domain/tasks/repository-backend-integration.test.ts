/**
 * Repository Backend Integration Tests
 * Tests for Task #357: Integrate GitHub Issues Backend with Repository Backend Architecture
 *
 * Note: LOCAL and REMOTE backend types have been removed (mt#880).
 * Only GITHUB is supported.
 */

import { describe, test, expect } from "bun:test";
import {
  validateTaskBackendCompatibility,
  getCompatibleTaskBackends,
  isTaskBackendCompatible,
} from "./taskBackendCompatibility";
import { RepositoryBackendType } from "../repository/index";

describe("Task Backend Compatibility Validation", () => {
  test("should allow minsky backend with GitHub repository backend", () => {
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.GITHUB, "minsky")
    ).not.toThrow();
  });

  test("should allow github-issues backend only with GitHub repository backend", () => {
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.GITHUB, "github-issues")
    ).not.toThrow();
  });
});

describe("Compatible Task Backends Detection", () => {
  test("should return correct compatible backends for GitHub repository type", () => {
    expect(getCompatibleTaskBackends(RepositoryBackendType.GITHUB)).toEqual([
      "minsky",
      "github-issues",
    ]);
  });

  test("should correctly identify backend compatibility for GitHub", () => {
    expect(isTaskBackendCompatible(RepositoryBackendType.GITHUB, "minsky")).toBe(true);
    expect(isTaskBackendCompatible(RepositoryBackendType.GITHUB, "github-issues")).toBe(true);
  });
});

describe("GitHub URL Parsing", () => {
  test("should parse SSH GitHub URLs correctly", async () => {
    const { extractGitHubInfoFromRepoUrl } = await import("./taskService");
    const result = extractGitHubInfoFromRepoUrl("git@github.com:edobry/minsky.git");
    expect(result).toEqual({ owner: "edobry", repo: "minsky" });
  });

  test("should parse HTTPS GitHub URLs correctly", async () => {
    const { extractGitHubInfoFromRepoUrl } = await import("./taskService");
    const result = extractGitHubInfoFromRepoUrl("https://github.com/edobry/minsky.git");
    expect(result).toEqual({ owner: "edobry", repo: "minsky" });
  });

  test("should handle URLs without .git suffix", async () => {
    const { extractGitHubInfoFromRepoUrl } = await import("./taskService");
    const result = extractGitHubInfoFromRepoUrl("https://github.com/edobry/minsky");
    expect(result).toEqual({ owner: "edobry", repo: "minsky" });
  });

  test("should return null for non-GitHub URLs", async () => {
    const { extractGitHubInfoFromRepoUrl } = await import("./taskService");
    expect(extractGitHubInfoFromRepoUrl("https://gitlab.com/user/repo.git")).toBeNull();
    expect(extractGitHubInfoFromRepoUrl("git@bitbucket.org:user/repo.git")).toBeNull();
    expect(extractGitHubInfoFromRepoUrl("/local/path/to/repo")).toBeNull();
  });
});

describe("GitHub Repository Override (New Feature)", () => {
  test("should parse GitHub repository string correctly", async () => {
    const { parseGitHubRepoString } = await import("./taskService");
    const result = parseGitHubRepoString("microsoft/vscode");
    expect(result).toEqual({ owner: "microsoft", repo: "vscode" });
  });

  test("should handle whitespace in repository string", async () => {
    const { parseGitHubRepoString } = await import("./taskService");
    const result = parseGitHubRepoString("  microsoft/vscode  ");
    expect(result).toEqual({ owner: "microsoft", repo: "vscode" });
  });

  test("should return null for invalid repository format", async () => {
    const { parseGitHubRepoString } = await import("./taskService");
    expect(parseGitHubRepoString("invalid-format")).toBeNull();
    expect(parseGitHubRepoString("too/many/slashes")).toBeNull();
    expect(parseGitHubRepoString("")).toBeNull();
    expect(parseGitHubRepoString("/repo")).toBeNull();
    expect(parseGitHubRepoString("owner/")).toBeNull();
  });
});
