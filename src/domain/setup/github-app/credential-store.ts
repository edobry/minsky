/**
 * CredentialStore interface — axis 2 of the provisioner/credential-store split.
 *
 * Concrete implementations in v1:
 *   - LocalConfigCredentialStore — writes to ~/.config/minsky/<name>.{pem,json}.
 *
 * Future (out of scope for v1):
 *   - TenantCredentialStore — per-tenant DB-backed store for hosted Minsky.
 *
 * @see mt#1087
 */

import type { AppCredentials } from "./types";

/**
 * Interface for GitHub App credential stores.
 *
 * A credential store is responsible for persisting and retrieving App credentials.
 * It is intentionally separate from provisioning so the two axes can vary
 * independently.
 */
export interface CredentialStore {
  /**
   * Check whether credentials already exist for the given name.
   *
   * @param name App name (file prefix / key).
   */
  exists(name: string): Promise<boolean>;

  /**
   * Read existing credentials for the given name.
   *
   * @param name App name (file prefix / key).
   * @returns Credentials, or null if none exist.
   */
  read(name: string): Promise<AppCredentials | null>;

  /**
   * Persist credentials under the given name.
   *
   * @param name App name (file prefix / key).
   * @param creds Credentials to store.
   */
  write(name: string, creds: AppCredentials): Promise<void>;
}
