/**
 * Shared Config Commands
 *
 * Thin aggregator — delegates to sub-modules by command group.
 */

import { sharedCommandRegistry } from "../command-registry";
import { configListRegistration, configShowRegistration } from "./config/list-show-commands";
import {
  configGetRegistration,
  configSetRegistration,
  configUnsetRegistration,
} from "./config/get-set-commands";
import {
  configValidateRegistration,
  configDoctorRegistration,
} from "./config/validate-doctor-commands";

/**
 * Register all config commands
 */
export function registerConfigCommands() {
  sharedCommandRegistry.registerCommand(configListRegistration);
  sharedCommandRegistry.registerCommand(configShowRegistration);
  sharedCommandRegistry.registerCommand(configGetRegistration);
  sharedCommandRegistry.registerCommand(configSetRegistration);
  sharedCommandRegistry.registerCommand(configUnsetRegistration);
  sharedCommandRegistry.registerCommand(configValidateRegistration);
  sharedCommandRegistry.registerCommand(configDoctorRegistration);
}
