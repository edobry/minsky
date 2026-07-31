/**
 * useConversationPresence — the cockpit's read consumer for the run-state
 * channel (mt#3261, mt#3130 Phase 3 UI-only class).
 *
 * Source: `GET /api/conversation/:id/presence` (`src/cockpit/routes/conversation-presence.ts`),
 * which derives presence at read time from `conversation_run_state` plus `now`.
 *
 * ## Why four outcomes, not one nullable payload
 *
 * The route deliberately distinguishes states that all "look like nothing" from
 * the outside, and collapsing them here would throw away exactly the
 * information it was written to preserve:
 *
 *  - **200 with `presence: "UNKNOWN"`** — the store was reached and has no row.
 *    "No telemetry for this conversation" is a real, honest answer.
 *  - **503 `store_unavailable`** — the store could NOT be reached. This is NOT
 *    `UNKNOWN`; rendering it as `UNKNOWN` would assert "we know there is no
 *    telemetry" when the truth is "we could not look."
 *  - **422 `wrong_id_space`** — a WORKSPACE session id was passed where a
 *    conversation id belongs. Rendering this as "no telemetry" hides a caller
 *    bug behind an honest-looking empty state.
 *  - **404 `invalid_id`** — syntactically impossible id, rejected with zero I/O.
 *
 * @see packages/domain/src/conversation-run-state/presence.ts — the derivation
 * @see src/cockpit/routes/conversation-presence.ts — the route contract
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

/**
 * Mirrors `ConversationPresence` in
 * `packages/domain/src/conversation-run-state/presence.ts`.
 *
 * Declared here rather than imported because what this hook consumes is the
 * JSON **wire shape** of `GET /api/conversation/:id/presence`, not the server's
 * in-process type. They coincide today; the client's contract is with the
 * endpoint's response body, and stating it locally keeps that contract explicit
 * at the boundary that actually parses it. (The cockpit bundle does import
 * browser-safe domain modules elsewhere — e.g. `conversation-elements` in
 * `ConversationView.tsx` — so this is a boundary choice, not a bundling one.)
 */
export type ConversationPresence =
  | "LIVE"
  | "NEEDS_INPUT"
  | "IDLE"
  | "STALLED"
  | "ENDED"
  | "UNKNOWN";

/** Mirrors `NeedsInputReason` in the domain module above. */
export type NeedsInputReason =
  | "permission"
  | "idle-prompt"
  | "agent-needs-input"
  | "ask"
  | "unknown";

/** Mirrors `LinkedOpenAsk` in `packages/domain/src/conversation-run-state/read.ts`. */
export interface LinkedOpenAsk {
  id: string;
  shortId: string | null;
  title: string;
  minskySessionId: string;
}

/** The 200 body: `ConversationPresenceResponse` on the route side. */
export interface ConversationPresencePayload {
  presence: ConversationPresence;
  needsInputReason: NeedsInputReason | null;
  needsInputTool: string | null;
  toolName: string | null;
  toolElapsedMs: number | null;
  quietForMs: number | null;
  isQuiet: boolean;
  basis: string;
  conversationId: string;
  /**
   * The open Ask, when one is resolvable. `null` means "not resolvable" — NOT
   * "no ask exists": the join needs a `minsky_session_links` row, and only ~27%
   * of tracked conversations had one when measured (2026-07-24). Callers must
   * not render a null here as an assertion that the conversation has no ask.
   */
  ask: LinkedOpenAsk | null;
}

/**
 * The presence read's outcome. Every non-200 documented by the route gets its
 * own variant so the render can stay honest about which question it is
 * answering.
 */
export type ConversationPresenceState =
  | { kind: "presence"; payload: ConversationPresencePayload; fetchedAtMs: number }
  | { kind: "store-unavailable" }
  | { kind: "wrong-id-space"; message: string }
  | { kind: "invalid-id"; message: string };

/**
 * Poll faster while the conversation is mid-work: `toolName`/`toolElapsedMs`
 * change within a turn, and a `LIVE` row is the one whose value can go stale in
 * a way that matters. Anything else moves on human timescales.
 */
const LIVE_REFETCH_MS = 5_000;
const RESTING_REFETCH_MS = 20_000;

interface PresenceErrorBody {
  error?: { code?: string; message?: string };
}

async function readErrorBody(res: Response): Promise<PresenceErrorBody> {
  try {
    return (await res.json()) as PresenceErrorBody;
  } catch {
    return {};
  }
}

export async function fetchConversationPresence(
  conversationId: string
): Promise<ConversationPresenceState> {
  const res = await fetch(`/api/conversation/${encodeURIComponent(conversationId)}/presence`);

  if (res.ok) {
    const payload = (await res.json()) as ConversationPresencePayload;
    return { kind: "presence", payload, fetchedAtMs: Date.now() };
  }

  const body = await readErrorBody(res);
  const code = body.error?.code;
  const message = body.error?.message ?? `Presence request failed (${res.status}).`;

  if (res.status === 503 || code === "store_unavailable") return { kind: "store-unavailable" };
  if (res.status === 422 || code === "wrong_id_space") return { kind: "wrong-id-space", message };
  if (res.status === 404 || code === "invalid_id") return { kind: "invalid-id", message };

  // Anything undocumented is a genuine failure — surface it through the query's
  // error channel rather than inventing a fifth honest-looking state.
  throw new Error(message);
}

export function useConversationPresence(
  conversationId: string | undefined
): UseQueryResult<ConversationPresenceState, Error> {
  return useQuery<ConversationPresenceState, Error>({
    queryKey: ["conversation", conversationId, "presence"],
    queryFn: () => fetchConversationPresence(conversationId as string),
    enabled: Boolean(conversationId),
    staleTime: 2_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.kind !== "presence") return RESTING_REFETCH_MS;
      return data.payload.presence === "LIVE" ? LIVE_REFETCH_MS : RESTING_REFETCH_MS;
    },
  });
}
