/**
 * Inline rendering of a credential provider's own validation verdict.
 *
 * Extracted from `widgets/Credentials.tsx` (mt#4030) so the Settings form and the
 * masked entry form on a credential-request ask render a rejection identically —
 * the retry-in-place behaviour depends on the principal seeing the provider's
 * actual reason ("401 — that's the anon key; you want service_role") rather than
 * a generic failure.
 *
 * `detail` is a status line produced by the provider's probe. It never contains
 * the credential.
 */
import { cn } from "../lib/utils";
import type { CredentialCheckResult } from "../lib/credentials-api";

export function CredentialValidationResult({
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
        result.ok ? "bg-accent/20 text-foreground" : "bg-destructive/10 text-destructive"
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
