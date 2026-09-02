/**
 * Messages widget (mt#4874) — cross-session peer messages, both halves.
 *
 * Backs the cockpit `/messages` page. Claude Code's cross-session messaging
 * leaves BOTH halves of every message in the JSONL Minsky already ingests: the
 * sender's `SendMessage` tool call, and the receiver's `user` line carrying a
 * structured `origin` object. This widget reads both and correlates them; it
 * adds no capture layer, and it parses no envelope text.
 *
 * ## Where each half lives — and why neither is where you would guess
 *
 * **Sent.** The message TEXT is only in `agent_transcript_turns.tool_calls`.
 * `agent_tool_call_projection` looks like the natural source and is not: it
 * stores an `arg_fingerprint` — "a stable short hash of the (normalized)
 * tool-call input — NEVER the raw arguments" (its own schema docblock), so the
 * text cannot be recovered from it. But the projection IS the right INDEX: it
 * exists precisely so a consumer can find tool calls "without ever reading the
 * raw jsonb column", which for this table holds whole Write/Edit file bodies.
 * So the sender path is two steps — find the turns via the projection, then
 * fetch only those turns by primary key.
 *
 * **Received.** The envelope is NOT in `agent_transcript_turns`. That table has
 * `user_origin` (mt#4289) but not `origin`; the structured object survives only
 * on the raw line in `transcript_lines` (ADR-045). So `user_origin = 'peer'` is
 * used as the cheap index to find which sessions received messages, and the
 * envelope is then read from the raw line for those sessions.
 *
 * ## The coverage gap this reports rather than hides
 *
 * The two receiver sources disagree, in BOTH directions (measured 2026-09-02):
 *
 * ```
 * 12 turns classified user_origin = 'peer'
 * 11 raw lines carrying origin.kind = 'peer'
 * 10 of those envelopes reachable from a session that also has a peer turn
 *  2 sessions have a peer turn but no envelope in transcript_lines
 *  1 session has an envelope but no peer turn
 * ```
 *
 * The first gap is ingest coverage — `transcript_lines` only backfills forward
 * from mt#4573 (mt#4590 owns the backfill). The second is the turns-first
 * design's own blind spot: a delivery whose turn was never classified is out of
 * this query's reach by construction.
 *
 * Per `src/cockpit/types.ts`'s mt#2758 convention, a widget must not let one
 * source's shortfall resolve to the same empty value as genuine no-data. This
 * one reports the shortfall as explicit COUNTS on the payload
 * ({@link MessagesCoverage}) rather than the convention's `queryFailureCount`
 * pair, and the difference is deliberate: this widget degrades as a WHOLE on any
 * query failure (one try/catch, no per-source catch-to-empty), so it has no
 * failure-vs-no-data blind spot to instrument. What it does have is a known DATA
 * gap, which a failure counter would not describe.
 *
 * ## What this deliberately does not compute
 *
 * `sent - received` is not rendered as an undelivered count, here or on the
 * page. The gap is real and its composition is unmeasured: a send to a subagent
 * lands in that subagent's transcript, and whether that transcript was ingested
 * is a different question from whether the message was delivered. The vendor
 * documentation additionally names held, refused, expired, over-size, burst and
 * loop-throttled outcomes. So an unpaired send reports as "no delivery record
 * found" and is never totalled into a failure.
 *
 * @see mt#4874 — this widget
 * @see @minsky/domain/transcripts/peer-message-correlation — the pairing rules
 * @see @minsky/domain/transcripts/peer-message-origin — the envelope projection
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getContextInspectorDb, describeWidgetDegradedReason } from "../db-providers";
import { agentTranscriptTurnsTable } from "@minsky/domain/storage/schemas/agent-transcript-turns-schema";
import { agentToolCallProjectionTable } from "@minsky/domain/storage/schemas/agent-tool-call-projection-schema";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { transcriptLinesTable } from "@minsky/domain/storage/schemas/transcript-lines-schema";
import { readPeerMessageOrigin } from "@minsky/domain/transcripts/peer-message-origin";
import {
  correlatePeerMessages,
  SEND_MESSAGE_TOOL_NAME,
  type PeerMessageFeed,
  type ReceivedPeerMessage,
  type SentPeerMessage,
} from "@minsky/domain/transcripts/peer-message-correlation";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import type { ConversationId } from "@minsky/domain/ids";

// ---------------------------------------------------------------------------
// Payload — mirrored by the frontend hook/page.
// ---------------------------------------------------------------------------

/**
 * What this view can and cannot see, as numbers rather than prose.
 *
 * Rendered on the page itself (SC10), not merely recorded here: a coverage
 * limit the operator cannot see is one they will read a partial feed as a
 * complete one.
 */
export interface MessagesCoverage {
  /** Turns classified `user_origin = 'peer'` — deliveries we know occurred. */
  peerTurns: number;
  /** Of those, how many had a readable `origin` envelope in `transcript_lines`. */
  envelopesRead: number;
  /**
   * `peerTurns - envelopesRead`: deliveries known to have happened whose
   * envelope is not indexed, so they cannot be shown in detail. Never negative.
   */
  envelopesMissing: number;
  /** `SendMessage` blocks read from the scanned turns. */
  sendsRead: number;
  /** How many projection rows the sender scan looked at. */
  senderScanLimit: number;
  /**
   * True when the scan filled its limit, so older sends exist beyond this view.
   * Surfaced rather than left implicit — a silent cap reads as completeness.
   */
  senderScanTruncated: boolean;
}

export type MessagesPayload =
  | { status: "no-data"; coverage: MessagesCoverage }
  | { status: "ok"; feed: PeerMessageFeed; coverage: MessagesCoverage };

/**
 * How many projection rows the sender scan reads, newest-first.
 *
 * Sized above the whole observed population (348 `SendMessage` blocks in
 * production, 2026-09-02) so today's page is complete, while staying a bounded
 * scan as the corpus grows. `senderScanTruncated` reports the day it stops
 * being enough.
 */
export const SENDER_SCAN_LIMIT = 500;

// ---------------------------------------------------------------------------
// Pure readers — exported so the jsonb shapes are testable without a database.
// ---------------------------------------------------------------------------

/** One `SendMessage` block lifted out of a turn's `tool_calls` array. */
export interface SendMessageBlock {
  ordinal: number;
  recipient: string | null;
  message: string | null;
}

function readStringField(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read every `SendMessage` block out of one turn's `tool_calls`.
 *
 * Fails open per block, matching `peer-message-origin`'s posture: a malformed
 * entry is skipped, never allowed to throw and take the whole feed down with
 * it. A block with no `input.message` is still RETURNED — production has one —
 * because a send that happened is a fact about the world even when its payload
 * cannot be read; dropping it would under-report the sender side.
 *
 * `ordinal` is this block's index within the array, matching
 * `agent_tool_call_projection.ordinal`'s definition. It is re-derived from the
 * turn rather than carried over from the projection so the two cannot drift.
 */
export function readSendMessageBlocks(toolCalls: unknown): SendMessageBlock[] {
  if (!Array.isArray(toolCalls)) return [];
  const blocks: SendMessageBlock[] = [];
  toolCalls.forEach((entry, ordinal) => {
    if (!entry || typeof entry !== "object") return;
    if (readStringField(entry, "name") !== SEND_MESSAGE_TOOL_NAME) return;
    const input = (entry as Record<string, unknown>)["input"];
    blocks.push({
      ordinal,
      // The sender addresses an agent id or name; `to` and `recipient` are both
      // observed on the stored input, so neither alone is sufficient.
      recipient: readStringField(input, "to") ?? readStringField(input, "recipient"),
      message: readStringField(input, "message"),
    });
  });
  return blocks;
}

function toMs(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A raw line's own `timestamp`, in epoch ms.
 *
 * The delivery time must come from the LINE, not from its turn: a turn spans
 * everything between two prompts, so its boundaries would place a delivery
 * anywhere in that span and blur exactly the correlation this feeds.
 */
function readLineTimestampMs(line: unknown): number | null {
  if (!line || typeof line !== "object") return null;
  const raw = (line as Record<string, unknown>)["timestamp"];
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

/** The slice of a Drizzle db this widget needs — narrow so tests can inject a fake. */
export interface MessagesDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
}

interface TurnRef {
  agentSessionId: string;
  turnIndex: number;
}

function emptyCoverage(overrides: Partial<MessagesCoverage> = {}): MessagesCoverage {
  return {
    peerTurns: 0,
    envelopesRead: 0,
    envelopesMissing: 0,
    sendsRead: 0,
    senderScanLimit: SENDER_SCAN_LIMIT,
    senderScanTruncated: false,
    ...overrides,
  };
}

export function createMessagesWidget(
  getDb: () => Promise<MessagesDb | null>,
  getProjectScopeDb?: () => Promise<ScopeResolverDb | null>
): WidgetModule {
  return {
    id: "messages",
    title: "Messages",
    updateMode: { type: "polling", intervalMs: 60_000 },
    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const db = await getDb();
        if (!db) return { state: "degraded", reason: "DB not connected" };

        const { resolveCockpitProjectScope } = await import("../project-scope");
        const { isAllProjects } = await import("@minsky/domain/project/scope");
        const projectScope = await resolveCockpitProjectScope(ctx.query?.project, {
          getDb: getProjectScopeDb,
        });

        // --- Sender side, step 1: the projection is the index, never the source.
        // Deliberately unjoined so this stays the plain index scan the mt#4874
        // partial index was measured against; project scoping is applied below
        // from the session->project map both halves need anyway.
        const sendRefs = (await db
          .select({
            agentSessionId: agentToolCallProjectionTable.agentSessionId,
            turnIndex: agentToolCallProjectionTable.turnIndex,
          })
          .from(agentToolCallProjectionTable)
          .where(eq(agentToolCallProjectionTable.toolName, SEND_MESSAGE_TOOL_NAME))
          .orderBy(desc(agentToolCallProjectionTable.timestamp))
          .limit(SENDER_SCAN_LIMIT)) as TurnRef[];

        const senderScanTruncated = sendRefs.length >= SENDER_SCAN_LIMIT;

        // --- Receiver side, step 1: which turns were classified as deliveries.
        const peerTurnRows = (await db
          .select({
            agentSessionId: agentTranscriptTurnsTable.agentSessionId,
            turnIndex: agentTranscriptTurnsTable.turnIndex,
          })
          .from(agentTranscriptTurnsTable)
          .where(eq(agentTranscriptTurnsTable.userOrigin, "peer"))) as TurnRef[];

        const senderSessionIds = [...new Set(sendRefs.map((r) => r.agentSessionId))];
        const receiverSessionIds = [...new Set(peerTurnRows.map((r) => r.agentSessionId))];
        const allSessionIds = [...new Set([...senderSessionIds, ...receiverSessionIds])];

        if (allSessionIds.length === 0) {
          return { state: "ok", payload: { status: "no-data", coverage: emptyCoverage() } };
        }

        // --- Project scope. `agent_transcripts.project_id` is resolved at
        // ingest from the transcript's own cwd and is nullable; a transcript
        // with no project cannot satisfy a specific project filter, the same
        // way task-list.ts drops an unscoped task.
        const scopeRows = (await db
          .select({
            agentSessionId: agentTranscriptsTable.agentSessionId,
            projectId: agentTranscriptsTable.projectId,
          })
          .from(agentTranscriptsTable)
          // `agent_transcripts.agent_session_id` is branded `ConversationId`
          // while the sibling tables' matching columns are plain `text`, so the
          // ids collected above are `string[]`. The values are the same ids —
          // this narrows for the column's brand, it does not reinterpret them.
          .where(
            inArray(agentTranscriptsTable.agentSessionId, allSessionIds as ConversationId[])
          )) as Array<{
          agentSessionId: string;
          projectId: string | null;
        }>;

        const inScope = new Set<string>();
        for (const row of scopeRows) {
          if (isAllProjects(projectScope) || row.projectId === projectScope) {
            inScope.add(row.agentSessionId);
          }
        }

        const scopedSendRefs = sendRefs.filter((r) => inScope.has(r.agentSessionId));
        const scopedPeerTurns = peerTurnRows.filter((r) => inScope.has(r.agentSessionId));

        // --- Sender side, step 2: fetch ONLY the scanned turns, by primary key.
        const sent: SentPeerMessage[] = [];
        if (scopedSendRefs.length > 0) {
          const turnRows = (await db
            .select({
              agentSessionId: agentTranscriptTurnsTable.agentSessionId,
              turnIndex: agentTranscriptTurnsTable.turnIndex,
              toolCalls: agentTranscriptTurnsTable.toolCalls,
              startedAt: agentTranscriptTurnsTable.startedAt,
              endedAt: agentTranscriptTurnsTable.endedAt,
            })
            .from(agentTranscriptTurnsTable)
            .where(
              and(
                inArray(agentTranscriptTurnsTable.agentSessionId, [
                  ...new Set(scopedSendRefs.map((r) => r.agentSessionId)),
                ]),
                inArray(agentTranscriptTurnsTable.turnIndex, [
                  ...new Set(scopedSendRefs.map((r) => r.turnIndex)),
                ])
              )
            )) as Array<{
            agentSessionId: string;
            turnIndex: number;
            toolCalls: unknown;
            startedAt: Date | string | null;
            endedAt: Date | string | null;
          }>;

          // The two `inArray`s above are a CROSS product of session ids and turn
          // indexes, not the pair list — drizzle has no portable row-value `IN`.
          // So the result is a superset and must be narrowed back to the pairs
          // the projection actually named, or a turn that merely shares an index
          // with a sending turn in another session would be read as a send.
          const wanted = new Set(scopedSendRefs.map((r) => `${r.agentSessionId}:${r.turnIndex}`));
          for (const row of turnRows) {
            if (!wanted.has(`${row.agentSessionId}:${row.turnIndex}`)) continue;
            for (const block of readSendMessageBlocks(row.toolCalls)) {
              sent.push({
                agentSessionId: row.agentSessionId,
                turnIndex: row.turnIndex,
                ordinal: block.ordinal,
                recipient: block.recipient,
                message: block.message,
                startedAtMs: toMs(row.startedAt),
                endedAtMs: toMs(row.endedAt),
              });
            }
          }
        }

        // --- Receiver side, step 2: read the envelope off the RAW line.
        const received: ReceivedPeerMessage[] = [];
        const scopedReceiverSessionIds = [...new Set(scopedPeerTurns.map((r) => r.agentSessionId))];
        if (scopedReceiverSessionIds.length > 0) {
          const lineRows = (await db
            .select({
              agentSessionId: transcriptLinesTable.agentSessionId,
              lineOrdinal: transcriptLinesTable.lineOrdinal,
              line: transcriptLinesTable.line,
            })
            .from(transcriptLinesTable)
            .where(
              and(
                inArray(transcriptLinesTable.agentSessionId, scopedReceiverSessionIds),
                eq(transcriptLinesTable.lineType, "user"),
                sql`${transcriptLinesTable.line}->'origin'->>'kind' = 'peer'`
              )
            )) as Array<{ agentSessionId: string; lineOrdinal: number; line: unknown }>;

          for (const row of lineRows) {
            const origin = readPeerMessageOrigin(row.line);
            if (origin === null) continue;
            received.push({
              agentSessionId: row.agentSessionId,
              lineOrdinal: row.lineOrdinal,
              receivedAtMs: readLineTimestampMs(row.line),
              origin,
            });
          }
        }

        const coverage: MessagesCoverage = {
          peerTurns: scopedPeerTurns.length,
          envelopesRead: received.length,
          envelopesMissing: Math.max(0, scopedPeerTurns.length - received.length),
          sendsRead: sent.length,
          senderScanLimit: SENDER_SCAN_LIMIT,
          senderScanTruncated,
        };

        if (sent.length === 0 && received.length === 0) {
          return { state: "ok", payload: { status: "no-data", coverage } };
        }

        const feed = correlatePeerMessages(sent, received);
        return { state: "ok", payload: { status: "ok", feed, coverage } satisfies MessagesPayload };
      } catch (err) {
        return { state: "degraded", reason: describeWidgetDegradedReason("messages", err) };
      }
    },
  };
}

export const messagesWidget: WidgetModule = createMessagesWidget(getContextInspectorDb);
