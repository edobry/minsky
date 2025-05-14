import { Command } from "commander";
import { createGetCommand } from "./get.js";
import { createListCommand } from "./list.js";
import { createSearchCommand } from "./search.js";
import { createCommand as createCreateCommand } from "./create.js";
import { createUpdateCommand } from "./update.js";
import { createSyncCommand } from "./sync.js";

export function createRulesCommand(): Command {
  const rulesCommand = new Command("rules")
    .description("Manage Minsky rules")
    .addCommand(createGetCommand())
    .addCommand(createListCommand())
    .addCommand(createSearchCommand())
    .addCommand(createCreateCommand)
    .addCommand(createUpdateCommand())
    .addCommand(createSyncCommand());

  return rulesCommand;
}
