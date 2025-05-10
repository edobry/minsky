import { Command } from "commander";
import { createListCommand } from "./list.js";
import { createGetCommand } from "./get.js";
import { createCreateCommand } from "./create.js";
import { createUpdateCommand } from "./update.js";
import { createSearchCommand } from "./search.js";

export function createRulesCommand(): Command {
  const rules = new Command("rules")
    .description("Minsky rule management operations");

  rules.addCommand(createListCommand());
  rules.addCommand(createGetCommand());
  rules.addCommand(createCreateCommand());
  rules.addCommand(createUpdateCommand());
  rules.addCommand(createSearchCommand());

  return rules;
} 
