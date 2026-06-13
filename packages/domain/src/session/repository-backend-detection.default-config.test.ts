import { describe, it, expect } from "bun:test";

import { resolveRepositoryAndBackend } from "./repository-backend-detection";
import type { RepositoryBackendDetectionDeps } from "./repository-backend-detection";
import { RepositoryBackendType } from "../repository";

describe("resolveRepositoryAndBackend with repository.default_repo_backend=github", () => {
  const deps: RepositoryBackendDetectionDeps = {
    execSync: (cmd: string, _opts?: any) => {
      if (cmd.includes("git remote get-url origin")) {
        return Buffer.from("https://github.com/edobry/minsky.git");
      }
      if (cmd.includes("git rev-parse --show-toplevel")) {
        return Buffer.from("/tmp/repo");
      }
      return Buffer.from("");
    },
    getConfiguration: () => ({
      repository: { default_repo_backend: "github" },
    }),
    isInsideGitWorkTree: () => true,
  };

  it("uses GitHub remote and sets backendType=GITHUB when --repo is not provided", async () => {
    const { repoUrl, backendType } = await resolveRepositoryAndBackend({ cwd: "/tmp" }, deps);
    expect(repoUrl).toContain("github.com/");
    expect(backendType).toBe(RepositoryBackendType.GITHUB);
  });

  it("throws the actionable not-a-git-repository error outside a git work tree", async () => {
    // The no-spawn short-circuit (mt#1428) must fail with the clear error
    // before consulting execSync at all.
    const noWorkTreeDeps = { ...deps, isInsideGitWorkTree: () => false };
    await expect(resolveRepositoryAndBackend({ cwd: "/tmp" }, noWorkTreeDeps)).rejects.toThrow(
      /not inside a git repository/
    );
  });
});
