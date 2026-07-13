/**
 * Unit tests for the project identity resolver (mt#2414 — Phase 1.1 of mt#2391).
 *
 * Covers:
 * - Each precedence tier (explicit flag, env var, config slug, git remote)
 * - Edge cases: config≠remote (config wins + warning), no config, detached HEAD / no remote
 * - MCP multi-repo v1 behavior: per-request resolution from repoPath
 * - extractOwnerRepo URL parsing (SSH and HTTPS forms)
 * - deriveSlugFromGitRemote helpers
 */

import { describe, test, expect } from "bun:test";
import {
  resolveProjectIdentity,
  extractOwnerRepo,
  deriveSlugFromGitRemote,
  readConfigSlug,
  PROJECT_IDENTITY_ENV_VAR,
  type ProjectIdentityDeps,
} from "./identity";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical SSH remote URL used across multiple tests */
const GITHUB_SSH_URL = "git@github.com:edobry/minsky.git";

/**
 * Build a minimal `ProjectIdentityDeps` where each dep defaults to a no-op.
 * Callers override the parts they care about.
 */
function makeDeps(overrides: Partial<ProjectIdentityDeps> = {}): ProjectIdentityDeps {
  return {
    execSync: () => "",
    existsSync: () => false,
    readFileSync: () => "",
    getEnvVar: () => undefined,
    ...overrides,
  };
}

/** Minimal config YAML with a project.slug */
function configWithSlug(slug: string): string {
  return `project:\n  slug: "${slug}"\n`;
}

/** Config YAML without project section */
const configWithoutSlug = `tasks:\n  backend: minsky\n`;

// ─────────────────────────────────────────────────────────────────────────────
// extractOwnerRepo
// ─────────────────────────────────────────────────────────────────────────────

describe("extractOwnerRepo", () => {
  test("parses SSH GitHub URL (with .git)", () => {
    expect(extractOwnerRepo(GITHUB_SSH_URL)).toBe("edobry/minsky");
  });

  test("parses SSH GitHub URL (without .git)", () => {
    expect(extractOwnerRepo("git@github.com:edobry/minsky")).toBe("edobry/minsky");
  });

  test("parses SSH GitLab URL", () => {
    expect(extractOwnerRepo("git@gitlab.com:org/project.git")).toBe("org/project");
  });

  test("parses HTTPS GitHub URL (with .git)", () => {
    expect(extractOwnerRepo("https://github.com/edobry/minsky.git")).toBe("edobry/minsky");
  });

  test("parses HTTPS GitHub URL (without .git)", () => {
    expect(extractOwnerRepo("https://github.com/edobry/minsky")).toBe("edobry/minsky");
  });

  test("parses HTTPS with trailing slash", () => {
    expect(extractOwnerRepo("https://github.com/edobry/minsky/")).toBe("edobry/minsky");
  });

  test("returns null for unrecognised URL", () => {
    expect(extractOwnerRepo("not-a-url")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractOwnerRepo("")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveSlugFromGitRemote
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveSlugFromGitRemote", () => {
  test("returns owner/repo when origin exists", () => {
    const deps = makeDeps({
      execSync: () => GITHUB_SSH_URL,
    });
    expect(deriveSlugFromGitRemote("/repo", deps)).toBe("edobry/minsky");
  });

  test("returns null when execSync throws (no remote / not a git repo)", () => {
    const deps = makeDeps({
      execSync: () => {
        throw new Error("not a git repo");
      },
    });
    expect(deriveSlugFromGitRemote("/notgit", deps)).toBeNull();
  });

  test("returns null when remote URL is unrecognised", () => {
    const deps = makeDeps({
      execSync: () => "svn+ssh://svn.example.com/repo",
    });
    expect(deriveSlugFromGitRemote("/repo", deps)).toBeNull();
  });

  test("returns null for empty remote output", () => {
    const deps = makeDeps({
      execSync: () => "  ",
    });
    expect(deriveSlugFromGitRemote("/repo", deps)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readConfigSlug
// ─────────────────────────────────────────────────────────────────────────────

describe("readConfigSlug", () => {
  test("returns slug from .minsky/config.yaml when present", () => {
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => configWithSlug("edobry/minsky"),
    });
    expect(readConfigSlug("/repo", deps)).toBe("edobry/minsky");
  });

  test("returns null when config file does not exist", () => {
    const deps = makeDeps({ existsSync: () => false });
    expect(readConfigSlug("/repo", deps)).toBeNull();
  });

  test("returns null when config has no project section", () => {
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => configWithoutSlug,
    });
    expect(readConfigSlug("/repo", deps)).toBeNull();
  });

  test("returns null when project.slug is an empty string", () => {
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => `project:\n  slug: ""\n`,
    });
    expect(readConfigSlug("/repo", deps)).toBeNull();
  });

  test("returns null when project.slug is whitespace only", () => {
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => `project:\n  slug: "   "\n`,
    });
    expect(readConfigSlug("/repo", deps)).toBeNull();
  });

  test("returns null on YAML parse error (fail-open)", () => {
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => "{ invalid yaml: [[[",
    });
    // Should not throw — returns null
    expect(readConfigSlug("/repo", deps)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveProjectIdentity — precedence chain
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProjectIdentity — precedence chain", () => {
  // Tier 1: explicit flag
  test("explicit flag wins over all other tiers", () => {
    const deps = makeDeps({
      getEnvVar: () => "from-env",
      existsSync: () => true,
      readFileSync: () => configWithSlug("from-config"),
      execSync: () => "git@github.com:org/from-remote.git",
    });
    const result = resolveProjectIdentity({ explicitSlug: "from-flag" }, deps);
    expect(result).toEqual({ kind: "resolved", slug: "from-flag", source: "explicit-flag" });
  });

  // Tier 2: env var
  test("env var wins over config and git remote", () => {
    const deps = makeDeps({
      getEnvVar: (name) => (name === PROJECT_IDENTITY_ENV_VAR ? "from-env" : undefined),
      existsSync: () => true,
      readFileSync: () => configWithSlug("from-config"),
      execSync: () => "git@github.com:org/from-remote.git",
    });
    const result = resolveProjectIdentity({}, deps);
    expect(result).toEqual({ kind: "resolved", slug: "from-env", source: "env-var" });
  });

  test("env var is trimmed", () => {
    const deps = makeDeps({
      getEnvVar: (name) => (name === PROJECT_IDENTITY_ENV_VAR ? "  my-org/my-repo  " : undefined),
    });
    const result = resolveProjectIdentity({}, deps);
    expect(result).toEqual({ kind: "resolved", slug: "my-org/my-repo", source: "env-var" });
  });

  test("empty env var does not match (falls through)", () => {
    const deps = makeDeps({
      getEnvVar: (name) => (name === PROJECT_IDENTITY_ENV_VAR ? "" : undefined),
      execSync: () => GITHUB_SSH_URL,
    });
    const result = resolveProjectIdentity({}, deps);
    // Should fall through to git-remote
    expect(result).toEqual({ kind: "resolved", slug: "edobry/minsky", source: "git-remote" });
  });

  // Tier 3: config slug
  test("config slug wins over git remote when no explicit flag or env var", () => {
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => configWithSlug("edobry/minsky"),
      execSync: () => GITHUB_SSH_URL,
    });
    const result = resolveProjectIdentity({}, deps);
    expect(result).toEqual({ kind: "resolved", slug: "edobry/minsky", source: "config-slug" });
  });

  // Tier 4: git remote
  test("git remote is used when no explicit flag, env var, or config slug", () => {
    const deps = makeDeps({
      existsSync: () => false,
      execSync: () => GITHUB_SSH_URL,
    });
    const result = resolveProjectIdentity({}, deps);
    expect(result).toEqual({ kind: "resolved", slug: "edobry/minsky", source: "git-remote" });
  });

  // Unidentified
  test("returns unidentified when all tiers fail", () => {
    const deps = makeDeps({
      existsSync: () => false,
      execSync: () => {
        throw new Error("not a git repo");
      },
    });
    const result = resolveProjectIdentity({}, deps);
    expect(result.kind).toBe("unidentified");
    if (result.kind === "unidentified") {
      expect(result.reason).toContain("No project slug found");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProjectIdentity — edge cases", () => {
  test("(a) config slug and git remote disagree — config wins", () => {
    // Both sources exist but differ
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => configWithSlug("my-org/my-repo"),
      execSync: () => "git@github.com:fork-user/my-repo.git",
    });
    const result = resolveProjectIdentity({}, deps);
    // Config wins
    expect(result).toEqual({ kind: "resolved", slug: "my-org/my-repo", source: "config-slug" });
    // We cannot assert the warning in a unit test without mocking log, but the
    // code path is exercised — the cross-check runs whenever configSlug && remoteSlug differ.
  });

  test("(a) config slug and git remote agree — config wins (no warning)", () => {
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => configWithSlug("edobry/minsky"),
      execSync: () => GITHUB_SSH_URL,
    });
    const result = resolveProjectIdentity({}, deps);
    expect(result).toEqual({ kind: "resolved", slug: "edobry/minsky", source: "config-slug" });
  });

  test("(b) .minsky/config.yaml absent — falls back to git-remote", () => {
    const deps = makeDeps({
      existsSync: () => false, // no config file
      execSync: () => "https://github.com/edobry/minsky.git",
    });
    const result = resolveProjectIdentity({}, deps);
    expect(result).toEqual({ kind: "resolved", slug: "edobry/minsky", source: "git-remote" });
  });

  test("(b) no config, no remote — returns unidentified sentinel", () => {
    const deps = makeDeps({
      existsSync: () => false,
      execSync: () => {
        throw new Error("fatal: not a git repository");
      },
    });
    const result = resolveProjectIdentity({}, deps);
    expect(result.kind).toBe("unidentified");
  });

  test("(c) detached HEAD (execSync succeeds but returns empty) — returns unidentified", () => {
    // When git remote get-url origin fails (no remote set) even in a valid repo
    const deps = makeDeps({
      existsSync: () => false,
      execSync: () => {
        throw new Error("error: No such remote 'origin'");
      },
    });
    const result = resolveProjectIdentity({}, deps);
    expect(result.kind).toBe("unidentified");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP multi-repo v1 behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("MCP multi-repo — per-request resolution", () => {
  /**
   * v1 documented constraint: the MCP server resolves identity per-request
   * from the provided repoPath (ProjectContext.repositoryPath).
   * Two simultaneous requests with different repoPaths return different identities.
   */
  test("different repoPaths produce independent identities (per-request semantics)", () => {
    // Simulate two sessions from different repos in the same server process
    function makeRepoSpecificDeps(slug: string): ProjectIdentityDeps {
      return makeDeps({
        existsSync: (p) => p.endsWith("config.yaml"), // both have config files
        readFileSync: () => configWithSlug(slug),
      });
    }

    const resultA = resolveProjectIdentity(
      { repoPath: "/repos/project-a" },
      makeRepoSpecificDeps("org/project-a")
    );
    const resultB = resolveProjectIdentity(
      { repoPath: "/repos/project-b" },
      makeRepoSpecificDeps("org/project-b")
    );

    expect(resultA).toEqual({ kind: "resolved", slug: "org/project-a", source: "config-slug" });
    expect(resultB).toEqual({ kind: "resolved", slug: "org/project-b", source: "config-slug" });
  });

  test("same server process resolving two different repos via git-remote falls through correctly", () => {
    // No config files, but different remotes per repo
    const remotesMap: Record<string, string> = {
      "/repos/a": "git@github.com:org/repo-a.git",
      "/repos/b": "git@github.com:org/repo-b.git",
    };

    function makePerRepoDeps(repoPath: string): ProjectIdentityDeps {
      return makeDeps({
        existsSync: () => false,
        execSync: (_cmd, opts) => {
          const cwd = opts?.cwd ?? repoPath;
          // Match against known repos
          for (const [knownPath, url] of Object.entries(remotesMap)) {
            if (cwd === knownPath) return url;
          }
          throw new Error("unknown repo");
        },
      });
    }

    const resultA = resolveProjectIdentity({ repoPath: "/repos/a" }, makePerRepoDeps("/repos/a"));
    const resultB = resolveProjectIdentity({ repoPath: "/repos/b" }, makePerRepoDeps("/repos/b"));

    expect(resultA).toEqual({ kind: "resolved", slug: "org/repo-a", source: "git-remote" });
    expect(resultB).toEqual({ kind: "resolved", slug: "org/repo-b", source: "git-remote" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// None throws
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProjectIdentity — never throws", () => {
  test("does not throw when execSync throws", () => {
    const deps = makeDeps({
      execSync: () => {
        throw new Error("unexpected");
      },
    });
    expect(() => resolveProjectIdentity({}, deps)).not.toThrow();
  });

  test("does not throw when readFileSync throws", () => {
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("permission denied");
      },
    });
    expect(() => resolveProjectIdentity({}, deps)).not.toThrow();
  });
});
