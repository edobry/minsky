import type { SessionListParameters } from "../../../domain/schemas";
import { createSessionProvider } from "../session-db-adapter";
import { Session, SessionProviderInterface, SessionDependencies } from "../types";

/**
 * Lists all sessions based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionList(
  params: SessionListParameters,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<Session[]> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  return deps.sessionDB.listSessions();
}
