import { getCurrentSessionContext } from "../../workspace";
import {
  Session,
} from "../types";

/**
 * Inspects the current session based on workspace context
 */
export async function sessionInspect(params: {
  json?: boolean;
} = {}): Promise<Session | null> {
  try {
    const sessionContext = await getCurrentSessionContext();
    if (!sessionContext) {
      return null;
    }

    // Transform the sessionContext to match Session interface
    return {
      session: sessionContext.sessionId,
      taskId: sessionContext.taskId,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Inspects the current session - simpler interface for subcommands
 */
export async function inspectCurrentSession(): Promise<Session | null> {
  return sessionInspect({});
}
