/**
 * Tests for repository backend config-based detection
 *
 * Tests for:
 * - resolveRepositoryFromGitRemote (init-time detection)
 * - getRepositoryBackendFromConfig (config-based session creation)
 * - detectRepositoryBackendTypeFromUrl (URL-based type detection)
 * - createRepositoryBackend (factory error messages)
 *
 * All tests are hermetic — no real filesystem, git, or network access.
 * Uses dependency injection instead of mock.module().
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { RepositoryBackendType, createRepositoryBackend } from "../repository/index";
import type { RepositoryBackendDetectionDeps } from "./repository-backend-detection";
import {
  resolveRepositoryFromGitRemote,
  getRepositoryBackendFromConfig,
  detectRepositoryBackendTypeFromUrl,
} from "./repository-backend-detection";

// ─── Shared mutable state for mock control ───────────────────────────────────

// Controls what execSync returns in each test
// Takes ARGV since mt#5015 / PR #3684 R1 re-shaped the dep; the impls below
// ignore it, but the type must match what `execGit` actually receives.
let execSyncImpl: (cmd: string[], opts?: any) => string | Buffer = (_cmd, _opts) => Buffer.from("");

// Controls what getConfiguration returns in each test
let configurationImpl: () => object = () => ({});

// Shared fixtures (mt#5159): keep the origin URL and the git argv in one place.
const MINSKY_ORIGIN = "https://github.com/edobry/minsky.git\n";
const GIT_REMOTE_ARGV = "remote get-url origin";

function makeDeps(): RepositoryBackendDetectionDeps {
  return {
    execGit: (cmd: string[], opts?: any) => execSyncImpl(cmd, opts),
    getConfiguration: () => configurationImpl(),
  };
}

// ─── resolveRepositoryFromGitRemote ─────────────────────────────────────────

describe("resolveRepositoryFromGitRemote", () => {
  describe("GitHub remote", () => {
    beforeEach(() => {
      execSyncImpl = (_cmd: string[], _opts?: any) => Buffer.from(MINSKY_ORIGIN);
    });

    it("returns backend=github with url and github owner/repo", () => {
      const result = resolveRepositoryFromGitRemote("/tmp/repo", makeDeps());
      expect(result.backend).toBe("github");
      expect(result.url).toContain("github.com");
      expect(result.github?.owner).toBe("edobry");
      expect(result.github?.repo).toBe("minsky");
    });
  });

  describe("no remote (execSync throws)", () => {
    beforeEach(() => {
      execSyncImpl = (_cmd: string[], _opts?: any) => {
        throw new Error("fatal: not a git repository");
      };
    });

    it("returns backend=local when execSync throws", () => {
      const result = resolveRepositoryFromGitRemote("/tmp/not-a-repo", makeDeps());
      expect(result.backend).toBe("local");
      expect(result.url).toBeUndefined();
      expect(result.github).toBeUndefined();
    });
  });

  describe("GitLab remote", () => {
    beforeEach(() => {
      execSyncImpl = (_cmd: string[], _opts?: any) =>
        Buffer.from("https://gitlab.com/someorg/somerepo.git\n");
    });

    it("returns backend=gitlab with url", () => {
      const result = resolveRepositoryFromGitRemote("/tmp/gitlab-repo", makeDeps());
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
        project: { slug: "edobry/minsky" },
      });
      // mt#5159: the BACKEND is still determined from config (no probe needed
      // for that decision, ADR-003), but origin IS read now — best-effort — to
      // VALIDATE the recorded identity and report drift. Here origin matches,
      // so there is no drift.
      execSyncImpl = (cmd: string[], _opts?: any) =>
        cmd.join(" ") === GIT_REMOTE_ARGV ? Buffer.from(MINSKY_ORIGIN) : Buffer.from("");
    });

    it("returns RepositoryBackendType.GITHUB and the configured url, no drift when origin matches", async () => {
      const result = await getRepositoryBackendFromConfig(makeDeps());
      expect(result.backendType).toBe(RepositoryBackendType.GITHUB);
      expect(result.repoUrl).toBe("https://github.com/edobry/minsky.git");
      expect(result.github?.owner).toBe("edobry");
      expect(result.github?.repo).toBe("minsky");
      expect(result.repositoryDrift).toBeUndefined();
    });
  });

  describe("recorded identity disagrees with origin (mt#5159 SC1)", () => {
    beforeEach(() => {
      // Config still says github, but the recorded slug is stale (edobry/old);
      // origin now points at edobry/minsky.
      configurationImpl = () => ({
        repository: {
          backend: "github",
          url: "https://github.com/edobry/minsky.git",
          github: { owner: "edobry", repo: "minsky" },
        },
        project: { slug: "edobry/old" },
      });
      execSyncImpl = (cmd: string[], _opts?: any) =>
        cmd.join(" ") === GIT_REMOTE_ARGV ? Buffer.from(MINSKY_ORIGIN) : Buffer.from("");
    });

    it("still resolves the github backend but surfaces the drift", async () => {
      const result = await getRepositoryBackendFromConfig(makeDeps());
      expect(result.backendType).toBe(RepositoryBackendType.GITHUB);
      expect(result.repositoryDrift).toBeDefined();
      expect(result.repositoryDrift).toContain("edobry/old");
    });
  });

  describe("explicit non-github repository.backend (mt#5159 SC2)", () => {
    beforeEach(() => {
      configurationImpl = () => ({ repository: { backend: "gitlab" } });
      execSyncImpl = (_cmd: string[], _opts?: any) => Buffer.from("");
    });

    it("throws an unsupported-backend error naming the precedence source", async () => {
      await expect(getRepositoryBackendFromConfig(makeDeps())).rejects.toThrow(
        /Unsupported repository backend.*project-config/
      );
    });
  });

  describe("config has no repository section — falls back to auto-detection", () => {
    beforeEach(() => {
      // Config without a repository section
      configurationImpl = () => ({});
      // Auto-detection falls back to resolveRepositoryAndBackend which calls execSync
      // The default_repo_backend is "github", so it will try to get a GitHub remote
      execSyncImpl = (cmd: string[], _opts?: any) => {
        // argv since PR #3684 R1 — match the joined form, not an element.
        if (cmd.join(" ") === GIT_REMOTE_ARGV) {
          return Buffer.from(MINSKY_ORIGIN);
        }
        return Buffer.from("");
      };
    });

    it("falls back to resolveRepositoryAndBackend auto-detection", async () => {
      const result = await getRepositoryBackendFromConfig(makeDeps());
      // Auto-detection from the GitHub remote should set GITHUB backend
      expect(result.backendType).toBe(RepositoryBackendType.GITHUB);
      expect(result.repoUrl).toContain("github.com");
    });
  });
});

// ─── detectRepositoryBackendTypeFromUrl ─────────────────────────────────────

describe("detectRepositoryBackendTypeFromUrl", () => {
  it("returns GITHUB for github.com URLs", () => {
    expect(detectRepositoryBackendTypeFromUrl("https://github.com/owner/repo.git")).toBe(
      RepositoryBackendType.GITHUB
    );
    expect(detectRepositoryBackendTypeFromUrl("git@github.com:owner/repo.git")).toBe(
      RepositoryBackendType.GITHUB
    );
  });

  it("returns GITLAB for gitlab.com URLs", () => {
    expect(detectRepositoryBackendTypeFromUrl("https://gitlab.com/someorg/somerepo.git")).toBe(
      RepositoryBackendType.GITLAB
    );
    expect(detectRepositoryBackendTypeFromUrl("git@gitlab.com:someorg/somerepo.git")).toBe(
      RepositoryBackendType.GITLAB
    );
  });

  it("returns BITBUCKET for bitbucket.org URLs", () => {
    expect(detectRepositoryBackendTypeFromUrl("https://bitbucket.org/someuser/somerepo.git")).toBe(
      RepositoryBackendType.BITBUCKET
    );
    expect(detectRepositoryBackendTypeFromUrl("git@bitbucket.org:someuser/somerepo.git")).toBe(
      RepositoryBackendType.BITBUCKET
    );
  });

  it("throws for unrecognized URLs", () => {
    expect(() => detectRepositoryBackendTypeFromUrl("https://example.com/repo.git")).toThrow(
      /Unsupported repository forge/
    );
  });
});

// ─── createRepositoryBackend factory error messages ─────────────────────────

// Minimal stub — only the type signature needs to satisfy SessionProviderInterface
const stubSessionDB = {} as any;

describe("createRepositoryBackend factory", () => {
  it("throws a clear error for gitlab type", async () => {
    await expect(
      createRepositoryBackend(
        { type: "gitlab", repoUrl: "https://gitlab.com/org/repo" },
        stubSessionDB
      )
    ).rejects.toThrow(
      "GitLab backend is not yet implemented. Only GitHub is currently supported for PR/CI/review operations."
    );
  });

  it("throws a clear error for bitbucket type", async () => {
    await expect(
      createRepositoryBackend(
        { type: "bitbucket", repoUrl: "https://bitbucket.org/user/repo" },
        stubSessionDB
      )
    ).rejects.toThrow(
      "Bitbucket backend is not yet implemented. Only GitHub is currently supported for PR/CI/review operations."
    );
  });
});
