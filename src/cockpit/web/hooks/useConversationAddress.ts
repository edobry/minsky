/**
 * useConversationAddress — resolve a conversation-route id against the session driver
 * registry (mt#3132 Scope item 5, Success Criterion 6, Acceptance Test 5).
 *
 * Reads `GET /api/driven-session`, the registry snapshot that already exists
 * (mt#2750) and already carries both id spaces on every row. No new endpoint,
 * and no change to `driven-session-host.ts` — mt#3132's `### Out of scope` says
 * that plumbing is consumed, not modified. The route is an in-process registry
 * scan over a normally single-digit list with no I/O, and an unauthenticated
 * read-only GET, so it is cheap enough to resolve on every conversation view.
 *
 * ## This hook opens no session driver channel
 *
 * Deliberately, and this is Success Criterion 5's construction rather than a
 * convention: it never touches `useDrivenSession`, whose result object carries
 * `sendText`/`stop`. The unified route reads the registry to learn WHAT an id
 * addresses; it never attaches to the session driver. Mounting the session driver hook here
 * would put a write path in the unified route's component tree — unrendered,
 * but present — and mt#3095's liveness-refusal gate, which is what makes such a
 * path safe, does not exist yet.
 *
 * @see ../lib/conversation-address.ts — the pure resolution this wraps
 */
import { useQuery } from "@tanstack/react-query";
import {
  sessionDriverMayStillLink,
  resolveConversationAddress,
  type SessionDriverSummary,
  type ConversationAddress,
} from "../lib/conversation-address";

interface DrivenSessionListPayload {
  sessions: SessionDriverSummary[];
}

/**
 * How often to re-read the registry while a session driver is still starting AND can
 * still link.
 *
 * Polling is scoped to exactly that state, on both halves of the condition:
 *
 *  - Once an id resolves to a conversation, nothing about the answer can
 *    change, so a background poll on every open conversation tab would be a
 *    standing cost paid for a transient case.
 *  - Once the session driver is TERMINAL without ever having linked, it can never
 *    link — polling it is a loop that cannot terminate on its own. This is the
 *    half PR #2502 R1 caught: gating on the `driver-starting` kind alone
 *    polls a dead record forever, because a dead-and-unlinked record stays in
 *    that kind permanently.
 */
const STARTING_REFETCH_MS = 3_000;

export async function fetchSessionDriverRegistry(): Promise<SessionDriverSummary[]> {
  const res = await fetch("/api/driven-session");
  if (!res.ok) throw new Error(`Session driver registry request failed (${res.status}).`);
  const body = (await res.json()) as DrivenSessionListPayload;
  return body.sessions ?? [];
}

/**
 * `resolving` is a distinct state from "resolved to a plain conversation".
 *
 * The caller renders the conversation path in BOTH — blocking on this read
 * would tax every ordinary conversation load — but it must not take a
 * DESTRUCTIVE action (pruning an unresolvable tab) while the answer is still
 * outstanding, because a pre-`init` session driver local id legitimately 404s.
 */
export type ConversationAddressState =
  | { status: "resolving" }
  | { status: "resolved"; address: ConversationAddress };

export function useConversationAddress(id: string | undefined): ConversationAddressState {
  const query = useQuery<SessionDriverSummary[], Error>({
    queryKey: ["driven-session", "registry"],
    queryFn: fetchSessionDriverRegistry,
    enabled: Boolean(id),
    staleTime: 5_000,
    // No retry: this read fails OPEN, so retrying only delays the moment the
    // caller learns it should stop waiting. A retry budget is worth paying when
    // the answer is needed; here the fallback IS the answer for every id that
    // is not a session driver, which is nearly all of them.
    retry: false,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!id || !data) return false;
      const address = resolveConversationAddress(id, data);
      if (address.kind !== "driver-starting") return false;
      // A terminal-but-unlinked session driver never links, so re-reading it can
      // never change the answer.
      return sessionDriverMayStillLink(address.sessionDriver) ? STARTING_REFETCH_MS : false;
    },
  });

  if (!id) return { status: "resolving" };

  // Fail OPEN on a registry read failure. The session driver registry is an
  // enrichment for one uncommon case; a daemon that cannot answer it must not
  // take the entire conversation surface down with it. Treating the id as a
  // plain conversation is exactly the behavior this route had before mt#3132.
  if (query.isError) {
    return { status: "resolved", address: resolveConversationAddress(id, []) };
  }

  if (query.isPending) return { status: "resolving" };

  return { status: "resolved", address: resolveConversationAddress(id, query.data ?? []) };
}
