import type { SessionDeleteParams } from "../../schemas/session";
import { createSessionProvider } from "../../session";
import {
  SessionProviderInterface,
  SessionDependencies
} from "../types";

/**
 * Deletes a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionDelete(
  params: SessionDeleteParams,
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
