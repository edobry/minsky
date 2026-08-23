/**
 * Masked entry form for an agent-initiated credential request (mt#4030).
 *
 * The surface half of the request primitive: an agent files an ask naming a
 * provider and a reason, and this renders in place of that ask's option buttons
 * so the principal can satisfy it where they read it.
 *
 * **Why it posts to the existing route rather than owning storage.** The value
 * travels browser → cockpit server → `~/.config/minsky/config.yaml` and must
 * touch nothing else — not the ask API, not the MCP server, not an agent's
 * context. Reusing `POST /api/credentials/add` through the shared client
 * (`../lib/credentials-api`) is what makes that structural rather than a
 * convention this component could drift from.
 *
 * **Why there is no "done" button.** The request resolves on credential
 * PRESENCE, observed by a sweep, not on anything the principal clicks here. So
 * an operator who instead runs `config credentials add` in a terminal, or who
 * had the credential set already, closes the same request with no second place
 * to confirm it. This form is a convenience, never the only path.
 *
 * @see packages/domain/src/credentials/request.ts — the request/resolve core
 * @see packages/domain/src/credentials/request-resolver.ts — what actually closes it
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { CredentialValidationResult } from "../components/CredentialValidationResult";
import {
  type CredentialCheckResult,
  type AddCredentialResult,
  type ProviderMeta,
  CredentialApiError,
  fetchProviders,
  addCredential,
} from "../lib/credentials-api";

export interface CredentialRequestFormProps {
  /** Registry id of the provider this request names. */
  providerId: string;
  /** Rendered beside Save — the ask's own decline affordance, wired by the caller. */
  onDecline?: () => void;
  /** True while the caller's decline mutation is in flight. */
  declining?: boolean;
}

/**
 * Render the masked entry form for one provider.
 *
 * Fails visibly rather than silently when the provider is not registered: an
 * unresolvable id means the request should never have been filed (the request
 * tool refuses at call time for exactly this reason), and rendering a dead input
 * would leave the principal typing into nothing.
 */
export function CredentialRequestForm({
  providerId,
  onDecline,
  declining = false,
}: CredentialRequestFormProps) {
  const [token, setToken] = useState("");
  const [validateResult, setValidateResult] = useState<CredentialCheckResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const providersQuery = useQuery<ProviderMeta[], Error>({
    queryKey: ["credential-providers"],
    queryFn: fetchProviders,
    staleTime: 300_000,
  });

  const addMutation = useMutation<AddCredentialResult, Error, { provider: string; token: string }>({
    mutationFn: ({ provider, token: t }) => addCredential(provider, t),
    onSuccess: () => {
      // Clear the value from component state the moment it is stored — it has
      // no further use here and every extra frame it lives in memory is one
      // more place it can be read from.
      setToken("");
      setValidateResult(null);
      setSubmitError(null);
      // The request closes when the resolver observes presence; refreshing the
      // listing is what makes the Settings page agree in the meantime.
      void queryClient.invalidateQueries({ queryKey: ["credentials"] });
    },
    onError: (err) => {
      // A rejected credential is not an error state — it is a retry, in place,
      // with the provider's own reason shown. Only a non-validation failure
      // becomes an error message.
      if (err instanceof CredentialApiError && err.code === "validation_failed" && err.validate) {
        setValidateResult(err.validate);
        setSubmitError(null);
      } else {
        setValidateResult(null);
        setSubmitError(err.message);
      }
    },
  });

  // Drop the stored-token banner after a few seconds so a satisfied request does
  // not look permanently mid-action while the sweep closes it.
  useEffect(() => {
    if (!addMutation.isSuccess) return;
    const timer = setTimeout(() => addMutation.reset(), 5000);
    return () => clearTimeout(timer);
  }, [addMutation.isSuccess, addMutation.reset]);

  if (providersQuery.isLoading) {
    return <LoadingState message="Loading provider..." />;
  }
  if (providersQuery.isError) {
    return <ErrorState prefix="Failed to load credential providers" error={providersQuery.error} />;
  }

  const provider = (providersQuery.data ?? []).find((p) => p.id === providerId);
  if (!provider) {
    return (
      <div
        className="rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        role="status"
        data-testid="credential-request-unknown-provider"
      >
        No credential provider is registered for <span className="font-mono">{providerId}</span>, so
        there is nowhere for this value to land. This request should not have been filed — decline
        it, and register the provider in{" "}
        <span className="font-mono">packages/domain/src/credentials/providers/index.ts</span>.
      </div>
    );
  }

  const canSubmit = token.length > 0 && !addMutation.isPending && !declining;
  const inputId = `credential-request-token-${provider.id}`;

  function handleSave() {
    if (!canSubmit) return;
    setValidateResult(null);
    setSubmitError(null);
    addMutation.mutate({ provider: providerId, token });
  }

  return (
    <div className="space-y-2" data-testid="credential-request-form">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          {provider.displayName} credential
        </label>
        {/* Styling is deliberately identical to `AddCredentialForm`'s token input
            in `Credentials.tsx` — same control, same affordances, two places. The
            focus-visible ring and the disabled treatment are load-bearing rather
            than cosmetic: this is a keyboard-entry field, and it must not stay
            editable while a save is in flight. */}
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-testid="credential-request-token-input"
          className={[
            "h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm",
            "ring-offset-background focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-ring focus-visible:ring-offset-2",
            "disabled:pointer-events-none disabled:opacity-50",
            "placeholder:text-muted-foreground",
          ].join(" ")}
          placeholder="Paste the value here..."
          aria-label={`Paste the ${provider.displayName} credential`}
          disabled={addMutation.isPending || declining}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setValidateResult(null);
            setSubmitError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
          }}
        />
        <p className="text-xs text-muted-foreground">
          Goes straight to the credential store — never through the conversation.{" "}
          <a
            href={provider.acquireUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            Get it here
          </a>
          .
        </p>
      </div>

      {provider.scopeGuidance && (
        <p className="text-xs text-muted-foreground">{provider.scopeGuidance}</p>
      )}

      {validateResult && <CredentialValidationResult result={validateResult} label="Rejected" />}

      {submitError && (
        <div className="rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive" role="status">
          {submitError}
        </div>
      )}

      {addMutation.isSuccess && (
        <div
          className="rounded bg-accent/20 px-2 py-1.5 text-xs text-foreground"
          role="status"
          data-testid="credential-request-stored"
        >
          Stored. This request closes on its own once the credential is seen — nothing else to do.
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" disabled={!canSubmit} onClick={handleSave}>
          {addMutation.isPending ? "Saving..." : "Save credential"}
        </Button>
        {onDecline && (
          <Button
            variant="outline"
            size="sm"
            disabled={addMutation.isPending || declining}
            onClick={onDecline}
            data-testid="credential-request-decline"
          >
            Decline
          </Button>
        )}
      </div>
    </div>
  );
}
