import { Command } from "commander";
import { createListCommand } from "./list";
import { createGetCommand } from "./get";
import { createDirCommand } from "./cd";
import { createStartCommand } from "./start";
import { createDeleteCommand } from "./delete";
import { createUpdateCommand } from "./update";
import { getCurrentSession as defaultGetCurrentSession } from "../../domain/workspace";
import { GitService } from "../../domain/git";
import { SessionDB } from "../../domain/session";

// Add a dependencies parameter to allow dependency injection for testing
export interface SessionCommandDependencies {
  getCurrentSession?: typeof defaultGetCurrentSession;
}

export function createSessionCommand(dependencies: SessionCommandDependencies = {}): Command {
  const gitService = new GitService();
  const sessionDb = new SessionDB();

  // Use provided dependencies or fall back to defaults
  const deps = {
    getCurrentSession: dependencies.getCurrentSession || defaultGetCurrentSession
  };

  const session = new Command("session")
    .description("Session management commands");

  session.addCommand(createListCommand());
  session.addCommand(createGetCommand(deps));
  session.addCommand(createDirCommand(deps));
  session.addCommand(createStartCommand());
  session.addCommand(createDeleteCommand());
  session.addCommand(createUpdateCommand(gitService, sessionDb));

  return session;
} 
