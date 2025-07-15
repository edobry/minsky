import { getCurrentSessionContext } from "../../workspace";
import { 
  Session,
} from "../types";

/**
 * Inspects the current session based on workspace context
 */
export async function inspectSessionFromParams(_params: {
  json?: boolean;
}): Promise<Session | null> {
  try {
    const sessionContext = await getCurrentSessionContext();
    return sessionContext;
  } catch (_error) {
    return null;
  }
}

/**
 * Inspects the current session - simpler interface for subcommands
 */
export async function inspectCurrentSession(): Promise<Session | null> {
  return inspectSessionFromParams({});
} 
