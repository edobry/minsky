/**
 * SessionFilmPicker — session picker (mt#3184).
 *
 * Every ingested conversation is selectable. Until mt#3268 a row whose
 * backing session predated the credential-scrub cutover was DISABLED and
 * showed a refusal — while the conversation view rendered that same
 * transcript in full, one route over. ADR-040 settled that asymmetry: the
 * scrub gate binds where transcript bytes cross the operator's trust
 * boundary (a file export, an anonymous share link), not on the operator's
 * own authenticated read, so the refusal is gone along with the
 * `scrubGateOk` field that drove it.
 *
 * @see docs/architecture/adr-040-transcript-scrub-gate-binds-at-trust-boundary-crossings.md
 */
import { cn } from "../../lib/utils";
import { LoadingState } from "../LoadingState";
import type { SessionFilmPickerRow } from "../../lib/session-film-client";

export interface SessionFilmPickerProps {
  sessions: readonly SessionFilmPickerRow[];
  isLoading: boolean;
  onSelect: (conversationId: string) => void;
}

export function SessionFilmPicker({ sessions, isLoading, onSelect }: SessionFilmPickerProps) {
  if (isLoading) return <LoadingState message="Loading sessions…" />;
  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No ingested sessions found.</p>;
  }

  return (
    <ul
      role="list"
      aria-label="Filmable sessions"
      className="divide-y divide-border rounded border border-border"
    >
      {sessions.map((s) => (
        <li key={s.agentSessionId}>
          <button
            type="button"
            data-testid={`session-film-picker-row-${s.agentSessionId}`}
            onClick={() => onSelect(s.agentSessionId)}
            className={cn(
              "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-secondary"
            )}
          >
            <span className="font-mono">{s.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
