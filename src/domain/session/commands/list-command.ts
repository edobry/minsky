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
  try {
    // Set up dependencies with defaults
    const deps = {
      sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
    };

    // eslint-disable-next-line custom/no-excessive-as-unknown -- listSessions returns SessionRecord[] which is structurally compatible but not directly assignable to Session[]
    return (await deps.sessionDB.listSessions()) as unknown as Session[];
  } catch (error) {
    throw new Error(
      `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
