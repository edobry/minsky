/**
 * Legacy Repository Backend Factory
 *
 * The original createRepositoryBackend function from the parent repository.ts file.
 * This factory creates backends using the legacy RepositoryConfig interface
 * (used by localGitBackend.ts and remoteGitBackend.ts in the domain root).
 *
 * Note: The repository/index.ts has its own createRepositoryBackend that uses
 * the newer RepositoryBackendConfig interface with repoUrl.
 */
import { normalizeRepoName } from "../repo-utils";
import type { SessionProviderInterface } from "../session";
import { RepositoryBackendType } from "./legacy-types";
import type {
  RepositoryConfig,
  RemoteGitConfig,
  GitHubConfig,
  RepositoryStatus,
  ValidationResult,
  CloneResult,
  BranchResult,
  RepositoryBackend,
} from "./legacy-types";

/**
 * Create a repository backend instance based on the provided configuration.
 *
 * @param config Repository configuration
 * @param sessionDB Session provider for database operations
 * @returns RepositoryBackend instance
 */
export async function createRepositoryBackend(
  config: RepositoryConfig,
  sessionDB: SessionProviderInterface
): Promise<RepositoryBackend> {
  switch (config.type) {
    case RepositoryBackendType.LOCAL: {
      const { LocalGitBackend } = await import("../localGitBackend.js");
      return new LocalGitBackend(config);
    }
    case RepositoryBackendType.REMOTE: {
      const { RemoteGitBackend } = await import("../remoteGitBackend.js");
      const remoteConfig: RemoteGitConfig = {
        ...config,
        type: RepositoryBackendType.REMOTE,
        url: config.url ?? config.repoUrl ?? "",
      };
      return new RemoteGitBackend(remoteConfig);
    }
    case RepositoryBackendType.GITHUB: {
      const { GitService } = await import("../git.js");
      const gitService = new GitService();

      // Create an adapter using GitService that conforms to RepositoryBackend interface
      return {
        clone: async (session: string): Promise<CloneResult> => {
          const workdir = gitService.getSessionWorkdir(session);
          return await gitService.clone({
            repoUrl: config.url || "",
            session,
            workdir,
          });
        },

        getStatus: async (session?: string): Promise<RepositoryStatus> => {
          // If no session is provided, work with the most recent session
          if (!session) {
            const sessions = await sessionDB.listSessions();
            const repoName = normalizeRepoName(config.url || "");
            const repoSession = sessions.find((s) => s.repoName === repoName);
            if (!repoSession) {
              throw new Error("No session found for this repository");
            }
            session = repoSession.session;
          }

          const _repoName = normalizeRepoName(config.url || "");
          const workdir = gitService.getSessionWorkdir(session);

          const gitStatus = await gitService.getStatus(workdir);

          // Get additional status info directly via Git commands
          const { stdout: branchOutput } = await (
            await import("util")
          ).promisify((await import("child_process")).exec)(
            `git -C ${workdir} rev-parse --abbrev-ref HEAD`
          );

          const branch = branchOutput.trim();
          return {
            clean: gitStatus.modified.length === 0 && gitStatus.untracked.length === 0,
            changes: [
              ...gitStatus.modified.map((file) => `M ${file}`),
              ...gitStatus.untracked.map((file) => `?? ${file}`),
              ...gitStatus.deleted.map((file) => `D ${file}`),
            ],
            branch,
            // Add other required fields from RepositoryStatus
            modifiedFiles: [
              ...gitStatus.modified.map((file) => ({ status: "M", file })),
              ...gitStatus.untracked.map((file) => ({ status: "??", file })),
              ...gitStatus.deleted.map((file) => ({ status: "D", file })),
            ],
            dirty: gitStatus.modified.length > 0 || gitStatus.untracked.length > 0,
          };
        },

        getPath: async (session?: string): Promise<string> => {
          // If no session is provided, work with the most recent session
          if (!session) {
            const sessions = await sessionDB.listSessions();
            const repoName = normalizeRepoName(config.url || "");
            const repoSession = sessions.find((s) => s.repoName === repoName);
            if (!repoSession) {
              throw new Error("No session found for this repository");
            }
            session = repoSession.session;
          }

          const _repoName = normalizeRepoName(config.url || "");
          return gitService.getSessionWorkdir(session);
        },

        validate: async (): Promise<ValidationResult> => {
          // Basic validation of the GitHub configuration
          if (!config.url) {
            return {
              valid: false,
              issues: ["Repository URL is required"],
              success: false,
              message: "Repository URL is required",
            };
          }

          return {
            valid: true,
            success: true,
            message: "GitHub configuration is valid",
          };
        },

        push: async (_branch?: string): Promise<{ success: boolean; message: string }> => {
          // Find an existing session for this repository
          const sessions = await sessionDB.listSessions();
          const repoName = normalizeRepoName(config.url || "");
          const repoSession = sessions.find((s) => s.repoName === repoName);

          if (!repoSession) {
            throw new Error("No session found for this repository");
          }

          const sessionId = repoSession.session;
          const workdir = gitService.getSessionWorkdir(sessionId);

          await gitService.push({
            session: sessionId,
            repoPath: workdir,
          });
          return { success: true, message: "Successfully pushed to repository" };
        },

        pull: async (_branch?: string): Promise<{ success: boolean; message: string }> => {
          // Find an existing session for this repository
          const sessions = await sessionDB.listSessions();
          const repoName = normalizeRepoName(config.url || "");
          const repoSession = sessions.find((s) => s.repoName === repoName);

          if (!repoSession) {
            throw new Error("No session found for this repository");
          }

          const workdir = gitService.getSessionWorkdir(repoSession.session);
          await gitService.fetchLatest(workdir);
          return { success: true, message: "Successfully pulled from repository" };
        },

        branch: async (session: string, name: string): Promise<BranchResult> => {
          const _repoName = normalizeRepoName(config.url || "");
          const workdir = gitService.getSessionWorkdir(session);

          // Execute branch creation via Git command
          await (await import("util")).promisify((await import("child_process")).exec)(
            `git -C ${workdir} checkout -b ${name}`
          );

          return {
            workdir,
            branch: name,
          };
        },

        checkout: async (branch: string): Promise<void> => {
          // Find an existing session for this repository
          const sessions = await sessionDB.listSessions();
          const repoName = normalizeRepoName(config.url || "");
          const repoSession = sessions.find((s) => s.repoName === repoName);

          if (!repoSession) {
            throw new Error("No session found for this repository");
          }

          const workdir = gitService.getSessionWorkdir(repoSession.session);

          // Execute checkout via Git command
          await (await import("util")).promisify((await import("child_process")).exec)(
            `git -C ${workdir} checkout ${branch}`
          );
        },

        getConfig: (): RepositoryConfig => {
          return {
            type: RepositoryBackendType.GITHUB,
            url: config.url,
            owner: (config as GitHubConfig).owner,
            repo: (config as GitHubConfig).repo,
            token: (config as GitHubConfig).token,
          } as RepositoryConfig;
        },
      };
    }
    default: {
      throw new Error(`Unsupported repository backend type: ${config.type}`);
    }
  }
}
