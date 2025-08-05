import type { SessionDeleteParameters } from "../../../domain/schemas";
import { createSessionProvider } from "../../session";
import { SessionProviderInterface, SessionDependencies } from "../types";
import { cleanupSessionImpl } from "../session-lifecycle-operations";

/**
 * Deletes a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionDelete(
  params: SessionDeleteParameters,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<boolean> {
  const { name } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  try {
    // Use the comprehensive cleanup implementation
    const cleanupResult = await cleanupSessionImpl(
      {
        sessionName: name,
        force: true, // User explicitly requested deletion
      },
      deps
    );

    // Return true if session was deleted or directories were removed
    return cleanupResult.sessionDeleted || cleanupResult.directoriesRemoved.length > 0;
  } catch (error) {
    // Fall back to database-only deletion if cleanup fails
    console.warn(`Session cleanup failed, falling back to database-only deletion: ${error}`);
    return deps.sessionDB.deleteSession(name);
  }
}

// Export alias for compatibility with subcommands
export { sessionDelete as deleteSession };
