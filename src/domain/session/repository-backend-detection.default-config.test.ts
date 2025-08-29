import { describe, it, expect, mock } from "bun:test";

import { resolveRepositoryAndBackend } from "./repository-backend-detection";
import { RepositoryBackendType } from "../repository";

describe("resolveRepositoryAndBackend with repository.default_repo_backend=github", () => {
  // Mock configuration to force default backend to github
  mock.module("../../domain/configuration/index", () => ({
    getConfiguration: () => ({
      repository: { default_repo_backend: "github" },
    }),
  }));

  // Mock child_process.execSync to return a GitHub remote URL
  mock.module("child_process", () => ({
    execSync: (cmd: string, _opts?: any) => {
      if (cmd.includes("git remote get-url origin")) {
        return Buffer.from("https://github.com/edobry/minsky.git");
      }
      if (cmd.includes("git rev-parse --show-toplevel")) {
        return Buffer.from("/tmp/repo");
      }
      return Buffer.from("");
    },
  }));
  it("uses GitHub remote and sets backendType=GITHUB when --repo is not provided", async () => {
    const { repoUrl, backendType } = await resolveRepositoryAndBackend({ cwd: "/tmp" });
    expect(repoUrl).toContain("github.com/");
    expect(backendType).toBe(RepositoryBackendType.GITHUB);
  });
});
