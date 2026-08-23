/**
 * The credential-request payload contract (mt#4030).
 *
 * Lives in `shared` rather than `domain` because BOTH sides need it: the domain
 * builds and resolves the request, and the browser-bundled cockpit reads it off
 * an ask to decide which control to render. `@minsky/domain/credentials/request`
 * is Node-reaching and cannot be evaluated in the browser bundle
 * (`custom/no-node-import-in-cockpit-web`, mt#3239), so the shape that crosses
 * that boundary is defined here and re-exported there — one definition, two
 * consumers, no duplicated key string that could drift.
 *
 * **This is the render-mode dispatch contract** named by the mt#4030 ↔ mt#4447
 * seam decision: a `metadata` key declares the payload, and the ask surface
 * selects a control from it. A second payload kind adds its own key and its own
 * branch, and shares nothing else.
 *
 * Nothing here can carry a credential value — the payload is a provider id.
 */

/**
 * Metadata key carrying the request payload on the ask row.
 *
 * The payload is the provider id and NOTHING else — `displayName`,
 * `configPath`, `acquireUrl` and `scopeGuidance` are resolved from the registry
 * at render time, so a card cannot drift from the provider it describes, and a
 * provider whose acquire URL changes needs no migration of historical rows.
 */
export const CREDENTIAL_REQUEST_METADATA_KEY = "credentialRequest";

/** The request payload as it is persisted, and as readers get it back. */
export interface CredentialRequestPayload {
  /** Registry id of the provider whose credential is being requested. */
  readonly provider: string;
}

/** The subset of an ask this reader needs — kept structural so both sides fit it. */
export interface CredentialRequestMetadataCarrier {
  metadata?: Record<string, unknown> | null;
}

/**
 * Read the request payload off an ask, or `null` when it is not one.
 *
 * Defensive about shape rather than trusting the jsonb column: `metadata` is
 * free-form and a row can predate, or sit outside, this feature entirely.
 */
export function readCredentialRequest(
  ask: CredentialRequestMetadataCarrier | null | undefined
): CredentialRequestPayload | null {
  const raw = ask?.metadata?.[CREDENTIAL_REQUEST_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const provider = (raw as { provider?: unknown }).provider;
  if (typeof provider !== "string" || provider.length === 0) return null;
  return { provider };
}
