/**
 * Types for the GitHub App provisioning domain.
 *
 * @see mt#1087 — minsky setup github-app shared command
 */

/**
 * Specification for a GitHub App manifest.
 * Describes the desired App configuration before it is created.
 */
export interface AppManifestSpec {
  /** App name (also used as file prefix under the credential store directory). */
  name: string;
  /** Target repository in owner/repo form. */
  repo: string;
  /** Repository owner (derived from repo). */
  owner: string;
  /** Permission map (e.g. { pull_requests: "write", contents: "read" }). */
  permissions: Record<string, string>;
  /** GitHub webhook events to subscribe to. */
  events: string[];
  /** Webhook URL to prefill. Defaults to placeholder if omitted. */
  webhookUrl?: string;
  /** Create the App with webhooks inactive. */
  inactive: boolean;
}

/**
 * Credentials returned after a successful GitHub App provisioning.
 */
export interface AppCredentials {
  /** Numeric GitHub App ID. */
  appId: number;
  /** URL-safe slug for the App. */
  slug: string;
  /** OAuth client ID. */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /** PEM-encoded RSA private key. */
  pem: string;
  /** App's HTML URL on GitHub. */
  htmlUrl: string;
  /** Installation ID on the target repo/owner (may be absent until installed). */
  installationId?: number;
}
