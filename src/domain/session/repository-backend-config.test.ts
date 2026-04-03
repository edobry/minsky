/**
 * Tests for repository backend config-based detection
 *
 * Tests for:
 * - resolveRepositoryFromGitRemote (init-time detection)
 * - getRepositoryBackendFromConfig (config-based session creation)
 *
 * All tests are hermetic — no real filesystem, git, or network access.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { RepositoryBackendType } from "../repository/index";

// ─── Shared mutable state for mock control ───────────────────────────────────

// Controls what execSync returns in each test
let execSyncImpl: (cmd: string, opts?: any) => string | Buffer = (_cmd, _opts) => Buffer.from("");

// Controls what getConfiguration returns in each test
let configurationImpl: () => object = () => ({});

// ─── Top-level module mocks (registered before any import of the module under test)

mock.module("child_process", () => ({
  execSync: (cmd: string, opts?: any) => execSyncImpl(cmd, opts),
}));

mock.module("../configuration/index", () => ({
  getConfiguration: () => configurationImpl(),
}));

// Import the module under test AFTER mocks are registered
import {
  resolveRepositoryFromGitRemote,
  getRepositoryBackendFromConfig,
} from "./repository-backend-detection";

// ─── resolveRepositoryFromGitRemote ─────────────────────────────────────────

describe("resolveRepositoryFromGitRemote", () => {
  describe("GitHub remote", () => {
    beforeEach(() => {
      execSyncImpl = (_cmd: string, _opts?: any) =>
        Buffer.from("https://github.com/edobry/minsky.git\n");
    });

    it("returns backend=github with url and github owner/repo", () => {
      const result = resolveRepositoryFromGitRemote("/tmp/repo");
      expect(result.backend).toBe("github");
      expect(result.url).toContain("github.com");
      expect(result.github?.owner).toBe("edobry");
      expect(result.github?.repo).toBe("minsky");
    });
  });

  describe("no remote (execSync throws)", () => {
    beforeEach(() => {
      execSyncImpl = (_cmd: string, _opts?: any) => {
        throw new Error("fatal: not a git repository");
      };
    });

    it("returns backend=local when execSync throws", () => {
      const result = resolveRepositoryFromGitRemote("/tmp/not-a-repo");
      expect(result.backend).toBe("local");
      expect(result.url).toBeUndefined();
      expect(result.github).toBeUndefined();
    });
  });

  describe("GitLab remote", () => {
    beforeEach(() => {
      execSyncImpl = (_cmd: string, _opts?: any) =>
        Buffer.from("https://gitlab.com/someorg/somerepo.git\n");
    });

    it("returns backend=gitlab with url", () => {
      const result = resolveRepositoryFromGitRemote("/tmp/gitlab-repo");
      expect(result.backend).toBe("gitlab");
      expect(result.url).toContain("gitlab.com");
      expect(result.github).toBeUndefined();
    });
  });
});

// ─── getRepositoryBackendFromConfig ─────────────────────────────────────────

describe("getRepositoryBackendFromConfig", () => {
  describe("config has repository.backend=github", () => {
    beforeEach(() => {
      configurationImpl = () => ({
        repository: {
          backend: "github",
          url: "https://github.com/edobry/minsky.git",
          github: { owner: "edobry", repo: "minsky" },
        },
      });
      // execSync should not be called in this path
      execSyncImpl = (_cmd: string, _opts?: any) => {
        throw new Error("execSync should not be called when config has repository.backend");
      };
    });

    it("returns RepositoryBackendType.GITHUB and the configured url", async () => {
      const result = await getRepositoryBackendFromConfig();
      expect(result.backendType).toBe(RepositoryBackendType.GITHUB);
      expect(result.repoUrl).toBe("https://github.com/edobry/minsky.git");
      expect(result.github?.owner).toBe("edobry");
      expect(result.github?.repo).toBe("minsky");
    });
  });

  describe("config has repository.backend=local", () => {
    beforeEach(() => {
      configurationImpl = () => ({
        repository: {
          backend: "local",
          url: "/home/user/projects/myrepo",
        },
      });
      execSyncImpl = (_cmd: string, _opts?: any) => {
        throw new Error("execSync should not be called when config has repository.backend");
      };
    });

    it("returns RepositoryBackendType.LOCAL and the configured url", async () => {
      const result = await getRepositoryBackendFromConfig();
      expect(result.backendType).toBe(RepositoryBackendType.LOCAL);
      expect(result.repoUrl).toBe("/home/user/projects/myrepo");
    });
  });

  describe("config has no repository section — falls back to auto-detection", () => {
    beforeEach(() => {
      // Config without a repository section
      configurationImpl = () => ({});
      // Auto-detection falls back to resolveRepositoryAndBackend which calls execSync
      // The default_repo_backend is "github", so it will try to get a GitHub remote
      execSyncImpl = (cmd: string, _opts?: any) => {
        if (cmd.includes("git remote get-url origin")) {
          return Buffer.from("https://github.com/edobry/minsky.git\n");
        }
        return Buffer.from("");
      };
    });

    it("falls back to resolveRepositoryAndBackend auto-detection", async () => {
      const result = await getRepositoryBackendFromConfig();
      // Auto-detection from the GitHub remote should set GITHUB backend
      expect(result.backendType).toBe(RepositoryBackendType.GITHUB);
      expect(result.repoUrl).toContain("github.com");
    });
  });
});
