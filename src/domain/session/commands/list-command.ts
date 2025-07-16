import type { SessionListParams } from "../../../schemas/session";
import { createSessionProvider } from "../../session";
import { 
  Session, 
  SessionProviderInterface,
  SessionDependencies 
} from "../types";

/**
 * Lists all sessions based on parameters
 * Using proper dependency injection for better testability
 */
export async function listSessionsFromParams(
  params: SessionListParams,
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
