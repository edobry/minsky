import { Command } from "commander";
import { createListCommand } from "./list";
import { createGetCommand } from "./get";
import { createDirCommand } from "./cd";
import { createStartCommand } from "./start";
import { createDeleteCommand } from "./delete";
import { createUpdateCommand } from "./update";
import { GitService } from "../../domain/git";
import { SessionDB } from "../../domain/session";

export function createSessionCommand(): Command {
  const gitService = new GitService();
  const sessionDb = new SessionDB();

  const session = new Command("session")
    .description("Session management commands");

  session.addCommand(createListCommand());
  session.addCommand(createGetCommand());
  session.addCommand(createDirCommand());
  session.addCommand(createStartCommand());
  session.addCommand(createDeleteCommand());
  session.addCommand(createUpdateCommand(gitService, sessionDb));

  return session;
} 
