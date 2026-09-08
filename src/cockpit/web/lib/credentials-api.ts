/**
 * Credential API client — the single browser-side path to `/api/credentials/*`.
 *
 * Extracted from `widgets/Credentials.tsx` (mt#4030) because there are now TWO
 * surfaces that enter a credential: the Settings page form, and the masked entry
 * form rendered on an agent-initiated credential request (`AskDetail`). Both must
 * post to the SAME route — mt#4030's spec requires reusing the existing
 * `POST /api/credentials/add` path rather than introducing a second storage path,
 * and the cheapest way to guarantee that is for there to be exactly one client.
 *
 * **Data-path invariant.** The value travels browser → cockpit server →
 * `~/.config/minsky/config.yaml`. Nothing here returns a stored credential, and
 * nothing here may be routed through the ask API, the MCP server, or an agent's
 * context.
 *
 * Types mirror the domain rather than importing server code, which is why this
 * lives under `web/lib` next to the other browser-side modules.
 *
 * @see src/cockpit/routes/credentials.ts — the routes this calls
 */

/** Result of a provider's own validation probe. Carries a status line, never a value. */
export interface CredentialCheckResult {
  ok: boolean;
  /** What just happened, in full. Rendered transiently and untruncated. */
  detail: string;
  /** The same fact as a short state, for a status column. See `credentialStatusLine`. */
  status?: string;
  unauthorized?: boolean;
  scopeGap?: boolean;
}

/** What `POST /api/credentials/add` returns. Deliberately contains no token. */
export interface AddCredentialResult {
  provider: string;
  validate: CredentialCheckResult;
  stored?: { configFilePath: string };
  test?: CredentialCheckResult;
}

/** Provider registry metadata, as served to the browser. */
export interface ProviderMeta {
  id: string;
  displayName: string;
  acquireUrl: string;
  scopeGuidance: string;
}

/** One configured-or-not credential row. */
export interface CredentialListing {
  provider: string;
  displayName: string;
  configPath: string;
  configured: boolean;
  /**
   * "provider" — a managed credential: add/remove/recheck all work.
   * "schema" — presence-only, derived from the config schema with no provider
   * module behind it. `removeCredential` would throw "Unknown credential
   * provider" for these, so the row must not offer the action (mt#3569).
   *
   * Optional only for wire-compat with a server that predates the field. Absence
   * means "provider", not "unknown": a server without this field also has no
   * schema-derived rows, so everything it sends IS manageable. Treating absence as
   * unmanaged would strip Remove from every row against such a server — which is
   * how the first draft broke an existing widget test.
   */
  source?: "provider" | "schema";
  lastValidatedAt?: string;
  /**
   * The full sentence from the last successful check. Belongs in a tooltip or a
   * transient surface — NOT in the providers table's Detail column, which is
   * ~276px wide (mt#5031). Read it through `credentialStatusLine`.
   */
  lastValidationDetail?: string;
  /** Short state form of the last successful check. Absent on pre-mt#5031 rows. */
  lastValidationStatus?: string;
}

/**
 * Character budget for a value bound for the providers table's Detail column.
 *
 * Mirrors `MAX_STATUS_LENGTH` in `packages/domain/src/credentials/types.ts` —
 * duplicated rather than imported, per this module's standing convention of
 * mirroring domain types instead of importing server code (see the file
 * docblock). The domain constant carries the derivation.
 */
export const MAX_STATUS_LENGTH = 40;

/**
 * What the providers table's Detail column should show for a row — or `null`
 * when the honest answer is nothing.
 *
 * The column asks "what is currently TRUE of this credential", which is not the
 * question `lastValidationDetail` answers ("what happened when it was last
 * checked"). Rendering the latter there truncated two providers' strings to
 * roughly half and showed the operator an event where a state belonged
 * (mt#5031). So the column reads this function, and never
 * `lastValidationDetail` directly.
 *
 * The precedence, and why each rung exists:
 *
 *   1. The provider's own `status`, when it supplied one — the most specific
 *      thing anyone can say, and already sized for the column.
 *   2. Nothing, for a presence-only (`schema`) row. No provider module backs
 *      it, so no check has ever run and there is no check-status to report; the
 *      row's Configured badge and its `config-only` marker already carry its
 *      whole state. This is the one case where an empty cell is the correct
 *      answer rather than a gap.
 *   3. Nothing, for an unconfigured provider. The Status column says
 *      "Not configured"; repeating it here is noise.
 *   4. A SHORT stored detail, as a back-compat bridge. Every row written before
 *      the split has a detail and no status, and most of those details are
 *      already state-shaped and well inside the budget ("4 projects visible").
 *      Dropping them all to a generic "validated" until each credential
 *      happens to be rechecked would make the column WORSE for most rows in
 *      order to fix it for two. The length test is what makes this safe: it
 *      cannot truncate, because anything over budget takes rung 5 instead.
 *   5. A state derived from what the listing already knows. Covers the long
 *      pre-split details, a provider that supplies no status, and the
 *      configured-but-never-checked row that used to render as an empty cell
 *      indistinguishable from "nothing to report".
 *
 * Pure and exported so it can be tested without a DOM, alongside `isManaged`.
 */
export function credentialStatusLine(listing: CredentialListing): string | null {
  if (listing.lastValidationStatus) return listing.lastValidationStatus;
  if (listing.source === "schema") return null;
  if (!listing.configured) return null;

  const detail = listing.lastValidationDetail;
  if (detail && detail.length <= MAX_STATUS_LENGTH) return detail;

  return listing.lastValidatedAt ? "validated" : "configured, never checked";
}

/**
 * Whether this entry supports add/remove/recheck. See `source`.
 *
 * Keyed on the presence of "schema" rather than the presence of "provider" so an
 * absent field keeps the pre-mt#3569 behavior exactly.
 */
export function isManaged(listing: CredentialListing): boolean {
  return listing.source !== "schema";
}

export type CredentialApiErrorCode =
  | "invalid_body"
  | "missing_field"
  | "unknown_provider"
  | "validation_failed"
  | "internal";

interface CredentialApiErrorBody {
  error?: { code?: CredentialApiErrorCode; message?: string };
  validate?: CredentialCheckResult;
}

/**
 * A failed credential API call.
 *
 * `validate` is populated on the `validation_failed` path so a caller can render
 * the provider's own rejection reason inline ("401 — that's the anon key; you
 * want service_role") and let the principal retry in place.
 */
export class CredentialApiError extends Error {
  readonly code: CredentialApiErrorCode | "unknown";
  readonly validate?: CredentialCheckResult;
  constructor(
    code: CredentialApiErrorCode | "unknown",
    message: string,
    validate?: CredentialCheckResult
  ) {
    super(message);
    this.name = "CredentialApiError";
    this.code = code;
    this.validate = validate;
  }
}

/**
 * Map an error code to text safe to show a human.
 *
 * Deliberately generic: a server-side message could carry request detail, and
 * this surface is one the principal is pasting a secret into.
 */
function userSafeMessage(code: CredentialApiErrorCode | "unknown", fallback: string): string {
  switch (code) {
    case "invalid_body":
      return "The request could not be processed. Try again.";
    case "missing_field":
      return "Required information is missing. Re-check the form and try again.";
    case "unknown_provider":
      return "Unknown credential provider.";
    case "validation_failed":
      return "Credential validation failed.";
    case "internal":
      return "Something went wrong. Try again, or check the cockpit logs.";
    default:
      return fallback;
  }
}

async function parseApiError(res: Response, fallback: string): Promise<CredentialApiError> {
  let body: CredentialApiErrorBody = {};
  try {
    body = (await res.json()) as CredentialApiErrorBody;
  } catch {
    // Body wasn't JSON — fall through to the fallback message
  }
  const code = body.error?.code ?? "unknown";
  const message = userSafeMessage(code, fallback);
  return new CredentialApiError(code, message, body.validate);
}

export async function fetchCredentials(): Promise<CredentialListing[]> {
  const res = await fetch("/api/credentials");
  if (!res.ok) {
    throw await parseApiError(res, "Failed to load credentials.");
  }
  const data = (await res.json()) as { credentials: CredentialListing[] };
  return data.credentials;
}

export async function fetchProviders(): Promise<ProviderMeta[]> {
  const res = await fetch("/api/credentials/providers");
  if (!res.ok) {
    throw await parseApiError(res, "Failed to load credential providers.");
  }
  const data = (await res.json()) as { providers: ProviderMeta[] };
  return data.providers;
}

export async function validateCredential(
  provider: string,
  token: string
): Promise<CredentialCheckResult> {
  const res = await fetch("/api/credentials/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, token }),
  });
  if (!res.ok) {
    throw await parseApiError(res, "Validation failed.");
  }
  return res.json() as Promise<CredentialCheckResult>;
}

export async function addCredential(provider: string, token: string): Promise<AddCredentialResult> {
  const res = await fetch("/api/credentials/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, token }),
  });
  if (!res.ok) {
    throw await parseApiError(res, "Could not add credential.");
  }
  return res.json() as Promise<AddCredentialResult>;
}

export async function removeCredential(provider: string): Promise<{ removed: boolean }> {
  const res = await fetch(`/api/credentials/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw await parseApiError(res, "Could not remove credential.");
  }
  return res.json() as Promise<{ removed: boolean }>;
}
