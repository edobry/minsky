/**
 * EntityThreadPanel (mt#3365, parent mt#3363) — the discussion thread attached
 * to a Minsky entity's detail page.
 *
 * A LAYOUT-AGNOSTIC body component per the mt#2373 widget contract: it renders
 * a thread plus a composer and does not assume it lives in a tab vs. a panel
 * vs. a page section.
 *
 * ## What it composes (nothing here is a new renderer)
 *
 * - Turns render through `ConversationView`'s exported `snapshot` variant. The
 *   thread's turns arrive from the server already projected to
 *   `SessionContextSnapshotBlock` (mt#3364's `turnToSnapshotBlock`), so this
 *   panel hands over a COMPLETE snapshot rather than appending to one. That is
 *   why it does not use the `extraBlocks` seam: that seam exists to append LIVE
 *   blocks onto a base snapshot the component already fetched — see mt#3365's
 *   `## Planning finding` for the full reasoning.
 * - Input is `DrivenSessionComposer`, with no `onStop` (this thread has no
 *   interrupt channel, and a dead Stop button is worse than none) and its own
 *   accessible label.
 *
 * ## Updates by polling, not push
 *
 * mt#3364 persists the agent's replies but deliberately does not push them, so
 * this panel polls. A WebSocket would mean a second live channel against the
 * same driven session the daemon already owns; not worth it before the
 * surface has proven itself.
 *
 * @see mt#3365 — this component
 * @see src/cockpit/routes/entity-threads.ts — the endpoints it calls
 * @see packages/domain/src/transcripts/entity-thread-store.ts — the projection it renders
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { ConversationView } from "./ConversationView";
import { DrivenSessionComposer } from "../components/DrivenSessionComposer";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";

/** How often to poll for the agent's reply. */
const POLL_INTERVAL_MS = 3_000;

/** Entity kinds the thread endpoints accept today (mt#3366 widens this). */
export type EntityThreadPanelEntityType = "ask";

export interface EntityThreadResponse {
  localId: string;
  entityType: string;
  entityId: string;
  blocks: SessionContextSnapshotBlock[];
}

export interface EntityThreadSendResponse {
  localId: string;
  seeded: boolean;
  delivered: boolean;
}

function threadPath(entityType: string, entityId: string): string {
  return `/api/entity-thread/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`;
}

export async function fetchEntityThread(
  entityType: string,
  entityId: string
): Promise<EntityThreadResponse> {
  const res = await fetch(threadPath(entityType, entityId));
  if (!res.ok) throw new Error(`Failed to load thread (${res.status})`);
  return res.json() as Promise<EntityThreadResponse>;
}

export async function postEntityThreadMessage(
  entityType: string,
  entityId: string,
  text: string
): Promise<EntityThreadSendResponse> {
  const res = await fetch(`${threadPath(entityType, entityId)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to send message (${res.status}): ${body}`);
  }
  return res.json() as Promise<EntityThreadSendResponse>;
}

/**
 * Derive the composer's state from the thread's own contents.
 *
 * The rule: the composer is closed while a reply is outstanding. A thread whose
 * LAST block is an operator turn has an answer in flight — the agent has the
 * turn, so letting the operator queue a second question would interleave two
 * conversations. Exported for direct testing; the ordering it depends on is
 * guaranteed server-side by the store's `ORDER BY seq`.
 */
export function deriveComposerState(
  blocks: SessionContextSnapshotBlock[],
  sendPending: boolean
): "awaiting-input" | "streaming" {
  if (sendPending) return "streaming";
  const last = blocks[blocks.length - 1];
  return last?.type === "user-prompt" ? "streaming" : "awaiting-input";
}

export interface EntityThreadPanelProps {
  entityType: EntityThreadPanelEntityType;
  entityId: string;
  className?: string;
}

export function EntityThreadPanel({ entityType, entityId, className }: EntityThreadPanelProps) {
  const queryClient = useQueryClient();
  const queryKey = ["entity-thread", entityType, entityId];

  const query = useQuery({
    queryKey,
    queryFn: () => fetchEntityThread(entityType, entityId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const sendMutation = useMutation({
    mutationFn: (text: string) => postEntityThreadMessage(entityType, entityId, text),
    // Invalidate rather than write the returned turn into the cache by hand:
    // the server assigns `seq` and the agent's reply lands asynchronously, so
    // a refetch is the only view that reflects both.
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const blocks = query.data?.blocks;
  const localId = query.data?.localId;

  const snapshot = useMemo(
    () =>
      localId
        ? {
            agentSessionId: localId,
            // Correct-by-construction, not a placeholder: an entity thread's
            // agent is a genuine `claude` child (mt#2750's invariant), so the
            // thread IS a Claude Code harness conversation. Mirrors the same
            // reasoning recorded in `DrivenSessionThread`.
            harness: "claude_code",
            blocks: blocks ?? [],
            // Every block carries its own timestamp from the store; this
            // snapshot-level field is required by the type and not read by any
            // renderer on this path.
            assembledAt: new Date(0).toISOString(),
          }
        : null,
    [localId, blocks]
  );

  if (query.isPending) return <LoadingState message="Loading discussion…" className={className} />;
  if (query.isError) {
    return <ErrorState prefix="Failed to load discussion" error={query.error} className={className} />;
  }

  const hasTurns = (blocks?.length ?? 0) > 0;
  const composerState = deriveComposerState(blocks ?? [], sendMutation.isPending);

  return (
    <section className={className} aria-label="Discussion">
      <h2 className="text-sm font-medium text-foreground mb-2">Discussion</h2>

      {hasTurns && snapshot ? (
        <ConversationView snapshot={snapshot} />
      ) : (
        <p className="text-sm text-muted-foreground py-3">
          No discussion yet. Ask a question about this {entityType} and an agent will look into it.
        </p>
      )}

      {sendMutation.isError ? (
        <ErrorState
          prefix="Failed to send"
          error={sendMutation.error}
          className="mt-2"
        />
      ) : null}

      <DrivenSessionComposer
        interactionState={composerState}
        onSend={(text) => sendMutation.mutate(text)}
        ariaLabel={`Ask a question about this ${entityType}`}
        idlePlaceholder="Ask a question about this…"
        className="mt-3"
      />
    </section>
  );
}
