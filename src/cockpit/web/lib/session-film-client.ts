/**
 * TanStack Query fetchers for the session-film backend endpoints (mt#3184).
 *
 * Mirrors `conversation-snapshot.ts`'s discipline: parse the `{error:{code,
 * message}}` shape on failure, carry status+code on a typed Error subclass,
 * and export the query keys every consumer must share.
 */
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";

export class SessionFilmError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "SessionFilmError";
  }
}

async function parseErrorResponse(res: Response): Promise<never> {
  const raw = await res.text();
  let code: string | undefined;
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } };
    if (parsed.error && typeof parsed.error === "object") {
      if (typeof parsed.error.code === "string") code = parsed.error.code;
      if (typeof parsed.error.message === "string") detail = parsed.error.message;
    }
  } catch {
    // Non-JSON body — keep the raw text as the detail.
  }
  throw new SessionFilmError(res.status, code, detail);
}

export interface SessionFilmEventsResponse {
  events: SemanticEvent[];
  ingestedAt: string | null;
}

export async function fetchSessionFilmEvents(
  conversationId: string,
  verifiedRescrubbed = false
): Promise<SessionFilmEventsResponse> {
  const params = new URLSearchParams({ conversationId });
  if (verifiedRescrubbed) params.set("verifiedRescrubbed", "true");
  const res = await fetch(`/api/cockpit/session-film/events?${params.toString()}`);
  if (!res.ok) await parseErrorResponse(res);
  return (await res.json()) as SessionFilmEventsResponse;
}

export interface SessionFilmPickerRow {
  agentSessionId: string;
  label: string;
  startedAt: string | null;
  cwd: string | null;
  ingestedAt: string | null;
  scrubGateOk: boolean;
}

export async function fetchSessionFilmSessions(): Promise<SessionFilmPickerRow[]> {
  const res = await fetch("/api/cockpit/session-film/sessions");
  if (!res.ok) await parseErrorResponse(res);
  const body = (await res.json()) as { sessions: SessionFilmPickerRow[] };
  return body.sessions;
}

export function sessionFilmEventsQueryKey(
  conversationId: string,
  verifiedRescrubbed: boolean
): readonly [string, string, string, boolean] {
  return ["session-film", "events", conversationId, verifiedRescrubbed] as const;
}

export function sessionFilmSessionsQueryKey(): readonly [string, string] {
  return ["session-film", "sessions"] as const;
}

/** Do NOT retry a client error (4xx) — mirrors conversation-snapshot.ts's snapshotRetry rationale. */
export function sessionFilmRetry(failureCount: number, error: Error): boolean {
  const status = error instanceof SessionFilmError ? error.status : undefined;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < 3;
}
