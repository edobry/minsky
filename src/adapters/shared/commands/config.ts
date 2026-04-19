/**
 * Shared Config Commands
 *
 * Barrel re-export — sub-modules contain the actual implementations:
 *   - config/helpers.ts                — maskCredentials, parseConfigValue, gatherCredentialInfo
 *   - config/list-show-commands.ts     — config.list, config.show
 *   - config/get-set-commands.ts       — config.get, config.set, config.unset
 *   - config/validate-doctor-commands.ts — config.validate, config.doctor
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
