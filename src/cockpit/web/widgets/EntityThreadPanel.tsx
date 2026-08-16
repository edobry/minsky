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
import { useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { findLatestResolveProposal, type ResolveProposal } from "../lib/resolve-proposal";
import type { EntityThreadSupportedType } from "@minsky/shared/entity-thread-types";
import { ConversationView } from "./ConversationView";
import { DrivenSessionComposer } from "../components/DrivenSessionComposer";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";

/** How often to poll for the agent's reply. */
const POLL_INTERVAL_MS = 3_000;

/**
 * Entity kinds the thread endpoints accept.
 *
 * DERIVED from the single shared declaration, never hand-written here
 * (PR #2467 R1 BLOCKING). A hand-written union meant widening the supported set
 * required editing this panel — which broke mt#3366's own criterion that adding
 * an entity kind needs no panel change — and let the panel's idea of the set
 * drift from the server's.
 */
export type EntityThreadPanelEntityType = EntityThreadSupportedType;

export interface EntityThreadResponse {
  localId: string;
  /** Narrowed to the kinds this panel mounts for — the server rejects any
   * other value with a 400, so a wider type here would only be honest about
   * the wire format at the cost of every consumer re-narrowing it (PR #2437
   * R1 non-blocking). */
  entityType: EntityThreadPanelEntityType;
  entityId: string;
  blocks: SessionContextSnapshotBlock[];
  /**
   * Whether an agent is actually able to answer right now (mt#3402).
   *
   * Optional, and `undefined` means UNKNOWN — not `false`. A daemon predating
   * this field simply doesn't report liveness, and collapsing that into "dead"
   * would assert the very thing this task exists to stop asserting without
   * evidence, just in the other direction: the panel would announce "the agent
   * stopped before answering" about an agent that is mid-turn, and reopen the
   * composer so a second question interleaves into a live child. Consumers
   * must branch on `live === false`, never on falsiness (PR #2460 R1 BLOCKING).
   */
  live?: boolean;
  /**
   * Whether the agent can reach the conversation that originally filed this
   * entity (mt#3367). Optional, and `undefined` means UNKNOWN — same discipline
   * as `live`: a daemon that does not report it must not be read as "not seeded".
   */
  originSeeded?: boolean;
  /**
   * Replies the agent produced that the daemon could not write (mt#4036).
   *
   * Optional and OMITTED when there is nothing to report — same discipline as
   * `live` and `originSeeded`. Present means the daemon positively knows about
   * unpersisted replies; absent means it has nothing to say, which for a daemon
   * predating this field is the honest answer rather than a reassuring zero.
   */
  pendingReplies?: PendingRepliesInfo;
  /**
   * Why the agent is not running, when the daemon can tell (mt#4037).
   *
   * Optional and UNKNOWN when absent — same discipline as `live`. Only a
   * definite answer produces a line; the panel falls back to the weaker
   * stranded notice rather than guessing at a cause.
   */
  agentStopReason?: AgentStopReason;
  /**
   * A conversation this thread's agent was replaced with a fresh one (mt#4093).
   *
   * Optional and OMITTED when nothing was replaced — same discipline as the two
   * fields above. Present means the daemon has a RECORDED swap, not an inferred
   * one; absent means it has nothing to report, which for a daemon predating
   * this field is the honest answer.
   */
  conversationSwap?: ConversationSwapInfo;

  /**
   * Replies restored from the harness transcript after the in-memory buffer
   * died with a daemon restart (mt#4073). Absent when nothing was recovered.
   */
  recoveredReplies?: RecoveredRepliesInfo;
}

/** The recovery behind {@link EntityThreadResponse.recoveredReplies} (mt#4073). */
export interface RecoveredRepliesInfo {
  count: number;
  /** ISO instant the oldest recovered reply was originally sent. */
  oldestOriginallySentAt?: string;
}

/** The recorded swap behind {@link EntityThreadResponse.conversationSwap}. */
export interface ConversationSwapInfo {
  /** The conversation the current agent replaced. */
  replacedConversationId: string;
  /** ISO instant of the swap, when recorded. */
  replacedAt?: string;
}

/**
 * `cockpit-restart` — the daemon went down while this actuator was live, so the
 * agent was killed by the cockpit rather than stopping on its own. Resumable.
 * `unrecoverable` — there is no transcript to resume, or its workspace is gone.
 */
export type AgentStopReason = "cockpit-restart" | "unrecoverable";

/**
 * The daemon's account of replies that did not reach the store (mt#4036).
 *
 * `pending` and `lost` are separate because they are different statements to
 * the operator: one says wait, the other says this is not coming back.
 */
export interface PendingRepliesInfo {
  pending: number;
  lost: number;
  oldestFailedAt: string | null;
}

export interface EntityThreadSendResponse {
  localId: string;
  seeded: boolean;
  delivered: boolean;
}

function threadPath(entityType: string, entityId: string): string {
  return `/api/entity-thread/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`;
}

/**
 * Thrown when the daemon cannot reach its database (HTTP 503, mt#3398).
 *
 * A distinct class rather than a status check at each callsite: this condition
 * is TRANSIENT and says nothing about the thread, so the panel must render it
 * differently and — critically — keep polling through it. During the 2026-07-30
 * incident the panel showed "Failed to load discussion", which read as "your
 * thread is broken" while the turns were intact and the agent was still running.
 */
export class ThreadStoreUnavailableError extends Error {
  constructor() {
    super("The cockpit can't reach its database right now. Retrying…");
    this.name = "ThreadStoreUnavailableError";
  }
}

export async function fetchEntityThread(
  entityType: string,
  entityId: string
): Promise<EntityThreadResponse> {
  const res = await fetch(threadPath(entityType, entityId));
  // 503 is the daemon saying "my database is unreachable", not "this thread
  // failed" — distinguished before the generic error so the two cannot be
  // conflated in the UI.
  //
  // 503 ONLY, deliberately (PR #2514 R1 non-blocking asked about 502/504). Those
  // come from a proxy in front of the daemon, not from the daemon, so rendering
  // "the cockpit can't reach its database" for one would assert a cause we have
  // no evidence for — the precise habit this whole task exists to remove. 503 is
  // our own contract with our own route; the rest stay a generic error.
  if (res.status === 503) throw new ThreadStoreUnavailableError();
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
  // mt#3398: same distinction on the send path. The composer's error copy
  // already tells the operator their message is preserved and to press Send
  // again; pairing that with "the database is unreachable" is actionable,
  // whereas a raw 503 body is not.
  if (res.status === 503) throw new ThreadStoreUnavailableError();
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
  sendPending: boolean,
  agentLive: boolean | undefined
): "awaiting-input" | "streaming" {
  if (sendPending) return "streaming";
  // `agentLive` is what distinguishes "the agent has the turn" from "the agent
  // is gone" (mt#3402). Both look identical in the block list — an operator
  // turn with nothing after it — so deriving from blocks ALONE told the
  // operator a reply was coming from a process that had exited. The composer's
  // streaming placeholder also promises "your message will queue" (mt#3375),
  // which is only true when there is a live child to queue against.
  //
  // Only a DEFINITE `false` reopens the composer. `undefined` means the daemon
  // never reported liveness, which is not evidence of death — falling back to
  // the block-derived reading keeps the pre-mt#3402 behavior rather than
  // inventing a verdict from a signal that never arrived.
  if (agentLive === false) return "awaiting-input";
  const last = blocks[blocks.length - 1];
  return last?.type === "user-prompt" ? "streaming" : "awaiting-input";
}

/**
 * Has this thread stranded — an operator turn left unanswered by an agent that
 * is no longer running? (mt#3402)
 *
 * Distinct from "not live": a thread whose last turn is the AGENT's is simply
 * idle between questions, which is the normal resting state and needs no
 * notice. Only an unanswered operator turn represents a reply that will never
 * arrive unless the operator re-sends.
 *
 * Requires a DEFINITE `agentLive === false`. An unknown liveness (`undefined`,
 * from a daemon that doesn't report the field) is not grounds to tell the
 * operator their agent died.
 */
export function isThreadStranded(
  blocks: SessionContextSnapshotBlock[],
  sendPending: boolean,
  agentLive: boolean | undefined
): boolean {
  if (sendPending || agentLive !== false) return false;
  return blocks[blocks.length - 1]?.type === "user-prompt";
}

/**
 * The poll cadence, or `false` to stop polling.
 *
 * Polling PAUSES while a send is in flight (PR #2437 R1 BLOCKING): a poll
 * started before the send can resolve AFTER it and overwrite the
 * freshly-invalidated list with a pre-send snapshot, making the operator's own
 * message flicker out. Exported so the decision is directly testable rather
 * than buried in a query option.
 */
export function derivePollInterval(sendPending: boolean): number | false {
  return sendPending ? false : POLL_INTERVAL_MS;
}

/**
 * What to tell the principal about the agent's grounding (mt#3367), or `null`
 * to say nothing.
 *
 * Three states, not two. `undefined` is UNKNOWN — a daemon predating the field
 * — and says nothing rather than claiming the origin is missing, the same
 * discipline `live` follows. Only a definite answer produces a line.
 *
 * Worth surfacing at all because reachability is only ~46%: a principal reading
 * "why was this filed?" deserves to know whether the answer came from the
 * originating conversation or from the entity text alone.
 */
/**
 * What to tell the operator about replies that never reached the store
 * (mt#4036), or `null` to say nothing.
 *
 * This is the whole point of the task. On 2026-08-11 an agent produced four
 * replies during a database outage, every one was dropped, and the panel
 * rendered exactly what it renders for an agent that never answered: nothing.
 * The operator asked "Well?" into that silence and the reply to THAT was
 * dropped too. A dropped write must never be indistinguishable from an absent
 * reply, and this line is what distinguishes them.
 *
 * `lost` leads when present: an operator who cannot get a reply back needs to
 * know that before they are told to keep waiting for one.
 */
export function derivePendingRepliesNotice(info: PendingRepliesInfo | undefined): string | null {
  if (!info) return null;
  const { pending, lost } = info;
  if (lost > 0 && pending > 0) {
    return `${lost} ${replyWord(lost)} could not be saved and ${lost === 1 ? "is" : "are"} lost; ${pending} more ${pending === 1 ? "is" : "are"} still being retried. Ask again to get the answer back.`;
  }
  if (lost > 0) {
    return `The agent answered, but ${lost} ${replyWord(lost)} could not be saved and ${lost === 1 ? "is" : "are"} lost. Ask again to get the answer back.`;
  }
  if (pending > 0) {
    return `The agent answered, but ${pending} ${replyWord(pending)} could not be saved yet — the cockpit is retrying.`;
  }
  return null;
}

function replyWord(n: number): string {
  return n === 1 ? "reply" : "replies";
}

/**
 * What to tell the operator about a stopped agent (mt#4037), or `null` to fall
 * back to the weaker stranded notice.
 *
 * The stranded notice — "The agent stopped before answering" — is the only
 * thing the panel could say before this, and on 2026-08-11 it was false: a
 * cockpit restart killed the agent mid-task at 23:38 local, and the operator
 * read a line blaming the agent, with no hint that sending anything would bring
 * it back. They waited 12h34m.
 *
 * So the restart line has to do two things the stranded line does not: name the
 * COCKPIT as what stopped it, and say that re-sending resumes. `null` when the
 * daemon reports nothing — an unsupported cause is worse than a vague true
 * statement.
 */
export function deriveAgentStoppedNotice(reason: AgentStopReason | undefined): string | null {
  if (reason === "cockpit-restart") {
    return "The cockpit restarted and stopped this agent mid-task — send anything to pick it back up.";
  }
  if (reason === "unrecoverable") {
    return "This agent can't be resumed — its conversation is gone. Send a message to start a fresh one.";
  }
  return null;
}

/**
 * What to tell the operator when a fresh agent replaced the conversation the
 * blocks above belong to (mt#4093), or `null` when none did.
 *
 * The line has one job: break the continuity the rendered history otherwise
 * asserts. On 2026-08-12 a thread swapped agents silently and the operator
 * nudged it; the incoming agent answered "Nothing was in flight" — true of the
 * conversation IT could see, false of the thread on screen, and nothing
 * anywhere said the two were different. So this names the state ("has not seen
 * the messages above") rather than the mechanism, which is what the operator
 * needs in order to re-ask rather than wait.
 *
 * The replaced conversation id is deliberately NOT rendered. It addresses an
 * on-disk transcript the panel cannot open, so showing it would offer a handle
 * that leads nowhere; it is carried in the response for the daemon logs and for
 * whatever recovery surface eventually wants it.
 */
export function deriveConversationSwapNotice(swap: ConversationSwapInfo | undefined): string | null {
  if (!swap?.replacedConversationId) return null;
  return "The earlier conversation couldn't be resumed, so a fresh agent took over — it has not seen the messages above.";
}

/**
 * What to say about replies restored from the transcript (mt#4073).
 *
 * The notice exists because of WHERE a recovered reply lands, not merely that
 * one did. `seq` is allocated `MAX(seq)+1` inside the insert, so a recovered
 * reply appends at the TAIL while carrying its ORIGINAL timestamp — an answer
 * from an hour ago sitting below messages that came after it. Unexplained, that
 * reads as the agent repeating itself out of nowhere.
 *
 * Says "below" rather than naming a position: the thread renders in `seq` order
 * and the recovered turns are always at the end, so that is the direction the
 * operator has to look.
 */
export function deriveRecoveredRepliesNotice(
  info: RecoveredRepliesInfo | undefined
): string | null {
  if (!info || info.count < 1) return null;
  return info.count === 1
    ? "A reply that failed to save was recovered from the agent's transcript — it's at the end of the thread, with the time it was originally sent."
    : `${info.count} replies that failed to save were recovered from the agent's transcript — they're at the end of the thread, with the times they were originally sent.`;
}

export function deriveOriginNotice(originSeeded: boolean | undefined): string | null {
  if (originSeeded === true) return "Grounded in the conversation that filed this.";
  if (originSeeded === false) return "The originating conversation isn't reachable for this one.";
  return null;
}

export interface EntityThreadPanelProps {
  entityType: EntityThreadPanelEntityType;
  entityId: string;
  className?: string;
  /**
   * Render the agent's most recent resolve proposal, when it made one (mt#3368).
   *
   * A render-prop rather than built-in resolve handling: this panel is generic
   * over entity kinds (mt#3366 widens the mount to tasks, changesets, and
   * memories), and what a "proposal" commits to is entirely entity-specific.
   * The panel's job is to FIND the proposal in its own blocks; deciding what it
   * means and whether the entity can currently accept it belongs to the page
   * that owns the entity. Omitted → proposals render as ordinary prose.
   */
  proposalSlot?: (proposal: ResolveProposal) => ReactNode;
}

export function EntityThreadPanel({
  entityType,
  entityId,
  className,
  proposalSlot,
}: EntityThreadPanelProps) {
  const queryClient = useQueryClient();
  const queryKey = ["entity-thread", entityType, entityId];

  // Declared before the query below, which reads `isPending` to pause polling.
  const sendMutation = useMutation({
    mutationFn: (text: string) => postEntityThreadMessage(entityType, entityId, text),
    // Invalidate rather than write the returned turn into the cache by hand:
    // the server assigns `seq` and the agent's reply lands asynchronously, so
    // a refetch is the only view that reflects both.
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const query = useQuery({
    queryKey,
    queryFn: () => fetchEntityThread(entityType, entityId),
    // See `derivePollInterval` for why this pauses mid-send.
    refetchInterval: derivePollInterval(sendMutation.isPending),
    // mt#3398: self-healing comes from `refetchInterval`, which keeps polling
    // while the query sits in an ERROR state — so when the wedged daemon DB
    // (mt#3092) recovers, the thread reappears with no manual reload. That was
    // the operator's complaint during the 2026-07-30 incident.
    //
    // Deliberately NO `retry`. An earlier draft retried the unavailable case
    // three times; that only DELAYED the notice (the operator stared at a
    // spinner while retries backed off) without improving recovery, because the
    // poll above already re-attempts on a fixed cadence. Failing fast and
    // showing an honest "can't reach the database, retrying" is strictly better.
    retry: false,
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
            // Stamped when this memo recomputes — i.e. when the blocks it
            // wraps actually changed, which IS when the snapshot was
            // assembled. Truthful, and avoids handing a time-based consumer
            // an epoch date that would read as 1970 (PR #2437 R1
            // non-blocking). Per-turn times come from each block's own
            // `timestamp`.
            assembledAt: new Date().toISOString(),
          }
        : null,
    [localId, blocks]
  );

  if (query.isPending) return <LoadingState message="Loading discussion…" className={className} />;
  if (query.isError) {
    // mt#3398: a database outage is NOT a thread failure. Rendered as a plain
    // notice rather than an ErrorState, and without the "Failed to load
    // discussion" prefix, because the thread's turns are intact and its agent
    // may still be running — the polling above keeps going and this clears
    // itself when the daemon recovers.
    if (query.error instanceof ThreadStoreUnavailableError) {
      return (
        <section className={className} aria-label="Discussion">
          <h2 className="text-sm font-medium text-foreground mb-2">Discussion</h2>
          <p className="text-sm text-muted-foreground py-3">{query.error.message}</p>
        </section>
      );
    }
    return <ErrorState prefix="Failed to load discussion" error={query.error} className={className} />;
  }

  const hasTurns = (blocks?.length ?? 0) > 0;
  // NOT `?? false` — `undefined` is passed through as "unknown" so the
  // helpers can distinguish it from a reported-dead agent (PR #2460 R1).
  const agentLive = query.data?.live;
  const composerState = deriveComposerState(blocks ?? [], sendMutation.isPending, agentLive);
  const stranded = isThreadStranded(blocks ?? [], sendMutation.isPending, agentLive);
  // Only looked up when a consumer supplied a slot — an entity kind with no
  // resolve semantics should not pay to scan its blocks for proposals.
  const proposal = proposalSlot ? findLatestResolveProposal(blocks ?? []) : null;
  const originNotice = deriveOriginNotice(query.data?.originSeeded);
  const pendingNotice = derivePendingRepliesNotice(query.data?.pendingReplies);
  const stoppedNotice = deriveAgentStoppedNotice(query.data?.agentStopReason);
  const swapNotice = deriveConversationSwapNotice(query.data?.conversationSwap);
  const recoveredNotice = deriveRecoveredRepliesNotice(query.data?.recoveredReplies);

  return (
    <section className={className} aria-label="Discussion">
      <h2 className="text-sm font-medium text-foreground mb-2">Discussion</h2>

      {originNotice ? (
        <p className="text-xs text-muted-foreground mb-2">{originNotice}</p>
      ) : null}

      {hasTurns && snapshot ? (
        <ConversationView snapshot={snapshot} />
      ) : (
        <p className="text-sm text-muted-foreground py-3">
          No discussion yet. Ask a question about this {entityType} and an agent will look into it.
        </p>
      )}

      {/* mt#4093: rendered OUTSIDE the pending/stopped/stranded chain below,
          deliberately. Those three answer one question — why is no reply
          coming? — and are mutually exclusive answers to it. This answers a
          different one: whose conversation are the blocks above? Both can be
          true at once (a swapped-in agent can also be stranded), and suppressing
          this to show one of those would restore exactly the silent continuity
          the swap creates. Placed under the history it qualifies. */}
      {swapNotice ? (
        <p className="text-sm text-muted-foreground mt-2" data-testid="entity-thread-conversation-swap">
          {swapNotice}
        </p>
      ) : null}

      {/* mt#4073: also outside the pending/stopped/stranded chain, and for the
          same reason the swap notice is. Those answer "why is no reply coming?";
          this answers "why is an old reply sitting at the bottom?" — and a
          thread can need both at once, since the restart that recovered one
          reply is often the restart that stranded another. Placed under the
          history because that is where the recovered turns are. */}
      {recoveredNotice ? (
        <p className="text-sm text-muted-foreground mt-2" data-testid="entity-thread-recovered-replies">
          {recoveredNotice}
        </p>
      ) : null}

      {/* mt#4036: this takes precedence over the stranded notice below, and the
          precedence is the fix, not a cosmetic ordering. "The agent stopped
          before answering" is FALSE when a reply was produced and lost — it
          blames the agent for a database failure and tells the operator to
          re-ask without saying why. Both conditions hold at once whenever an
          outage drops the reply to the operator's last question, which is
          exactly the 2026-08-11 shape. */}
      {pendingNotice ? (
        <p className="text-sm text-muted-foreground mt-2" data-testid="entity-thread-pending-replies">
          {pendingNotice}
        </p>
      ) : stoppedNotice ? (
        /* mt#4037: a KNOWN cause outranks the stranded line, which is the
           panel's weakest true statement — it names no cause and offers no way
           back. When the daemon can say the cockpit killed the agent, saying
           "the agent stopped before answering" instead is not merely vaguer, it
           is false. The stranded line survives below as the fallback for a
           daemon that reports no reason at all. */
        <p className="text-sm text-muted-foreground mt-2" data-testid="entity-thread-agent-stopped">
          {stoppedNotice}
        </p>
      ) : stranded ? (
        <p className="text-sm text-muted-foreground mt-2">
          The agent stopped before answering — send again to ask.
        </p>
      ) : null}

      {proposal && proposalSlot ? proposalSlot(proposal) : null}

      {sendMutation.isError ? (
        <ErrorState
          prefix="Failed to send — your message is still in the box; press Send to retry"
          error={sendMutation.error}
          className="mt-2"
        />
      ) : null}

      <DrivenSessionComposer
        interactionState={composerState}
        // `mutateAsync` (not `mutate`) so the composer can await delivery and
        // keep the operator's draft if it fails — see its `onSend` contract.
        // The composer catches the rejection; `sendMutation.isError` above is
        // what surfaces it.
        onSend={(text) => sendMutation.mutateAsync(text)}
        ariaLabel={`Ask a question about this ${entityType}`}
        idlePlaceholder="Ask a question about this…"
        className="mt-3"
      />
    </section>
  );
}
