/**
 * Backend type definitions — pure, DECORATOR-FREE.
 *
 * These live here (separate from `backend-detection.ts`) so they can be imported
 * by Drizzle schema files (e.g. `storage/schemas/task-embeddings.ts` via
 * `configuration/schemas/base.ts`) WITHOUT dragging in the tsyringe `@injectable()`
 * decorator. `drizzle-kit generate` loads the schema graph through its own CJS
 * loader, which cannot parse decorator syntax — importing the decorated
 * `DefaultBackendDetectionService` made `drizzle-kit generate` fail at config-load
 * (mt#2276). The `@injectable` service stays in `backend-detection.ts`, which
 * re-exports these types for backward compatibility.
 */

/**
 * Task backend types supported by Minsky
 */
export enum TaskBackend {
  GITHUB_ISSUES = "github-issues",
  GITHUB = "github",
  MINSKY = "minsky",
  DB = "db",
}

export interface BackendDetectionService {
  detectBackend(workingDir: string): Promise<TaskBackend>;
  githubRemoteExists(workingDir: string): Promise<boolean>;
}
