/**
 * Credential subsystem (mt#1426) — provider-agnostic lifecycle for tokens
 * Minsky persists in `~/.config/minsky/config.yaml`.
 *
 * The CLI surface (`minsky config credentials {add,list,remove}`) and the
 * cockpit `/credentials` page both consume this module.
 */
export type { CredentialProvider, CredentialCheckResult } from "./types";
export {
  KNOWN_PROVIDER_IDS,
  getCredentialProvider,
  listCredentialProviders,
} from "./providers/index";
export {
  addCredential,
  listCredentials,
  removeCredential,
  type AddCredentialResult,
  type CredentialListing,
} from "./lifecycle";
