/**
 * Backend Detection Service
 *
 * Provides backend detection functionality using the custom configuration system
 * while preserving existing detection logic and capabilities.
 */

import { injectable } from "tsyringe";
import { TaskBackend, type BackendDetectionService } from "./backend-types";

// Re-export the decorator-free types so existing importers of this module keep
// working unchanged. The definitions live in `backend-types.ts` so Drizzle schema
// files can import them without pulling in the `@injectable()` decorator below
// (which `drizzle-kit generate`'s CJS loader cannot parse — mt#2276).
export { TaskBackend, type BackendDetectionService };

@injectable()
export class DefaultBackendDetectionService implements BackendDetectionService {
  /**
   * Detect the most appropriate backend based on project structure.
   * Defaults to MINSKY since file-based backends have been removed.
   */
  async detectBackend(_workingDir: string): Promise<TaskBackend> {
    return TaskBackend.MINSKY;
  }

  /**
   * Check if GitHub remote exists (disabled for auto-detection)
   */
  async githubRemoteExists(_workingDir: string): Promise<boolean> {
    // GitHub Issues detection is disabled for auto-detection
    // to prevent automatic selection of this backend
    return false;
  }
}
