/**
 * useConversationAddress — resolve a conversation-route id against the actuator
 * registry (mt#3132 Scope item 5, Success Criterion 6, Acceptance Test 5).
 *
 * Reads `GET /api/driven-session`, the registry snapshot that already exists
 * (mt#2750) and already carries both id spaces on every row. No new endpoint,
 * and no change to `driven-session-host.ts` — mt#3132's `### Out of scope` says
 * that plumbing is consumed, not modified. The route is an in-process registry
 * scan over a normally single-digit list with no I/O, and an unauthenticated
 * read-only GET, so it is cheap enough to resolve on every conversation view.
 *
 * ## This hook opens no actuator channel
 *
 * Deliberately, and this is Success Criterion 5's construction rather than a
 * convention: it never touches `useDrivenSession`, whose result object carries
 * `sendText`/`stop`. The unified route reads the registry to learn WHAT an id
 * addresses; it never attaches to the actuator. Mounting the actuator hook here
 * would put a write path in the unified route's component tree — unrendered,
 * but present — and mt#3095's liveness-refusal gate, which is what makes such a
 * path safe, does not exist yet.
 *
 * @see ../lib/conversation-address.ts — the pure resolution this wraps
 */
import { useQuery } from "@tanstack/react-query";
import {
  resolveConversationAddress,
  type ActuatorSummary,
  type ConversationAddress,
} from "../lib/conversation-address";

interface DrivenSessionListPayload {
  sessions: ActuatorSummary[];
}

/**
 * How often to re-read the registry while an actuator is still starting.
 *
 * Polling is scoped to exactly that state. A starting actuator links its
 * conversation on the harness `init` frame, which arrives on its own schedule,
 * so the starting view has to be able to advance with no operator action —
 * but once an id has resolved to a conversation, nothing about the answer can
 * change, and leaving a background poll running on every open conversation tab
 * would be a standing cost paid for a transient case.
 */
const STARTING_REFETCH_MS = 3_000;

export async function fetchActuatorRegistry(): Promise<ActuatorSummary[]> {
  const res = await fetch("/api/driven-session");
  if (!res.ok) throw new Error(`Actuator registry request failed (${res.status}).`);
  const body = (await res.json()) as DrivenSessionListPayload;
  return body.sessions ?? [];
}

/**
 * `resolving` is a distinct state from "resolved to a plain conversation".
 *
 * The caller renders the conversation path in BOTH — blocking on this read
 * would tax every ordinary conversation load — but it must not take a
 * DESTRUCTIVE action (pruning an unresolvable tab) while the answer is still
 * outstanding, because a pre-`init` actuator local id legitimately 404s.
 */
export type ConversationAddressState =
  | { status: "resolving" }
  | { status: "resolved"; address: ConversationAddress };

export function useConversationAddress(id: string | undefined): ConversationAddressState {
  const query = useQuery<ActuatorSummary[], Error>({
    queryKey: ["driven-session", "registry"],
    queryFn: fetchActuatorRegistry,
    enabled: Boolean(id),
    staleTime: 5_000,
    // No retry: this read fails OPEN, so retrying only delays the moment the
    // caller learns it should stop waiting. A retry budget is worth paying when
    // the answer is needed; here the fallback IS the answer for every id that
    // is not an actuator, which is nearly all of them.
    retry: false,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!id || !data) return false;
      return resolveConversationAddress(id, data).kind === "actuator-starting"
        ? STARTING_REFETCH_MS
        : false;
    },
  });

  if (!id) return { status: "resolving" };

  // Fail OPEN on a registry read failure. The actuator registry is an
  // enrichment for one uncommon case; a daemon that cannot answer it must not
  // take the entire conversation surface down with it. Treating the id as a
  // plain conversation is exactly the behavior this route had before mt#3132.
  if (query.isError) {
    return { status: "resolved", address: resolveConversationAddress(id, []) };
  }

  if (query.isPending) return { status: "resolving" };

  return { status: "resolved", address: resolveConversationAddress(id, query.data ?? []) };
}
