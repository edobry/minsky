import type { SessionDeleteParameters } from "../../../domain/schemas";
import { createSessionProvider } from "../../session";
import { SessionProviderInterface, SessionDependencies } from "../types";

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

  return deps.sessionDB.deleteSession(name);
}

// Export alias for compatibility with subcommands
export { sessionDelete as deleteSession };
