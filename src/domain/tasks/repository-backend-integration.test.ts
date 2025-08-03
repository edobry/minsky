/**
 * Repository Backend Integration Tests
 * Tests for Task #357: Integrate GitHub Issues Backend with Repository Backend Architecture
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  validateTaskBackendCompatibility,
  getCompatibleTaskBackends,
  isTaskBackendCompatible,
} from "./taskBackendCompatibility";
import { RepositoryBackendType } from "../repository/index";

describe("Task Backend Compatibility Validation", () => {
  test("should allow markdown backend with any repository backend", () => {
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.LOCAL, "markdown")
    ).not.toThrow();
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.REMOTE, "markdown")
    ).not.toThrow();
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.GITHUB, "markdown")
    ).not.toThrow();
  });

  test("should allow json-file backend with any repository backend", () => {
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.LOCAL, "json-file")
    ).not.toThrow();
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.REMOTE, "json-file")
    ).not.toThrow();
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.GITHUB, "json-file")
    ).not.toThrow();
  });

  test("should allow github-issues backend only with GitHub repository backend", () => {
    // Should work with GitHub repository backend
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.GITHUB, "github-issues")
    ).not.toThrow();

    // Should fail with other repository backends
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.LOCAL, "github-issues")
    ).toThrow(/GitHub Issues task backend requires GitHub repository backend/);
    expect(() =>
      validateTaskBackendCompatibility(RepositoryBackendType.REMOTE, "github-issues")
    ).toThrow(/GitHub Issues task backend requires GitHub repository backend/);
  });

  test("should provide helpful error message for incompatible backend", () => {
    try {
      validateTaskBackendCompatibility(RepositoryBackendType.LOCAL, "github-issues");
      expect.unreachable("Should have thrown an error");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("GitHub Issues task backend requires GitHub repository backend");
      expect(message).toContain("Current repository backend: local");
      expect(message).toContain("To use GitHub Issues:");
      expect(message).toContain("1. Use in a GitHub repository");
      expect(message).toContain("2. Or switch to a compatible task backend");
    }
  });
});

describe("Compatible Task Backends Detection", () => {
  test("should return correct compatible backends for each repository type", () => {
    // Local and remote repositories support markdown and json-file
    expect(getCompatibleTaskBackends(RepositoryBackendType.LOCAL)).toEqual([
      "markdown",
      "json-file",
    ]);
    expect(getCompatibleTaskBackends(RepositoryBackendType.REMOTE)).toEqual([
      "markdown",
      "json-file",
    ]);

    // GitHub repositories support all backends including github-issues
    expect(getCompatibleTaskBackends(RepositoryBackendType.GITHUB)).toEqual([
      "markdown",
      "json-file",
      "github-issues",
    ]);
  });

  test("should correctly identify backend compatibility", () => {
    // Markdown backend compatible with all
    expect(isTaskBackendCompatible(RepositoryBackendType.LOCAL, "markdown")).toBe(true);
    expect(isTaskBackendCompatible(RepositoryBackendType.REMOTE, "markdown")).toBe(true);
    expect(isTaskBackendCompatible(RepositoryBackendType.GITHUB, "markdown")).toBe(true);

    // JSON file backend compatible with all
    expect(isTaskBackendCompatible(RepositoryBackendType.LOCAL, "json-file")).toBe(true);
    expect(isTaskBackendCompatible(RepositoryBackendType.REMOTE, "json-file")).toBe(true);
    expect(isTaskBackendCompatible(RepositoryBackendType.GITHUB, "json-file")).toBe(true);

    // GitHub issues backend only compatible with GitHub
    expect(isTaskBackendCompatible(RepositoryBackendType.LOCAL, "github-issues")).toBe(false);
    expect(isTaskBackendCompatible(RepositoryBackendType.REMOTE, "github-issues")).toBe(false);
    expect(isTaskBackendCompatible(RepositoryBackendType.GITHUB, "github-issues")).toBe(true);
  });
});

describe("GitHub URL Parsing", () => {
  test("should parse SSH GitHub URLs correctly", async () => {
    // Import the helper function we created
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

  // Note: Full integration test would require valid workspace and GitHub token
  // The parsing functionality is thoroughly tested above
});

// Note: Full TaskService integration tests would require mocking repository backends
// and setting up test environments, which we'll handle in a separate integration test suite
