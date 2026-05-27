/**
 * Credentials components (mt#1426, mt#2137)
 *
 * Two exports:
 *   - CredentialsManager — full CRUD form for the Settings page
 *   - CredentialsSummary — compact status widget for the homepage grid
 *
 * Both share the same TanStack Query cache key (["credentials"]) and
 * the same API fetch helpers.
 */
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
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
// Static provider metadata
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

function AddCredentialForm() {
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
      setValidateResult(null);
      setValidateError(err.message);
    },
  });

  const addMutation = useMutation<AddCredentialResult, Error, { provider: string; token: string }>({
    mutationFn: ({ provider, token: t }) => addCredential(provider, t),
    onSuccess: () => {
      setToken("");
      setValidateResult(null);
      setValidateError(null);
      void queryClient.invalidateQueries({ queryKey: ["credentials"] });
    },
    onError: (err) => {
      if (err instanceof CredentialApiError && err.code === "validation_failed" && err.validate) {
        setValidateResult(err.validate);
        setValidateError(null);
      } else {
        setValidateError(err.message);
      }
    },
  });

  useEffect(() => {
    if (!addMutation.isSuccess) return;
    const timer = setTimeout(() => addMutation.reset(), 3000);
    return () => clearTimeout(timer);
  }, [addMutation.isSuccess]);

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
        <div className="flex flex-col gap-1.5 sm:w-48">
          <label
            htmlFor="cred-provider-select"
            className="text-xs font-medium text-muted-foreground"
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
              addMutation.reset();
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

        <div className="flex flex-col gap-1.5 flex-1">
          <label
            htmlFor="cred-token-input"
            className="text-xs font-medium text-muted-foreground"
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
              setValidateResult(null);
              setValidateError(null);
              addMutation.reset();
            }}
            placeholder="Paste token here..."
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

        <div className="flex gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleValidate}
            disabled={!canSubmit || isWorking}
            aria-label="Validate token without saving"
          >
            {validateMutation.isPending ? "Validating..." : "Validate"}
          </Button>
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={!canSubmit || isWorking}
            aria-label="Validate and save token"
          >
            {addMutation.isPending ? "Adding..." : "Add"}
          </Button>
        </div>
      </div>

      {providerMeta && (
        <div className="text-xs text-muted-foreground">
          <a
            href={providerMeta.acquireUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-2 hover:underline"
            aria-label={`Generate ${providerMeta.displayName} token`}
          >
            Generate token &rarr;
          </a>
          <span className="ml-2">{providerMeta.scopeGuidance}</span>
        </div>
      )}

      {validateResult && (
        <ValidationResult result={validateResult} label="Validate" />
      )}

      {validateError && !validateResult && (
        <div
          className="flex items-start gap-2 rounded px-2 py-1.5 text-xs bg-destructive/10 text-destructive"
          role="alert"
          aria-live="assertive"
        >
          <span className="flex-shrink-0 font-mono select-none" aria-hidden="true">{"✗"}</span>
          <span>{validateError}</span>
        </div>
      )}

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
// Provider row for the full management table
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
    <div className="flex items-center gap-4 py-2.5 border-b border-border last:border-0">
      <span
        aria-label={listing.configured ? "Configured" : "Not configured"}
        className={cn(
          "inline-block h-2 w-2 rounded-full flex-shrink-0",
          listing.configured ? "bg-primary" : "bg-muted"
        )}
      />

      <div className="w-32 flex-shrink-0">
        <span className="text-sm font-medium">{listing.displayName}</span>
      </div>

      <div className="flex-1 min-w-0">
        {listing.lastValidationDetail && (
          <span className="text-xs text-muted-foreground truncate block">
            {listing.lastValidationDetail}
          </span>
        )}
      </div>

      <span
        className={cn(
          "text-xs px-2 py-0.5 rounded flex-shrink-0",
          listing.configured
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        )}
      >
        {listing.configured ? "Configured" : "Not configured"}
      </span>

      {listing.lastValidatedAt && (
        <span
          className="text-xs text-muted-foreground flex-shrink-0 tabular-nums w-16 text-right"
          title={listing.lastValidatedAt}
        >
          {formatRelative(listing.lastValidatedAt)}
        </span>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="flex-shrink-0 text-xs h-7 px-2 text-muted-foreground hover:text-destructive"
        disabled={!listing.configured || isRemoving}
        onClick={onRemove}
        aria-label={`Remove ${listing.displayName} credential`}
      >
        {isRemoving ? "Removing..." : "Remove"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CredentialsManager — full management UI for the Settings page
// ---------------------------------------------------------------------------

export function CredentialsManager() {
  const queryClient = useQueryClient();

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
      <div className="text-muted-foreground text-sm">
        Failed to load credentials: {query.error.message}
      </div>
    );
  }

  if (query.isLoading || !query.data) {
    return (
      <div className="text-muted-foreground text-sm">Loading...</div>
    );
  }

  const credentials = query.data;

  return (
    <div className="space-y-6">
      <AddCredentialForm />

      <div className="border-t border-border" />

      {credentials.length === 0 ? (
        <p className="text-sm text-muted-foreground">No credential providers registered.</p>
      ) : (
        <div>
          <div className="flex items-center gap-4 py-1.5 border-b border-border">
            <span className="inline-block h-2 w-2 flex-shrink-0" aria-hidden="true" />
            <span className="w-32 flex-shrink-0 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Provider
            </span>
            <span className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Detail
            </span>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0">
              Status
            </span>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 w-16 text-right tabular-nums">
              Validated
            </span>
            <span className="flex-shrink-0 w-16" />
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// CredentialsSummary — compact homepage widget showing config status
// ---------------------------------------------------------------------------

export function CredentialsSummary() {
  const query = useQuery<CredentialListing[], Error>({
    queryKey: ["credentials"],
    queryFn: fetchCredentials,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (query.isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Credentials</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Failed to load</p>
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
          <p>Loading...</p>
        </CardContent>
      </Card>
    );
  }

  const credentials = query.data;
  const configured = credentials.filter((c) => c.configured).length;
  const total = credentials.length;
  const allConfigured = configured === total && total > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">Credentials</CardTitle>
          <Link
            to="/settings"
            className="text-xs text-primary hover:underline underline-offset-2"
          >
            Manage &rarr;
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3 mb-3">
          <span
            className={cn(
              "inline-block h-2.5 w-2.5 rounded-full flex-shrink-0",
              allConfigured ? "bg-primary" : configured > 0 ? "bg-yellow-500" : "bg-destructive"
            )}
          />
          <span className="text-sm font-medium tabular-nums">
            {configured}/{total} configured
          </span>
        </div>

        <div className="space-y-1">
          {credentials.map((c) => (
            <div key={c.provider} className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full flex-shrink-0",
                  c.configured ? "bg-primary" : "bg-muted"
                )}
              />
              <span className="text-xs text-muted-foreground">{c.displayName}</span>
              {!c.configured && (
                <span className="text-xs text-muted-foreground/60">— not configured</span>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
