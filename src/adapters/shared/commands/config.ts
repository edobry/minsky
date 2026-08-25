/**
 * Shared Config Commands
 *
 * Barrel re-export — sub-modules contain the actual implementations:
 *   - config/helpers.ts                — maskCredentials, parseConfigValue, gatherCredentialInfo
 *   - config/list-show-commands.ts     — config.list, config.show
 *   - config/get-set-commands.ts       — config.get, config.set, config.unset
 *   - config/validate-doctor-commands.ts — config.validate, config.doctor
 */

import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { sharedCommandRegistry } from "../command-registry";
import {
  createCredentialRequestRegistration,
  createCredentialRequestStatusRegistration,
} from "./config/credential-request-command";
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
import {
  configCredentialsAddRegistration,
  configCredentialsListRegistration,
  configCredentialsRemoveRegistration,
  configCredentialsRecheckRegistration,
} from "./config/credentials-commands";

/**
 * Register all config commands.
 *
 * @param container Optional DI container. `credentials.request` (mt#4030) writes
 *   an Ask, so it needs the same repository resolution every other ask-writing
 *   command uses; the parameter is optional so existing callers are unaffected.
 */
export function registerConfigCommands(container?: AppContainerInterface) {
  sharedCommandRegistry.registerCommand(configListRegistration);
  sharedCommandRegistry.registerCommand(configShowRegistration);
  sharedCommandRegistry.registerCommand(configGetRegistration);
  sharedCommandRegistry.registerCommand(configSetRegistration);
  sharedCommandRegistry.registerCommand(configUnsetRegistration);
  sharedCommandRegistry.registerCommand(configValidateRegistration);
  sharedCommandRegistry.registerCommand(configDoctorRegistration);
  sharedCommandRegistry.registerCommand(configCredentialsAddRegistration);
  sharedCommandRegistry.registerCommand(configCredentialsListRegistration);
  sharedCommandRegistry.registerCommand(configCredentialsRemoveRegistration);
  sharedCommandRegistry.registerCommand(configCredentialsRecheckRegistration);
  sharedCommandRegistry.registerCommand(createCredentialRequestRegistration(container));
  sharedCommandRegistry.registerCommand(createCredentialRequestStatusRegistration(container));
}
