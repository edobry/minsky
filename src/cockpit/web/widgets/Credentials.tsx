/**
 * Credentials widget (mt#1426)
 *
 * Cockpit surface for the credential lifecycle: list known providers, add
 * credentials with inline validation feedback, and remove stored credentials.
 *
 * Architecture note: The task spec described this as a "/credentials route."
 * Cockpit v0 has no client-side router; this slice takes the widget-path
 * instead: the credentials surface is a self-fetching widget on the cockpit
 * home grid, consistent with the existing architecture (Agents, Attention, etc.).
 * A route-based view can be added when Cockpit adopts TanStack Router.
 *
 * State management:
 *   - useQuery({ queryKey: ["credentials"] }) — list all providers + status
 *   - useMutation for validate, add, remove (invalidate ["credentials"] on add/remove)
 *   - Password input value is React state only; cleared after successful add.
 *   - Token value NEVER appears in network responses (enforced server-side);
 *     cleared from React state immediately after mutation completes.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// API types — mirrors domain types without importing server code
// ---------------------------------------------------------------------------

interface CredentialListing {
  provider: string;
  displayName: string;
  configPath: string;
  configured: boolean;
  lastValidatedAt?: string;
  lastValidationDetail?: string;
}

interface CredentialCheckResult {
  ok: boolean;
  detail: string;
  unauthorized?: boolean;
  scopeGap?: boolean;
}

interface AddCredentialResult {
  provider: string;
  validate: CredentialCheckResult;
  stored?: { configFilePath: string };
  test?: CredentialCheckResult;
}

interface ProviderMeta {
  id: string;
  displayName: string;
  acquireUrl: string;
  scopeGuidance: string;
}

// ---------------------------------------------------------------------------
// Static provider metadata — matches the four registered providers.
// Kept inline rather than fetching from the server to avoid a dependency
// on a new API endpoint; the provider list is stable and small.
// ---------------------------------------------------------------------------

const PROVIDER_META: ProviderMeta[] = [
  {
    id: "supabase",
    displayName: "Supabase",
    acquireUrl: "https://supabase.com/dashboard/account/tokens",
    scopeGuidance:
      "Personal access token. Requires 'projects:read' scope for smoke-test to pass.",
  },
  {
    id: "github",
    displayName: "GitHub",
    acquireUrl: "https://github.com/settings/tokens/new",
    scopeGuidance:
      "Personal access token (classic or fine-grained). Requires 'repo' scope for PR operations.",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    acquireUrl: "https://console.anthropic.com/settings/keys",
    scopeGuidance: "API key from the Anthropic console. Used for Claude model access.",
  },
  {
    id: "railway",
    displayName: "Railway",
    acquireUrl: "https://railway.app/account/tokens",
    scopeGuidance:
      "Account or workspace API token. Used by Pulumi for Railway IaC management.",
  },
];

// ---------------------------------------------------------------------------
// API fetch helpers
// ---------------------------------------------------------------------------

/**
 * Normalized API error shape per PR #1142 R1 (mt#1426).
 *
 * The server always returns `{ error: { code, message } }` for failures, with
 * stable `code` values that the UI can map deterministically. The optional
 * `validate` extra rides along on `code: "validation_failed"` so the form can
 * render structured `unauthorized` / `scopeGap` states without parsing prose.
 */
type CredentialApiErrorCode =
  | "invalid_body"
  | "missing_field"
  | "unknown_provider"
  | "validation_failed"
  | "internal";

interface CredentialApiErrorBody {
  error?: { code?: CredentialApiErrorCode; message?: string };
  validate?: CredentialCheckResult;
}

/** Error thrown by the fetch helpers carrying the normalized API shape. */
export class CredentialApiError extends Error {
  readonly code: CredentialApiErrorCode | "unknown";
  readonly validate?: CredentialCheckResult;
  constructor(code: CredentialApiErrorCode | "unknown", message: string, validate?: CredentialCheckResult) {
    super(message);
    this.name = "CredentialApiError";
    this.code = code;
    this.validate = validate;
  }
}

/**
 * Map a stable API error code to a user-safe display string. The server's
 * `message` field is already user-safe, but we keep this mapping as the
 * canonical source of UI copy so the server can evolve its phrasing without
 * affecting what the user sees.
 */
function userSafeMessage(
  code: CredentialApiErrorCode | "unknown",
  fallback: string
): string {
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

async function fetchCredentials(): Promise<CredentialListing[]> {
  const res = await fetch("/api/credentials");
  if (!res.ok) {
    throw await parseApiError(res, "Failed to load credentials.");
  }
  const data = (await res.json()) as { credentials: CredentialListing[] };
  return data.credentials;
}

async function validateCredential(
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

async function addCredential(
  provider: string,
  token: string
): Promise<AddCredentialResult> {
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

async function removeCredential(provider: string): Promise<{ removed: boolean }> {
  const res = await fetch(`/api/credentials/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw await parseApiError(res, "Could not remove credential.");
  }
  return res.json() as Promise<{ removed: boolean }>;
}

// ---------------------------------------------------------------------------
// Relative-time helper
// ---------------------------------------------------------------------------

function formatRelative(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return "unknown";
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ---------------------------------------------------------------------------
// Validate/add result inline feedback
// ---------------------------------------------------------------------------

function ValidationResult({
  result,
  label,
}: {
  result: CredentialCheckResult;
  label?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded px-2 py-1.5 text-xs",
        result.ok
          ? "bg-accent/20 text-foreground"
          : "bg-destructive/10 text-destructive"
      )}
      role="status"
      aria-live="polite"
    >
      <span className="flex-shrink-0 font-mono select-none" aria-hidden="true">
        {result.ok ? "✓" : "✗"}
      </span>
      <span>
        {label && <span className="font-medium">{label}: </span>}
        {result.detail}
        {result.scopeGap && (
          <span className="ml-1 text-muted-foreground">(scope gap — token stored)</span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add form sub-component
// ---------------------------------------------------------------------------

function AddCredentialForm({ onAdded }: { onAdded: () => void }) {
  const [selectedProvider, setSelectedProvider] = useState<string>(PROVIDER_META[0]?.id ?? "");
  const [token, setToken] = useState("");
  const [validateResult, setValidateResult] = useState<CredentialCheckResult | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const validateMutation = useMutation<CredentialCheckResult, Error, { provider: string; token: string }>({
    mutationFn: ({ provider, token: t }) => validateCredential(provider, t),
    onSuccess: (result) => {
      setValidateResult(result);
      setValidateError(null);
    },
    onError: (err) => {
      // `CredentialApiError.message` is the user-safe copy from `userSafeMessage`,
      // not the raw server error. We never display the raw exception text.
      setValidateResult(null);
      setValidateError(err.message);
    },
  });

  const addMutation = useMutation<AddCredentialResult, Error, { provider: string; token: string }>({
    mutationFn: ({ provider, token: t }) => addCredential(provider, t),
    onSuccess: () => {
      // Clear the token from React state immediately after successful add
      setToken("");
      setValidateResult(null);
      setValidateError(null);
      void queryClient.invalidateQueries({ queryKey: ["credentials"] });
      onAdded();
    },
    onError: (err) => {
      // When the server's `code: "validation_failed"` carries a structured
      // `validate` payload (unauthorized / scopeGap / detail), surface those
      // fields via the inline ValidationResult component rather than the
      // generic error banner — preserves the structured states the reviewer
      // (PR #1142 R1) flagged as previously lost.
      if (err instanceof CredentialApiError && err.code === "validation_failed" && err.validate) {
        setValidateResult(err.validate);
        setValidateError(null);
      } else {
        setValidateError(err.message);
      }
    },
  });

  const providerMeta = PROVIDER_META.find((p) => p.id === selectedProvider);
  const canSubmit = selectedProvider && token.length > 0;
  const isWorking = validateMutation.isPending || addMutation.isPending;

  function handleValidate() {
    if (!canSubmit || isWorking) return;
    setValidateResult(null);
    setValidateError(null);
    validateMutation.mutate({ provider: selectedProvider, token });
  }

  function handleAdd() {
    if (!canSubmit || isWorking) return;
    setValidateResult(null);
    setValidateError(null);
    addMutation.mutate({ provider: selectedProvider, token });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
        {/* Provider selector */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor="cred-provider-select"
            className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
          >
            Provider
          </label>
          <select
            id="cred-provider-select"
            value={selectedProvider}
            onChange={(e) => {
              setSelectedProvider(e.target.value);
              setValidateResult(null);
              setValidateError(null);
            }}
            className={cn(
              "h-9 rounded-md border border-input bg-background px-3 py-1 text-sm",
              "ring-offset-background focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-50"
            )}
            disabled={isWorking}
            aria-label="Select credential provider"
          >
            {PROVIDER_META.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>

        {/* Token input */}
        <div className="flex flex-col gap-1 flex-1">
          <label
            htmlFor="cred-token-input"
            className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
          >
            Token
          </label>
          <input
            id="cred-token-input"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              // Clear previous results when user edits the token
              setValidateResult(null);
              setValidateError(null);
            }}
            placeholder="Paste token here…"
            className={cn(
              "h-9 rounded-md border border-input bg-background px-3 py-1 text-sm",
              "ring-offset-background focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-50",
              "placeholder:text-muted-foreground"
            )}
            disabled={isWorking}
            aria-label="Paste credential token"
          />
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 items-end flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleValidate}
            disabled={!canSubmit || isWorking}
            aria-label="Validate token without saving"
          >
            {validateMutation.isPending ? "Validating…" : "Validate"}
          </Button>
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={!canSubmit || isWorking}
            aria-label="Validate and save token"
          >
            {addMutation.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
      </div>

      {/* Acquire link + scope guidance */}
      {providerMeta && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <a
            href={providerMeta.acquireUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-2 hover:underline flex-shrink-0"
            aria-label={`Generate ${providerMeta.displayName} token`}
          >
            Generate token →
          </a>
          <span>{providerMeta.scopeGuidance}</span>
        </div>
      )}

      {/* Validation result inline */}
      {validateResult && (
        <ValidationResult result={validateResult} label="Validate" />
      )}

      {/* Error feedback (validate or add error) */}
      {validateError && !validateResult && (
        <div
          className="flex items-start gap-2 rounded px-2 py-1.5 text-xs bg-destructive/10 text-destructive"
          role="alert"
          aria-live="assertive"
        >
          <span className="flex-shrink-0 font-mono select-none" aria-hidden="true">✗</span>
          <span>{validateError}</span>
        </div>
      )}

      {/* Add success result */}
      {addMutation.isSuccess && addMutation.data && (
        <div className="space-y-1">
          {addMutation.data.validate && (
            <ValidationResult result={addMutation.data.validate} label="Validate" />
          )}
          {addMutation.data.stored && (
            <div className="text-xs text-muted-foreground px-2">
              Stored at {addMutation.data.stored.configFilePath}
            </div>
          )}
          {addMutation.data.test && (
            <ValidationResult result={addMutation.data.test} label="Smoke test" />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single credential row
// ---------------------------------------------------------------------------

function CredentialRow({
  listing,
  onRemove,
  isRemoving,
}: {
  listing: CredentialListing;
  onRemove: () => void;
  isRemoving: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-border last:border-0">
      {/* Configured indicator */}
      <span
        aria-label={listing.configured ? "Configured" : "Not configured"}
        className={cn(
          "inline-block h-2 w-2 rounded-full flex-shrink-0",
          listing.configured ? "bg-primary" : "bg-muted"
        )}
      />

      {/* Provider name + last validated */}
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium">{listing.displayName}</span>
        {listing.lastValidationDetail && (
          <span className="block text-xs text-muted-foreground truncate">
            {listing.lastValidationDetail}
          </span>
        )}
      </div>

      {/* Configured badge */}
      <span
        className={cn(
          "text-xs px-1.5 py-0.5 rounded flex-shrink-0",
          listing.configured
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        )}
      >
        {listing.configured ? "Configured" : "Not configured"}
      </span>

      {/* Last validated */}
      {listing.lastValidatedAt && (
        <span
          className="text-xs text-muted-foreground flex-shrink-0 tabular-nums"
          title={listing.lastValidatedAt}
        >
          {formatRelative(listing.lastValidatedAt)}
        </span>
      )}

      {/* Remove button */}
      <Button
        variant="ghost"
        size="sm"
        className="flex-shrink-0 text-xs h-7 px-2"
        disabled={!listing.configured || isRemoving}
        onClick={onRemove}
        aria-label={`Remove ${listing.displayName} credential`}
      >
        {isRemoving ? "Removing…" : "Remove"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main widget component — self-fetching via TanStack Query
// ---------------------------------------------------------------------------

export function Credentials() {
  const queryClient = useQueryClient();
  const [addedCount, setAddedCount] = useState(0);

  const query = useQuery<CredentialListing[], Error>({
    queryKey: ["credentials"],
    queryFn: fetchCredentials,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const removeMutation = useMutation<{ removed: boolean }, Error, string>({
    mutationFn: (provider) => removeCredential(provider),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["credentials"] });
    },
  });

  if (query.isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Credentials</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Failed to load credentials: {query.error.message}</p>
        </CardContent>
      </Card>
    );
  }

  if (query.isLoading || !query.data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Credentials</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const credentials = query.data;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">Credentials</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add form */}
        <AddCredentialForm
          // Reset form state when a credential is successfully added
          key={addedCount}
          onAdded={() => setAddedCount((n) => n + 1)}
        />

        {/* Divider */}
        <div className="border-t border-border" />

        {/* Provider list */}
        {credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credential providers registered.</p>
        ) : (
          <div>
            {/* Column headers */}
            <div className="flex items-center gap-3 py-1 mb-0.5 border-b border-border">
              <span className="inline-block h-2 w-2 flex-shrink-0" aria-hidden="true" />
              <span className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Provider
              </span>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0">
                Status
              </span>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 tabular-nums">
                Last validated
              </span>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 w-16" />
            </div>

            {credentials.map((listing) => (
              <CredentialRow
                key={listing.provider}
                listing={listing}
                onRemove={() => removeMutation.mutate(listing.provider)}
                isRemoving={
                  removeMutation.isPending &&
                  removeMutation.variables === listing.provider
                }
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
