/**
 * Panel for an agent-initiated GitHub App grant request (mt#4693).
 *
 * The second payload kind on the ask render-mode seam, and deliberately NOT
 * shaped like the first. `CredentialRequestForm` is a masked INPUT because a
 * credential's value must reach the config store without touching the
 * transcript. **This request carries no value at all** — expanding an App
 * installation's repository access is something only the operator can do, on
 * github.com, so there is nothing here to type and nothing to submit.
 *
 * What the operator needs instead is: what is being asked, for which repository,
 * why it matters, and a way to get there in one click. So this renders a status
 * card and a link, in place of the ask's option buttons.
 *
 * **Why there is no "done" button.** The request resolves on coverage PRESENCE,
 * observed by a sweep, not on anything clicked here — so an operator who grants
 * access from GitHub directly, or who granted it before the request was filed,
 * closes the same request with no second place to confirm it. Decline is kept,
 * because a refusal must stay distinguishable from an unanswered request.
 *
 * @see packages/shared/src/app-grant-request.ts — the payload this renders
 * @see packages/domain/src/setup/app-grant-request-resolver.ts — what actually closes it
 */
import { Button } from "../components/ui/button";
import { PendingButton } from "../components/PendingButton";

export interface AppGrantRequestPanelProps {
  /** `owner/repo` needing coverage. */
  repo: string;
  /** Display slug of the App, e.g. `minsky-ai`. */
  slug: string;
  /** Deep link to the installation's settings page, when the id is configured. */
  settingsUrl?: string;
  /** True while the decline is in flight. */
  declining: boolean;
  /** True while any resolution on this ask is in flight. */
  blocked: boolean;
  onDecline?: () => void;
}

export function AppGrantRequestPanel({
  repo,
  slug,
  settingsUrl,
  declining,
  blocked,
  onDecline,
}: AppGrantRequestPanelProps) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid="app-grant-request">
      <div className="space-y-1 text-sm">
        <p>
          <span className="font-medium">{slug}</span> does not cover{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{repo}</code>.
        </p>
        <p className="text-muted-foreground">
          Grant it under Repository access, then Save. Minsky notices the grant on its own — there
          is nothing to confirm here afterwards.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        {/* Absent when the installation id is not configured. A wrong URL is
            worse than none, so the panel degrades to the text above rather than
            offering a link built from a guess. */}
        {settingsUrl && (
          <Button size="sm" asChild>
            <a
              href={settingsUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="app-grant-request-link"
            >
              Grant on GitHub
            </a>
          </Button>
        )}
        {onDecline && (
          <PendingButton
            variant="outline"
            size="sm"
            pending={declining}
            disabled={blocked}
            onClick={onDecline}
            data-testid="app-grant-request-decline"
          >
            {declining ? "Declining..." : "Decline"}
          </PendingButton>
        )}
      </div>
    </div>
  );
}
