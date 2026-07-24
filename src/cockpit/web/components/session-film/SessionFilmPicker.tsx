/**
 * SessionFilmPicker — session picker with the scrub gate (mt#3184, spec
 * SC 1 / AT 8).
 *
 * A row whose backing session was ingested before the credential-scrub
 * cutover (`scrubGateOk: false`, computed server-side —
 * `routes/session-film.ts`'s `defaultListSessions`) is DISABLED and shows
 * an explanatory state; clicking it does nothing. This is the picker-level
 * half of the gate — `routes/session-film.ts`'s events endpoint re-checks
 * the same cutoff server-side so a hand-typed `?session=` deep link can't
 * bypass it.
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
            disabled={!s.scrubGateOk}
            onClick={() => {
              if (s.scrubGateOk) onSelect(s.agentSessionId);
            }}
            className={cn(
              "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-secondary",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            )}
          >
            <span className="font-mono">{s.label}</span>
            {!s.scrubGateOk ? (
              <span
                data-testid="session-film-picker-scrub-refusal"
                className="text-xs text-destructive"
              >
                Refused — ingested before the credential-scrub cutover; this session cannot be
                filmed.
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
