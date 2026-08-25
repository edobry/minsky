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
import { useQuery, useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { LinkCard } from "../components/ui/link-card";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import {
  type CredentialCheckResult,
  type AddCredentialResult,
  type ProviderMeta,
  type CredentialListing,
  CredentialApiError,
  isManaged,
  fetchCredentials,
  fetchProviders,
  validateCredential,
  addCredential,
  removeCredential,
} from "../lib/credentials-api";
import { CredentialValidationResult } from "../components/CredentialValidationResult";
// Re-exported: this module was the original home of the error class and other
// modules import it from here (mt#4030 moved the implementation, not the name).
export { CredentialApiError } from "../lib/credentials-api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

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

// ---------------------------------------------------------------------------
// Add form sub-component
// ---------------------------------------------------------------------------

function AddCredentialForm() {
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [token, setToken] = useState("");
  const [validateResult, setValidateResult] = useState<CredentialCheckResult | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const providersQuery = useQuery<ProviderMeta[], Error>({
    queryKey: ["credential-providers"],
    queryFn: fetchProviders,
    staleTime: 300_000,
  });

  const providers = providersQuery.data ?? [];

  useEffect(() => {
    const first = providers[0];
    if (first && !selectedProvider) {
      setSelectedProvider(first.id);
    }
  }, [providers, selectedProvider]);

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
  }, [addMutation.isSuccess, addMutation.reset]);

  const providerMeta = providers.find((p) => p.id === selectedProvider);
  const canSubmit = selectedProvider && token.length > 0;
  const isWorking = validateMutation.isPending || addMutation.isPending;

  if (providersQuery.isLoading) {
    return <LoadingState message="Loading providers..." />;
  }

  if (providersQuery.isError) {
    return <ErrorState prefix="Failed to load providers" error={providersQuery.error} />;
  }

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
          <Select
            value={selectedProvider}
            onValueChange={(v) => {
              setSelectedProvider(v);
              setValidateResult(null);
              setValidateError(null);
              addMutation.reset();
            }}
            disabled={isWorking}
          >
            <SelectTrigger
              id="cred-provider-select"
              className="h-9 rounded-md border-input bg-background px-3 text-sm"
              aria-label="Select credential provider"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        <CredentialValidationResult result={validateResult} label="Validate" />
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
            <CredentialValidationResult result={addMutation.data.validate} label="Validate" />
          )}
          {addMutation.data.stored && (
            <div className="text-xs text-muted-foreground px-2">
              Stored at {addMutation.data.stored.configFilePath}
            </div>
          )}
          {addMutation.data.test && (
            <CredentialValidationResult result={addMutation.data.test} label="Smoke test" />
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

      {isManaged(listing) ? (
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
      ) : (
        // Presence-only row (mt#3569): no provider module backs it, so Remove
        // would throw. Reserve the same width so rows stay aligned, and say WHY
        // rather than rendering a mystery gap.
        <span
          className="flex-shrink-0 text-xs h-7 px-2 flex items-center text-muted-foreground"
          title={`Detected from ${listing.configPath}. Managed in your config file, not through this UI.`}
        >
          config-only
        </span>
      )}
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
    return <ErrorState prefix="Failed to load credentials" error={query.error} />;
  }

  if (query.isLoading || !query.data) {
    return <LoadingState message="Loading..." />;
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
// CredentialsSummaryBody — chrome-agnostic body, no Card/CardHeader/CardTitle
// ---------------------------------------------------------------------------

interface CredentialsSummaryBodyProps {
  query: UseQueryResult<CredentialListing[], Error>;
}

function CredentialsSummaryBody({ query }: CredentialsSummaryBodyProps) {
  if (query.isError) {
    return <ErrorState message="Failed to load" />;
  }

  if (query.isLoading || !query.data) {
    return <LoadingState message="Loading..." />;
  }

  const credentials = query.data;
  const configured = credentials.filter((c) => c.configured).length;
  const total = credentials.length;
  const allConfigured = configured === total && total > 0;

  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <span
          className={cn(
            "inline-block h-2.5 w-2.5 rounded-full flex-shrink-0",
            allConfigured ? "bg-primary" : configured > 0 ? "bg-amber-500" : "bg-destructive"
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
    </>
  );
}

// ---------------------------------------------------------------------------
// CredentialsSummary — compact homepage widget (mt#2373)
//
// The whole-card navigation (LinkCard) stays outside WidgetShell; the card
// surface is provided by LinkCard, which is the outer wrapper. WidgetShell
// supplies the title chrome inside the link target.
// ---------------------------------------------------------------------------

interface CredentialsSummaryProps {
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

export function CredentialsSummary({ variant = "card", title = "Credentials" }: CredentialsSummaryProps) {
  const query = useQuery<CredentialListing[], Error>({
    queryKey: ["credentials"],
    queryFn: fetchCredentials,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return (
    <LinkCard to="/settings" aria-label="Manage credentials">
      <WidgetShell variant={variant} title={title}>
        <CredentialsSummaryBody query={query} />
      </WidgetShell>
    </LinkCard>
  );
}