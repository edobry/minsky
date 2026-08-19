/**
 * Session-context snapshot assembly (mt#2022).
 *
 * Reads from the canonical transcripts substrate (`agent_transcripts` turn
 * jsonb + `agent_transcript_attachments` sibling table) and produces a
 * chronologically-ordered, categorized `SessionContextSnapshot` for downstream
 * consumers (the cockpit context-inspector: mt#2023 / mt#2024 / mt#2025).
 *
 * Read-only against the DB substrate. No JSONL re-parsing at runtime — the
 * R3 retrospective discipline (memory `f6607043-...`) explicitly forbids that.
 *
 * @see mt#2022 — this file
 * @see mt#2033 — `ContextElement.type` unified taxonomy + `source` discriminator
 * @see mt#2021 — cockpit context-inspector umbrella
 */

import { asc, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptAttachmentsTable } from "../storage/schemas/agent-transcript-attachments-schema";
import { agentSpawnsTable } from "../storage/schemas/agent-spawns-schema";
import { getLoggableErrorSummary } from "../errors/index";
import type { AgentSessionId } from "./transcript-source";
import {
  applyAbandonedBlockIds,
  computeAbandonedBlockIds,
  markAbandonedRewindBranches,
} from "./rewind-detection";
import type {
  ContextElement,
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
  SessionContextSnapshotWindow,
} from "../context/types";

/**
 * Map an attachment-row's `attachmentType` to the unified `ContextElement.type`
 * taxonomy (mt#2033).
 *
 * The mapping captures the observation-path categorizations: hook injections,
 * MCP-server instructions, deferred-tool catalogs, skill listings, and so on.
 * Anything unrecognized falls through to `"other"` — defensive default that
 * keeps the snapshot complete without crashing on novel attachment shapes.
 */
export function mapAttachmentTypeToBlockType(
  rawJsonlType: string,
  attachmentType: string
): ContextElement["type"] {
  if (rawJsonlType === "attachment") {
    switch (attachmentType) {
      case "hook_additional_context":
        return "hook-injection";
      case "task_reminder":
        return "hook-injection";
      case "auto_mode":
        return "hook-injection";
      case "deferred_tools_delta":
        return "deferred-tool-catalog";
      case "mcp_instructions_delta":
        return "mcp-instructions";
      case "skill_listing":
        return "skill-body";
      default:
        return "other";
    }
  }
  if (rawJsonlType === "system") {
    // System lines (stop_hook_summary, turn_duration, etc.) are operational
    // metadata; they don't map cleanly to a context-element kind.
    return "metadata";
  }
  return "other";
}

/**
 * Map a turn-line `type` (`user` / `assistant`) plus its content shape to a
 * unified `ContextElement.type`. For assistants with reasoning content, the
 * caller should pass `kind: "thinking"` to route to `assistant-thinking`;
 * otherwise the default is `assistant-text`.
 */
export function mapTurnTypeToBlockType(
  jsonlType: string,
  kind?: "text" | "thinking"
): ContextElement["type"] {
  if (jsonlType === "user") return "user-prompt";
  if (jsonlType === "assistant")
    return kind === "thinking" ? "assistant-thinking" : "assistant-text";
  return "other";
}

/** Synthesize a stable block id for a turn-array entry. */
function turnBlockId(agentSessionId: string, turnIndex: number): string {
  return `${agentSessionId}:turn:${turnIndex}`;
}

/** Synthesize a stable block id for an attachment row. */
function attachmentBlockId(agentSessionId: string, lineIndex: number): string {
  return `${agentSessionId}:attachment:${lineIndex}`;
}

/**
 * Determine whether an assistant turn line's content array contains any
 * `type: "thinking"` block (Claude Code's reasoning channel). When mixed
 * content is present (thinking + text), we treat the line as
 * `assistant-thinking` so downstream consumers can route reasoning surfaces
 * to dedicated UI. Pure-text assistant lines route to `assistant-text`.
 */
export function assistantContentKind(message: unknown): "text" | "thinking" {
  if (message === null || typeof message !== "object") return "text";
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (!Array.isArray(content)) return "text";
  for (const block of content) {
    if (block !== null && typeof block === "object") {
      const bt = (block as Record<string, unknown>).type;
      if (bt === "thinking") return "thinking";
    }
  }
  return "text";
}

/**
 * Convert a raw turn line (from the `transcript` jsonb array OR a live-tail
 * JSONL read) to a snapshot block.
 *
 * Exported for the Rung-1 live-tail renderer (mt#2232): the live-tail SSE
 * endpoint reads raw JSONL lines via `JsonlTailer` and uses this function to
 * convert them to the unified `SessionContextSnapshotBlock` shape before
 * streaming them to the SPA — reusing the exact same conversion as the DB
 * snapshot path.
 *
 * The turn array stores user/assistant JSONL lines verbatim; this function
 * pulls the timestamp + parentUuid + content into the unified block shape
 * and resolves the assistant kind via `assistantContentKind`.
 */
export function turnLineToBlock(
  agentSessionId: string,
  turnIndex: number,
  line: unknown
): SessionContextSnapshotBlock | null {
  if (line === null || typeof line !== "object") return null;
  const l = line as Record<string, unknown>;
  const rawJsonlType = typeof l.type === "string" ? l.type : "";
  if (rawJsonlType !== "user" && rawJsonlType !== "assistant") return null;

  const tsStr = typeof l.timestamp === "string" ? l.timestamp : "";
  if (!tsStr) return null;

  const parentUuid = typeof l.parentUuid === "string" ? l.parentUuid : undefined;
  // mt#3323: the line's OWN node id — the other half of the parentUuid edge.
  // Read defensively and emitted only when present, so a line without it
  // produces a block identical to before.
  const uuid = typeof l.uuid === "string" ? l.uuid : undefined;
  const kind = rawJsonlType === "assistant" ? assistantContentKind(l.message) : undefined;

  // mt#3260: both are read defensively and emitted only when actually present,
  // so a line without them produces a byte-identical block to before.
  // `isCompactSummary` is a TOP-LEVEL boolean on a `user` line; `model` lives
  // on the assistant line's inner message.
  const isCompactSummary = l.isCompactSummary === true ? true : undefined;
  const message = l.message as Record<string, unknown> | undefined;
  const model = typeof message?.["model"] === "string" ? (message["model"] as string) : undefined;
  // mt#3322: same defensive/additive shape — `isMeta` is a TOP-LEVEL boolean on
  // a `user` line marking harness-generated (not operator-typed) content.
  const isMeta = l.isMeta === true ? true : undefined;

  return {
    id: turnBlockId(agentSessionId, turnIndex),
    type: mapTurnTypeToBlockType(rawJsonlType, kind),
    source: "observed",
    content: l.message ?? l,
    ...(isCompactSummary ? { isCompactSummary } : {}),
    ...(isMeta ? { isMeta } : {}),
    ...(model ? { model } : {}),
    uuid,
    parentUuid,
    timestamp: tsStr,
    turnIndex,
    rawJsonlType,
  };
}

/**
 * An opt-in bound on how much of a conversation the assembler returns (mt#4263).
 *
 * Opt-in because three of the four consumers of this snapshot read every block
 * (`ContextBlockView` filters them, `ConversationOverviewPanel` aggregates them,
 * `PublishConversationDialog` publishes them); only the conversation renderer
 * wants a window. Omitting this returns the whole conversation exactly as before.
 */
export interface SnapshotWindowRequest {
  /** Max renderable turn lines to return, counted back from the newest. */
  limit: number;
  /**
   * Return only turns whose ORIGINAL transcript-array index is strictly less
   * than this. Omit for the newest page; pass the previous response's
   * `window.oldestTurnIndex` to page backwards.
   */
  before?: number;
}

/** Upper bound on `limit`, so a client cannot ask for the whole transcript through the windowed path. */
export const MAX_SNAPSHOT_WINDOW_LIMIT = 500;

/**
 * Assemble a `SessionContextSnapshot` for a given agent session.
 *
 * Reads from BOTH the canonical substrate's turn-jsonb (`agent_transcripts.transcript`)
 * AND the new attachments table (`agent_transcript_attachments`), then merges
 * the two streams by timestamp into a single chronologically-ordered block list.
 *
 * Returns `null` if the session is unknown (no `agent_transcripts` row).
 *
 * Failure posture: defensively skips malformed transcript-array entries
 * (returns the snapshot with fewer blocks, not an error). DB errors propagate.
 */
export async function assembleSessionContextSnapshot(
  db: PostgresJsDatabase,
  agentSessionId: AgentSessionId,
  window?: SnapshotWindowRequest
): Promise<SessionContextSnapshot | null> {
  // The windowed path is a SEPARATE query rather than a parameterization of the
  // one below, deliberately. The unwindowed response must stay byte-for-byte
  // what it was (mt#4263 SC1), and the surest way to guarantee that is to leave
  // its code path untouched.
  if (window !== undefined) {
    return assembleWindowedSessionContextSnapshot(db, agentSessionId, window);
  }

  // 1. Issue every read as ONE wave. All four key on `agentSessionId` alone and
  //    none consumes another's output, so the three sequential waves this used
  //    to run (transcript row -> attachments -> the spawn pair) were serialized
  //    for no reason. mt#3696 measured exactly this defect on `/api/tasks/:id`:
  //    -40% locally and -61% in production, because de-serializing pays MORE the
  //    slower the substrate — and this endpoint's substrate is a REMOTE database
  //    (measured 2026-08-18: a 5-turn conversation, whose payload is negligible,
  //    still cost 0.51s across this sequence).
  //
  //    The spawn resolvers swallow their own errors and degrade to null, so the
  //    only rejection this `Promise.all` can see comes from the two reads below,
  //    which is the same failure the sequential form propagated.
  const [transcriptRows, attachmentRows, spawnChildrenByToolUseId, spawnParent] = await Promise.all(
    [
      db
        .select({
          harness: agentTranscriptsTable.harness,
          transcript: agentTranscriptsTable.transcript,
        })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
        .limit(1),
      // Ordered by line_index (stable per JSONL).
      db
        .select()
        .from(agentTranscriptAttachmentsTable)
        .where(eq(agentTranscriptAttachmentsTable.agentSessionId, agentSessionId))
        .orderBy(asc(agentTranscriptAttachmentsTable.lineIndex)),
      resolveSpawnChildren(db, agentSessionId),
      resolveSpawnParent(db, agentSessionId),
    ]
  );

  const parentRow = transcriptRows[0];
  if (!parentRow) return null;

  const { harness, transcript } = parentRow;
  const turnArray = Array.isArray(transcript) ? transcript : [];

  // 3. Convert both streams to unified blocks.
  const blocks: SessionContextSnapshotBlock[] = [];

  turnArray.forEach((entry, idx) => {
    const block = turnLineToBlock(agentSessionId, idx, entry);
    if (block !== null) blocks.push(block);
  });

  for (const row of attachmentRows) {
    const ts = row.timestamp instanceof Date ? row.timestamp.toISOString() : "";
    if (!ts) continue;
    blocks.push({
      id: attachmentBlockId(agentSessionId, row.lineIndex),
      type: mapAttachmentTypeToBlockType(row.rawJsonlType, row.attachmentType),
      source: "observed",
      content: row.content,
      parentUuid: row.parentUuid ?? undefined,
      timestamp: ts,
      rawJsonlType: row.rawJsonlType,
    });
  }

  // 4. Sort by timestamp ascending so the merged stream is chronological.
  blocks.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // 5. Mark superseded (rewound) operator-prompt branches (mt#3323). This only
  //    SETS `isAbandonedBranch` — no block is removed and no `turnIndex` is
  //    rewritten, because `SemanticEvent.turnIndex` is index-identical with
  //    this array's (`event-schema.ts`) and the session film joins on it.
  //    Returns the same array reference when there is no rewind to mark.
  const markedBlocks = markAbandonedRewindBranches(blocks);

  // 6. The spawn edges in both directions (mt#3692) were resolved in step 1's
  //    wave. Two small indexed lookups; a failure in either degrades to "no
  //    links" rather than failing the whole snapshot, since the transcript is
  //    still fully readable without the navigation affordance.
  return {
    agentSessionId,
    harness: typeof harness === "string" ? harness : "unknown",
    blocks: markedBlocks,
    ...(spawnChildrenByToolUseId ? { spawnChildrenByToolUseId } : {}),
    ...(spawnParent ? { spawnParent } : {}),
    assembledAt: new Date().toISOString(),
  };
}

/** One renderable turn line from the window, with its ORIGINAL array index. */
interface WindowedLineRow {
  i: number;
  l: unknown;
}

/**
 * Structure-only projection of one renderable turn line — no message content.
 *
 * `tr` is whether the line carries a `tool_result`, computed in SQL because
 * `carriesToolResult` needs it and shipping the content array to find out would
 * defeat the projection. Rebuilt into the minimal shape that predicate reads.
 */
interface StructureRow {
  i: number;
  u: string | null;
  p: string | null;
  t: string;
  ty: string;
  tr: boolean;
}

/** Structure-only projection of one attachment row. */
interface AttachmentStructureRow {
  i: number;
  p: string | null;
  t: string | null;
  ty: string;
}

interface WindowedAttachmentRow {
  lineIndex: number;
  rawJsonlType: string;
  attachmentType: string;
  content: unknown;
  parentUuid: string | null;
  timestamp: string | null;
}

interface ToolNameRow {
  id: string | null;
  name: string | null;
}

// A TYPE alias, not an interface: `db.execute<T>` constrains T to
// `Record<string, unknown>`, which an interface does not satisfy implicitly
// (interfaces have no implicit index signature; type aliases do).
type WindowedQueryRow = {
  harness: string | null;
  total_turns: number | string | null;
  oldest_turn_index: number | string | null;
  has_more: boolean | null;
  lines: WindowedLineRow[] | null;
  attachments: WindowedAttachmentRow[] | null;
  structure: StructureRow[] | null;
  attachment_structure: AttachmentStructureRow[] | null;
  tools: ToolNameRow[] | null;
};

function toInt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Windowed assembly (mt#4263) — the same snapshot, bounded to the most recent
 * `limit` renderable turns, with the window applied IN SQL.
 *
 * ## Why one statement and not several
 *
 * Three of the four things this needs depend on the window's own extent: the
 * turn lines, the attachments (bounded by the window's earliest TIMESTAMP,
 * because attachment `line_index` and turn index are different index spaces),
 * and the paging cursor. Splitting them would re-serialize round trips against
 * a REMOTE database — the exact defect mt#4258 removed from this function — so
 * the window is a CTE the later legs reference rather than a value passed
 * between statements.
 *
 * ## What is deliberately NOT windowed
 *
 * Two passes read the whole conversation's STRUCTURE (ids, parent edges, tool
 * ids) rather than its content, and a tail window gives each of them a wrong
 * answer rather than a partial one:
 *
 * - **Rewind marking** compares sibling prompt SUBTREES to decide which branch
 *   is live. Truncate both sides and the verdict changes with where the window
 *   cut — see `computeAbandonedBlockIds`.
 * - **Tool-call naming** lets a windowed `tool_result` name the call it answers
 *   when that call is outside the window; the renderer has always built it over
 *   all turns (`conversation-thread-model.ts`).
 *
 * Both therefore run over projections of the FULL transcript. They are cheap
 * for the reason the window exists: the payload is dominated by message
 * content, and neither pass reads any.
 */
async function assembleWindowedSessionContextSnapshot(
  db: PostgresJsDatabase,
  agentSessionId: AgentSessionId,
  request: SnapshotWindowRequest
): Promise<SessionContextSnapshot | null> {
  const limit = Math.max(1, Math.min(MAX_SNAPSHOT_WINDOW_LIMIT, Math.trunc(request.limit)));
  const before =
    request.before === undefined || !Number.isFinite(request.before)
      ? null
      : Math.trunc(request.before);

  // `renderable` mirrors `turnLineToBlock`'s own guard exactly (user/assistant
  // with a timestamp). Windowing over raw array entries instead would return
  // fewer blocks than the caller asked for whenever the transcript carries
  // summary or meta lines, and make `hasMore` disagree with what renders.
  const [rowsWindow, spawnChildrenByToolUseId, spawnParent] = await Promise.all([
    db.execute<WindowedQueryRow>(sql`
      with t as (
        select harness, transcript
        from agent_transcripts
        where agent_session_id = ${agentSessionId}
        limit 1
      ),
      lines as (
        select (e.ord - 1)::int as turn_index, e.line
        from t, lateral jsonb_array_elements(t.transcript) with ordinality as e(line, ord)
      ),
      renderable as (
        select turn_index, line
        from lines
        where line->>'type' in ('user', 'assistant')
          and line->>'timestamp' is not null
      ),
      win as (
        select turn_index, line
        from renderable
        where ${before === null ? sql`true` : sql`turn_index < ${before}`}
        order by turn_index desc
        limit ${limit}
      )
      select
        (select harness from t) as harness,
        (select count(*)::int from renderable) as total_turns,
        (select min(turn_index) from win) as oldest_turn_index,
        (
          select exists (
            select 1 from renderable
            where turn_index < coalesce((select min(turn_index) from win), 0)
          )
        ) as has_more,
        coalesce(
          (
            select jsonb_agg(jsonb_build_object('i', turn_index, 'l', line) order by turn_index)
            from win
          ),
          '[]'::jsonb
        ) as lines,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'lineIndex', a.line_index,
                'rawJsonlType', a.raw_jsonl_type,
                'attachmentType', a.attachment_type,
                'content', a.content,
                'parentUuid', a.parent_uuid,
                'timestamp', a.timestamp
              ) order by a.line_index
            )
            from agent_transcript_attachments a
            where a.agent_session_id = ${agentSessionId}
              and a.timestamp >= coalesce(
                (
                  select min((line->>'timestamp')::timestamptz)
                  from win
                  where line->>'timestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                ),
                '-infinity'::timestamptz
              )
          ),
          '[]'::jsonb
        ) as attachments,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'i', turn_index,
                'u', line->>'uuid',
                'p', line->>'parentUuid',
                't', line->>'timestamp',
                'ty', line->>'type',
                'tr', exists (
                  select 1
                  from jsonb_array_elements(
                    case
                      when jsonb_typeof(line->'message'->'content') = 'array'
                      then line->'message'->'content'
                      else '[]'::jsonb
                    end
                  ) as part
                  where part->>'type' = 'tool_result'
                )
              ) order by turn_index
            )
            from renderable
          ),
          '[]'::jsonb
        ) as structure,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'i', a.line_index,
                'p', a.parent_uuid,
                't', a.timestamp,
                'ty', a.raw_jsonl_type
              ) order by a.line_index
            )
            from agent_transcript_attachments a
            where a.agent_session_id = ${agentSessionId}
          ),
          '[]'::jsonb
        ) as attachment_structure,
        coalesce(
          (
            select jsonb_agg(distinct jsonb_build_object('id', part->>'id', 'name', part->>'name'))
            from renderable,
              lateral jsonb_array_elements(
                case
                  when jsonb_typeof(line->'message'->'content') = 'array'
                  then line->'message'->'content'
                  else '[]'::jsonb
                end
              ) as part
            where part->>'type' = 'tool_use' and part->>'id' is not null
          ),
          '[]'::jsonb
        ) as tools
    `),
    resolveSpawnChildren(db, agentSessionId),
    resolveSpawnParent(db, agentSessionId),
  ]);

  const row = rowsWindow[0];
  // `harness` is null only when no `agent_transcripts` row matched — every
  // other field defaults to an empty aggregate, so this is the miss signal and
  // it must return null exactly as the unwindowed path does.
  if (row === undefined || row.harness === null) return null;

  const blocks: SessionContextSnapshotBlock[] = [];

  for (const entry of row.lines ?? []) {
    const block = turnLineToBlock(agentSessionId, entry.i, entry.l);
    if (block !== null) blocks.push(block);
  }

  for (const attachment of row.attachments ?? []) {
    const ts = typeof attachment.timestamp === "string" ? attachment.timestamp : "";
    if (!ts) continue;
    blocks.push({
      id: attachmentBlockId(agentSessionId, attachment.lineIndex),
      type: mapAttachmentTypeToBlockType(attachment.rawJsonlType, attachment.attachmentType),
      source: "observed",
      content: attachment.content,
      parentUuid: attachment.parentUuid ?? undefined,
      timestamp: new Date(ts).toISOString(),
      rawJsonlType: attachment.rawJsonlType,
    });
  }

  blocks.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const abandoned = computeAbandonedBlockIds(
    structureBlocks(agentSessionId, row.structure ?? [], row.attachment_structure ?? [])
  );
  const markedBlocks = applyAbandonedBlockIds(blocks, abandoned);

  const toolNamesByUseId: Record<string, string> = {};
  for (const tool of row.tools ?? []) {
    if (typeof tool.id === "string" && typeof tool.name === "string") {
      toolNamesByUseId[tool.id] = tool.name;
    }
  }

  const window: SessionContextSnapshotWindow = {
    totalTurns: toInt(row.total_turns) ?? 0,
    returnedTurns: (row.lines ?? []).length,
    oldestTurnIndex: toInt(row.oldest_turn_index),
    hasMore: row.has_more === true,
  };

  return {
    agentSessionId,
    harness: typeof row.harness === "string" ? row.harness : "unknown",
    blocks: markedBlocks,
    ...(spawnChildrenByToolUseId ? { spawnChildrenByToolUseId } : {}),
    ...(spawnParent ? { spawnParent } : {}),
    window,
    toolNamesByUseId,
    assembledAt: new Date().toISOString(),
  };
}

/**
 * Rebuild the minimal block shape the rewind detector reads, from the
 * structure-only projections of the FULL transcript.
 *
 * Only five fields are load-bearing there — `id`, `uuid`, `parentUuid`,
 * `timestamp`, `rawJsonlType` — plus whether the line carries a `tool_result`,
 * which `carriesToolResult` reads off `content`. That predicate looks for a
 * `content` array holding a part of type `tool_result`, so a one-part stand-in
 * answers it identically without shipping the real payload.
 *
 * The ids MUST be built with the same two id functions the real blocks use, or
 * the set this feeds cannot address them.
 */
function structureBlocks(
  agentSessionId: string,
  turns: StructureRow[],
  attachments: AttachmentStructureRow[]
): SessionContextSnapshotBlock[] {
  const blocks: SessionContextSnapshotBlock[] = [];

  for (const turn of turns) {
    blocks.push({
      id: turnBlockId(agentSessionId, turn.i),
      type: mapTurnTypeToBlockType(turn.ty, undefined),
      source: "observed",
      content: turn.tr ? { content: [{ type: "tool_result" }] } : {},
      uuid: turn.u ?? undefined,
      parentUuid: turn.p ?? undefined,
      timestamp: turn.t,
      turnIndex: turn.i,
      rawJsonlType: turn.ty,
    });
  }

  for (const attachment of attachments) {
    blocks.push({
      id: attachmentBlockId(agentSessionId, attachment.i),
      type: "other",
      source: "observed",
      content: {},
      parentUuid: attachment.p ?? undefined,
      timestamp: attachment.t ?? "",
      rawJsonlType: attachment.ty,
    });
  }

  return blocks;
}

/**
 * Map each of this session's resolved spawns to its child conversation, keyed by
 * the spawning Agent call's `tool_use` id (mt#3692).
 *
 * Returns `undefined` when the session spawned nothing resolvable, so the field
 * is omitted from the snapshot rather than serialized as an empty object.
 */
async function resolveSpawnChildren(
  db: PostgresJsDatabase,
  agentSessionId: AgentSessionId
): Promise<Record<string, string> | undefined> {
  let rows: Array<{ parentToolUseId: string | null; childAgentSessionId: string | null }>;
  try {
    rows = await db
      .select({
        parentToolUseId: agentSpawnsTable.parentToolUseId,
        childAgentSessionId: agentSpawnsTable.childAgentSessionId,
      })
      .from(agentSpawnsTable)
      .where(eq(agentSpawnsTable.parentAgentSessionId, agentSessionId));
  } catch (err) {
    log.warn("assembleSessionContextSnapshot: spawn-children lookup failed", {
      agentSessionId,
      error: getLoggableErrorSummary(err),
    });
    return undefined;
  }

  return spawnChildrenFromRows(rows);
}

/**
 * Reduce `agent_spawns` rows to the tool_use-id → child map (mt#3692).
 *
 * Exported and pure so the row-admission rule is testable on its own, without
 * standing up a database to observe it.
 *
 * Both halves must be present:
 *   - A null `parentToolUseId` is a pre-mt#3692 row the backfill could not key —
 *     its parent turn no longer carries the call, or a sibling row already
 *     claimed the key. It addresses nothing in the transcript, so it must not
 *     produce a link.
 *   - A null `childAgentSessionId` is simply an unresolved spawn, which renders
 *     as a static badge.
 *
 * Returns `undefined` rather than `{}` when nothing qualifies, so the field is
 * omitted from the snapshot instead of serialized empty.
 *
 * Row ORDER cannot affect the result, so the caller's query deliberately does
 * not impose one (PR #2634 R1 raised this as a possible non-determinism).
 * `idx_agent_spawns_parent_tool_use_id` is UNIQUE on
 * `(parent_agent_session_id, parent_tool_use_id)`, and the caller filters to a
 * single `parent_agent_session_id` — so two rows can never share a key here and
 * there is nothing for a later write to clobber. Ordering by `spawned_at` would
 * read as protection against a collision the schema already forbids. If that
 * unique index is ever relaxed, this reduction needs a deterministic order.
 */
export function spawnChildrenFromRows(
  rows: ReadonlyArray<{ parentToolUseId: string | null; childAgentSessionId: string | null }>
): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.parentToolUseId && row.childAgentSessionId) {
      map[row.parentToolUseId] = row.childAgentSessionId;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Find the conversation that dispatched this one, if any (mt#3692).
 *
 * Index-independent: `agent_spawns.child_agent_session_id` names the child
 * directly, so this direction never needed a turn index. Same shape as
 * `resolveUserTurnActor` in the session-film route.
 *
 * Ordered, not merely limited (PR #2634 R1). Nothing constrains
 * `child_agent_session_id` to one row: the cwd-time-window heuristic can hand
 * the same child to two different parents, so a bare `LIMIT 1` would return
 * whichever row the backend happened to reach first and the backlink could
 * point somewhere different on each page load. Newest spawn wins, with the turn
 * index as a stable tiebreaker.
 */
async function resolveSpawnParent(
  db: PostgresJsDatabase,
  agentSessionId: AgentSessionId
): Promise<{ agentSessionId: string; agentKind?: string } | undefined> {
  try {
    const rows = await db
      .select({
        parentAgentSessionId: agentSpawnsTable.parentAgentSessionId,
        agentKind: agentSpawnsTable.agentKind,
      })
      .from(agentSpawnsTable)
      .where(eq(agentSpawnsTable.childAgentSessionId, agentSessionId))
      .orderBy(
        sql`${agentSpawnsTable.spawnedAt} DESC NULLS LAST`,
        desc(agentSpawnsTable.parentTurnIndex)
      )
      .limit(1);

    const parent = rows[0];
    if (!parent) return undefined;
    return {
      agentSessionId: parent.parentAgentSessionId,
      ...(parent.agentKind ? { agentKind: parent.agentKind } : {}),
    };
  } catch (err) {
    log.warn("assembleSessionContextSnapshot: spawn-parent lookup failed", {
      agentSessionId,
      error: getLoggableErrorSummary(err),
    });
    return undefined;
  }
}
