import { Command } from "commander";
import { createStartCommand } from "./start-command";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

/**
 * Create the cockpit command
 */
export function createCockpitCommand(_container?: AppContainerInterface): Command {
  const cockpitCommand = new Command("cockpit");
  cockpitCommand.description("Cockpit dashboard server commands");

  cockpitCommand.addCommand(createStartCommand());

  return cockpitCommand;
}
