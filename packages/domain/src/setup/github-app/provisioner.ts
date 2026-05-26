/**
 * AppProvisioner interface — axis 1 of the provisioner/credential-store split.
 *
 * Two concrete implementations ship in v1:
 *   - ManifestFlowProvisioner — browser-based GitHub manifest flow (default).
 *   - GuidedWizardProvisioner — interactive prompts for enterprise/SSO environments.
 *
 * @see mt#1087
 */

import type { AppManifestSpec, AppCredentials } from "./types";

/**
 * Thrown when the user cancels or times out the App creation flow before
 * credentials are obtained. Nothing is persisted when this is thrown.
 */
export class BrowserCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserCancelledError";
  }
}

/**
 * Interface for GitHub App provisioners.
 *
 * A provisioner is responsible for creating a GitHub App and returning its
 * credentials. It must NOT persist credentials — that is the CredentialStore's
 * responsibility.
 */
export interface AppProvisioner {
  /**
   * Provision a GitHub App according to the given spec.
   *
   * @returns Full credentials for the newly created App.
   * @throws {BrowserCancelledError} When the user closes the browser or the
   *   flow times out before credentials are obtained.
   */
  provision(spec: AppManifestSpec): Promise<AppCredentials>;
}
