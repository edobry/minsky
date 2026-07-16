/**
 * useFocusAttachment — the Agents-view "go to" action for an
 * externally-attached session (mt#2286).
 *
 * Wraps `POST /api/agents/:id/focus` (../../routes/agent-focus.ts) in a
 * TanStack mutation. The server resolves the session's live mt#2284
 * attachment(s) and delegates to the mt#2285 focus-adapter registry
 * in-process (the browser can't raise an OS terminal directly) — this hook
 * just carries the request/response and the outcome shape callers render.
 *
 * Auth: same-origin `fetch` carries the `minsky_cockpit` cookie
 * (../../auth.ts cookie bootstrap), same as every other mutation the SPA
 * makes (e.g. useStartDrivenSession.ts).
 */
import { useMutation } from "@tanstack/react-query";

export interface FocusAttachmentResponse {
  success: boolean;
  outcomeKind: string;
  message: string;
  adapter?: string;
}

function isFocusAttachmentResponse(
  v: Record<string, unknown>
): v is Record<string, unknown> & FocusAttachmentResponse {
  return (
    typeof v["success"] === "boolean" &&
    typeof v["outcomeKind"] === "string" &&
    typeof v["message"] === "string"
  );
}

async function postFocus(sessionId: string): Promise<FocusAttachmentResponse> {
  const res = await fetch(`/api/agents/${encodeURIComponent(sessionId)}/focus`, {
    method: "POST",
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}`;
    throw new Error(message);
  }
  if (!isFocusAttachmentResponse(body)) {
    throw new Error("Unexpected response shape from /api/agents/:id/focus");
  }
  return body;
}

/** `mutate(sessionId)` hits the focus endpoint for that workspace sessionId. */
export function useFocusAttachment() {
  return useMutation<FocusAttachmentResponse, Error, string>({
    mutationFn: postFocus,
  });
}
