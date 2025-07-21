/**
 * IMPROVED: Workspace resolution using enhanced TaskService
 * Eliminates TaskBackendRouter complexity and provides cleaner workspace resolution
 */
import { TaskService } from "../domain/tasks/taskService";
import { resolveRepoPath } from "../domain/repo-utils";
import { log } from "./logger";

/**
 * Options for workspace resolution
 */
export interface WorkspaceResolverOptions {
  /** Backend name to use */
  backend?: string;
  /** Repository URL override */
  repoUrl?: string;
}

/**
 * Enhanced workspace resolution using improved TaskService
 * Replaces the complex TaskBackendRouter pattern with simple enhanced TaskService
 */
export async function resolveTaskWorkspacePath(options: WorkspaceResolverOptions = {}): Promise<string> {
  const { backend = "markdown", repoUrl } = options;

  // For markdown backend, use enhanced TaskService with workspace resolution
  if (backend === "markdown") {
    if (repoUrl) {
      // Use repo-based creation with timeout protection
      try {
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Workspace resolution timeout")), 8000); // 8 second timeout
        });

        const taskServicePromise = TaskService.createMarkdownWithRepo({ repoUrl });
        const taskService = await Promise.race([taskServicePromise, timeout]);

        return taskService.getWorkspacePath();
      } catch (error) {
        log.warn("Failed to create repo-based TaskService, falling back to current directory", {
          error: error instanceof Error ? error.message : String(error),
          repoUrl
        });
        return (process as any).cwd();
      }
    } else {
      // Try to resolve repo URL, fall back to auto-detection
      try {
        const effectiveRepoUrl = await resolveRepoPath({});

        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Workspace resolution timeout")), 8000); // 8 second timeout
        });

        const taskServicePromise = TaskService.createMarkdownWithRepo({ repoUrl: effectiveRepoUrl });
        const taskService = await Promise.race([taskServicePromise, timeout]);

        return taskService.getWorkspacePath();
      } catch (error) {
        // Fall back to auto-detection if repo resolution fails
        try {
          const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Auto-detection timeout")), 5000); // 5 second timeout
          });

          const taskServicePromise = TaskService.createMarkdownWithAutoDetection();
          const taskService = await Promise.race([taskServicePromise, timeout]);

          return taskService.getWorkspacePath();
        } catch (autoDetectError) {
          log.warn("All workspace resolution methods failed, using current directory", {
            repoError: error instanceof Error ? error.message : String(error),
            autoDetectError: autoDetectError instanceof Error ? autoDetectError.message : String(autoDetectError)
          });
          return (process as any).cwd();
        }
      }
    }
  }

  // For other backends, use current directory
  return process.cwd();
}
