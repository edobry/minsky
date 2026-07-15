/**
 * useStartDrivenSession — launch a driven session and land in its live view
 * (mt#2752, Rung 2C).
 *
 * Wraps `POST /api/driven-session` (routes/driven-sessions.ts) in a TanStack
 * mutation. Two launch shapes:
 *   - `{ taskId }` — task-bound: the daemon binds-or-creates the task's
 *     workspace and spawns against it.
 *   - `{}` — untasked scratch session (daemon-cwd default).
 *
 * On success the operator is navigated straight to `/driven/:id` (spec SC1:
 * "one action … lands the operator in the live view"), and the agents query
 * is invalidated so the new session appears in the unified run list without
 * waiting for the next poll.
 *
 * Auth: same-origin `fetch` carries the `minsky_cockpit` cookie
 * (../../auth.ts cookie bootstrap), exactly like every other mutation the
 * SPA makes (e.g. widgets/Credentials.tsx).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

export interface StartDrivenSessionInput {
  /** Task-bound launch — mutually exclusive with cwd (server-enforced). */
  taskId?: string;
  /** Explicit-directory launch. Omit BOTH fields for a scratch session. */
  cwd?: string;
}

export interface StartDrivenSessionResponse {
  sessionId: string;
  harnessSessionId: string | null;
  cwd: string;
  taskId: string | null;
  minskySessionId: string | null;
  permissionMode: string;
  status: string;
}

function isStartDrivenSessionResponse(
  v: Record<string, unknown>
): v is Record<string, unknown> & StartDrivenSessionResponse {
  return typeof v["sessionId"] === "string" && typeof v["cwd"] === "string";
}

async function postDrivenSession(
  input: StartDrivenSessionInput
): Promise<StartDrivenSessionResponse> {
  const res = await fetch("/api/driven-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}`;
    throw new Error(message);
  }
  if (!isStartDrivenSessionResponse(body)) {
    throw new Error("Unexpected response shape from /api/driven-session");
  }
  return body;
}

export function useStartDrivenSession() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation<StartDrivenSessionResponse, Error, StartDrivenSessionInput>({
    mutationFn: postDrivenSession,
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigate(`/driven/${encodeURIComponent(session.sessionId)}`);
    },
  });
}
