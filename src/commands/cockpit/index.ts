import { Command } from "commander";
import { createStartCommand } from "./start-command";
import { createInstallCommand } from "./install-command";
import { createUninstallCommand } from "./uninstall-command";
import { createStatusCommand } from "./status-command";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

/**
 * Create the cockpit command
 */
export function createCockpitCommand(_container?: AppContainerInterface): Command {
  const cockpitCommand = new Command("cockpit");
  cockpitCommand.description("Cockpit dashboard server commands");

  cockpitCommand.addCommand(createStartCommand());
  cockpitCommand.addCommand(createInstallCommand());
  cockpitCommand.addCommand(createUninstallCommand());
  cockpitCommand.addCommand(createStatusCommand());

  return cockpitCommand;
}
