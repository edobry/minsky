/**
 * provisionGithubApp — orchestrator that wires a provisioner + credential store.
 *
 * Idempotent: if credentials already exist and force=false, returns
 * { status: "already-exists", credentials } without calling the provisioner.
 *
 * @see mt#1087
 */

import type { AppProvisioner } from "./provisioner";
import type { CredentialStore } from "./credential-store";
import type { AppManifestSpec, AppCredentials } from "./types";

export interface ProvisionGithubAppOptions {
  /** App name — used as the key in the credential store. */
  name: string;
  /** Manifest spec passed to the provisioner. */
  spec: AppManifestSpec;
  /** Credential store to check / write. */
  store: CredentialStore;
  /** Provisioner to use when credentials don't exist yet. */
  provisioner: AppProvisioner;
  /** When true, re-provisions even if credentials already exist. */
  force?: boolean;
}

export type ProvisionResult =
  | { status: "already-exists"; credentials: AppCredentials }
  | { status: "created"; credentials: AppCredentials };

/**
 * Orchestrate GitHub App provisioning with idempotent re-run detection.
 *
 * - If `store.exists(name)` and `force` is falsy → returns existing creds.
 * - Otherwise calls `provisioner.provision(spec)` then `store.write(name, creds)`.
 */
export async function provisionGithubApp(
  options: ProvisionGithubAppOptions
): Promise<ProvisionResult> {
  const { name, spec, store, provisioner, force = false } = options;

  if (!force && (await store.exists(name))) {
    const existing = await store.read(name);
    if (existing) {
      return { status: "already-exists", credentials: existing };
    }
  }

  const credentials = await provisioner.provision(spec);
  await store.write(name, credentials);
  return { status: "created", credentials };
}
