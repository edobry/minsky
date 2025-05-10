import { Command } from "commander";
import { createListCommand } from "./list.js";
import { createGetCommand } from "./get.js";
import { createDirCommand } from "./dir.js";
import { createStartCommand } from "./start.js";
import { createDeleteCommand } from "./delete.js";
import { createUpdateCommand } from "./update.js";
import { createCommitCommand, type CommitCommandDependencies } from "./commit.js";
import { getCurrentSession as defaultGetCurrentSession } from "../../domain/workspace.js";
import { GitService } from "../../domain/git.js";
import { SessionDB } from "../../domain/session.js";

// Add a dependencies parameter to allow dependency injection for testing
export interface SessionCommandDependencies {
  getCurrentSession?: typeof defaultGetCurrentSession;
  gitService?: GitService;
  sessionDb?: SessionDB;
}

export function createSessionCommand(dependencies: SessionCommandDependencies = {}): Command {
  // Use provided dependencies or fall back to defaults
  const gitService = dependencies?.gitService || new GitService();
  const sessionDb = dependencies?.sessionDb || new SessionDB();
  const getCurrentSession = dependencies?.getCurrentSession || defaultGetCurrentSession;

  const commandDeps = {
    getCurrentSession
  };

  const commitCommandDeps: CommitCommandDependencies = {
    gitService,
    sessionDb,
    getCurrentSession
  };

  const session = new Command("session")
    .description("Session management commands");

  session.addCommand(createListCommand());
  session.addCommand(createGetCommand(commandDeps));
  session.addCommand(createDirCommand(commandDeps));
  session.addCommand(createStartCommand());
  session.addCommand(createDeleteCommand());
  session.addCommand(createUpdateCommand(gitService, sessionDb));
  session.addCommand(createCommitCommand(commitCommandDeps));

  return session;
} 
