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
import { MAX_SNAPSHOT_WINDOW_LIMIT } from "./snapshot-window-limit";
import { classifyUserLineOrigin, DISPATCH_BRIEF_ORIGIN } from "./user-line-origin";
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
/**
 * Does this `user` line's message actually carry TEXT (mt#4354)?
 *
 * The gate on `userOrigin`, mirroring `turn-extractor.ts`'s invariant that the
 * origin describes the TEXT and is therefore null exactly when the text is. A
 * `user` line whose content is entirely `tool_result` blocks contributes none.
 *
 * Takes the line's `message`, which is ALWAYS an object — measured across 400
 * recent transcripts, 80,755 `user` lines, `typeof message === "object"` in
 * every one. The early return for a non-object is a defensive guard on
 * malformed input, not a supported shape.
 *
 * It is `message.CONTENT` that has two shapes, and both are handled: a bare
 * STRING (how a dispatched subagent's first turn arrives — verified against
 * `subagents/agent-a335fb8b0e7586511.jsonl` line 1, a 6,661-char string), and
 * the usual ARRAY of typed blocks.
 *
 * PR #3574 R1 flagged this docblock as claiming the STRING case applied to
 * `message` itself, which would have meant the origin was never stamped for a
 * dispatch brief. The claim was about `content` and the code is correct — the
 * end-to-end run stamps `dispatch_brief` on exactly that record — but the
 * sentence did not say so, and a comment that misdescribes its own guard is
 * worth fixing rather than explaining.
 */
function userLineCarriesText(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (block === null || typeof block !== "object") return false;
    const b = block as Record<string, unknown>;
    return b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim().length > 0;
  });
}

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
  // mt#4354: who authored this user line's text, via the SAME classifier that
  // writes `agent_transcript_turns.user_origin` (mt#4289) — one classifier, two
  // call sites. Gated on the line actually carrying text so this mirrors that
  // column's invariant rather than stamping a `tool_result`-only line; see the
  // field's docblock in `../context/types.ts` for why that distinction matters.
  const userOrigin =
    rawJsonlType === "user" && userLineCarriesText(l.message)
      ? classifyUserLineOrigin(l)
      : undefined;

  return {
    id: turnBlockId(agentSessionId, turnIndex),
    type: mapTurnTypeToBlockType(rawJsonlType, kind),
    source: "observed",
    content: l.message ?? l,
    ...(isCompactSummary ? { isCompactSummary } : {}),
    ...(isMeta ? { isMeta } : {}),
    ...(userOrigin ? { userOrigin } : {}),
    ...(model ? { model } : {}),
    uuid,
    parentUuid,
    timestamp: tsStr,
    turnIndex,
    rawJsonlType,
  };
}

/**
 * Turn 0 as a pinnable block, when it is a dispatch brief (mt#4909).
 *
 * The windowed assembler calls this with raw transcript entry 0, which the SQL
 * supplies ONLY when the slice did not already reach it — so `null` in means
 * "the brief is already in the page" (or there is no conversation), and
 * `undefined` out means "nothing to pin". Both of those are the common case.
 *
 * Routed through {@link turnLineToBlock} rather than calling the classifier
 * directly, which is the point of the function existing: a brief that would not
 * RENDER as a brief must not PIN as one either, and one code path is what keeps
 * those two answers from drifting. It also means a non-renderable entry 0 (a
 * summary or meta line) yields nothing here, exactly as it would in the page.
 *
 * Only `dispatch_brief` pins. `"human"` is the classifier's FAIL-OPEN default —
 * returned when no structural marker matched, not positive evidence of operator
 * authorship (see the `userOrigin` docblock in `../context/types.ts`) — so
 * pinning on anything else would hoist an arbitrary first turn above every long
 * conversation in the cockpit.
 *
 * @internal Exported for its own tests, NOT for use outside this module — the
 * decision is pure and worth checking against real line shapes, while the query
 * around it is not reachable without a DB. The windowed assembler is the only
 * intended caller; a consumer wanting the pinned brief should read
 * `SessionContextSnapshot.headBlock` rather than re-deriving it here, which is
 * what keeps the classification in one place (PR #3586 R1).
 */
export function dispatchBriefHeadBlock(
  agentSessionId: string,
  headLine: unknown
): SessionContextSnapshotBlock | undefined {
  if (headLine === null || headLine === undefined) return undefined;
  const block = turnLineToBlock(agentSessionId, 0, headLine);
  if (block === null) return undefined;
  return block.userOrigin === DISPATCH_BRIEF_ORIGIN ? block : undefined;
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
   * `window.nextBefore` to page backwards.
   *
   * NOT `window.oldestTurnIndex` — that describes the oldest turn RENDERED and
   * is null for a page whose entries were all non-renderable, which ends paging
   * over history that still exists (PR #3148 R1).
   */
  before?: number;
}

// Re-exported so existing importers of this module keep resolving it, while the
// value itself lives in a module the route can read without loading this one.
export { MAX_SNAPSHOT_WINDOW_LIMIT };

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
  window?: SnapshotWindowRequest,
  structure?: SnapshotStructure | Promise<SnapshotStructure>
): Promise<SessionContextSnapshot | null> {
  // The windowed path is a SEPARATE query rather than a parameterization of the
  // one below, deliberately. The unwindowed response must stay byte-for-byte
  // what it was (mt#4263 SC1), and the surest way to guarantee that is to leave
  // its code path untouched.
  if (window !== undefined) {
    return assembleWindowedSessionContextSnapshot(db, agentSessionId, window, structure);
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
/**
 * A conversation's derived STRUCTURE — everything the renderer needs that a tail
 * window cannot supply, and nothing that depends on which window was asked for
 * (mt#4263).
 *
 * Both members are pure functions of the conversation's stored rows, so they are
 * valid for exactly as long as the route's version token is, and identical
 * across every window over the same conversation. That is what makes them worth
 * caching separately: the first page of a conversation pays to derive them, and
 * every scroll-back page after it pays nothing.
 */
export interface SnapshotStructure {
  /**
   * Block ids superseded by a rewind, computed over the FULL transcript. An
   * ARRAY rather than a Set so the value survives a cache that may one day
   * serialize.
   */
  abandonedBlockIds: string[];
  /** Every `tool_use` id in the conversation mapped to its tool name. */
  toolNamesByUseId: Record<string, string>;
}

type StructureQueryRow = {
  structure: StructureRow[] | null;
  attachment_structure: AttachmentStructureRow[] | null;
  tools: ToolNameRow[] | null;
};

/**
 * Derive a conversation's structure: which blocks a rewind superseded, and what
 * every tool_use id is called.
 *
 * Separate from the window query on purpose. These two passes are the only part
 * of a windowed assembly that reads the WHOLE transcript, so keeping them in the
 * window statement made every scroll-back page pay to re-derive facts that had
 * not changed — measured at `assemble;dur=756ms` on a 2,236-turn conversation
 * even after the window itself cut the payload 51x. Split out, the caller can
 * hold them against the same version token the response is already validated by.
 */
export async function computeSnapshotStructure(
  db: PostgresJsDatabase,
  agentSessionId: AgentSessionId
): Promise<SnapshotStructure> {
  const rows = await db.execute<StructureQueryRow>(sql`
    with t as (
      select transcript
      from agent_transcripts
      where agent_session_id = ${agentSessionId}
      limit 1
    ),
    lines as (
      select (e.ord - 1)::int as turn_index, e.line
      from t, lateral jsonb_array_elements(t.transcript) with ordinality as e(line, ord)
    ),
    renderable as (
      select
        turn_index,
        line->>'uuid' as uuid,
        line->>'parentUuid' as parent_uuid,
        line->>'timestamp' as ts,
        line->>'type' as raw_type,
        -- Projected here so the two legs below never touch the full line again.
        -- This is the whole reason the split pays: what leaves this CTE is a
        -- handful of scalars per turn plus the content array, not the turn.
        line->'message'->'content' as parts
      from lines
      where line->>'type' in ('user', 'assistant')
        and line->>'timestamp' is not null
    )
    select
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'i', turn_index,
              'u', uuid,
              'p', parent_uuid,
              't', ts,
              'ty', raw_type,
              -- Containment, not a per-row lateral + EXISTS. The lateral form
              -- cost ~1.2s of assembly on the 2,236-turn conversation — one
              -- correlated subquery per turn — and made the windowed request no
              -- faster than the unwindowed one it replaces.
              'tr', coalesce(parts @> '[{"type": "tool_result"}]'::jsonb, false)
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
          -- Prune to the lines that actually carry a tool_use BEFORE the
          -- lateral, so the expansion runs over the assistant turns that have
          -- one rather than over every turn in the conversation.
          from (
            select parts
            from renderable
            where jsonb_typeof(parts) = 'array'
              and parts @> '[{"type": "tool_use"}]'::jsonb
          ) tu,
            lateral jsonb_array_elements(tu.parts) as part
          where part->>'type' = 'tool_use' and part->>'id' is not null
        ),
        '[]'::jsonb
      ) as tools
  `);

  const row = rows[0];
  if (row === undefined) return { abandonedBlockIds: [], toolNamesByUseId: {} };

  const abandoned = computeAbandonedBlockIds(
    structureBlocks(agentSessionId, row.structure ?? [], row.attachment_structure ?? [])
  );

  const toolNamesByUseId: Record<string, string> = {};
  for (const tool of row.tools ?? []) {
    if (typeof tool.id === "string" && typeof tool.name === "string") {
      toolNamesByUseId[tool.id] = tool.name;
    }
  }

  return { abandonedBlockIds: [...abandoned], toolNamesByUseId };
}

type WindowedQueryRow = {
  harness: string | null;
  total_turns: number | string | null;
  /** ORIGINAL array index of `lines[0]`; every entry's index is this plus its position. */
  slice_start: number | string | null;
  lines: unknown[] | null;
  attachments: WindowedAttachmentRow[] | null;
  /**
   * Raw transcript entry 0, present only when the slice did not already reach
   * it (mt#4909) — the candidate dispatch brief. `null` when `lo === 0`, which
   * is also when the caller needs nothing extra because the brief is in
   * `lines`.
   */
  head_line: unknown | null;
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
  request: SnapshotWindowRequest,
  structure?: SnapshotStructure | Promise<SnapshotStructure>
): Promise<SessionContextSnapshot | null> {
  // Accepted as a value OR a promise so a caller holding a cached structure
  // passes it directly, and one that does not can hand over an in-flight query
  // that resolves inside the same wave as the window itself. Awaiting it here
  // rather than before the call is what keeps the two concurrent.
  const resolvedStructure = structure ?? computeSnapshotStructure(db, agentSessionId);
  const limit = Math.max(1, Math.min(MAX_SNAPSHOT_WINDOW_LIMIT, Math.trunc(request.limit)));
  const before =
    request.before === undefined || !Number.isFinite(request.before)
      ? null
      : Math.trunc(request.before);

  // ## Why the slice is taken by ARRAY INDEX rather than by filtering rows
  //
  // The obvious form — expand with `jsonb_array_elements ... WITH ORDINALITY`,
  // filter to renderable lines, `order by ... desc limit N` — is what shipped
  // first, and it does not deliver the win. It makes Postgres expand and
  // materialize all 2,236 entries INCLUDING their full message content just to
  // choose 50 of them, so the window saves the wire and not the scan: measured
  // `assemble;dur=612–700ms` on this conversation even with every whole-transcript
  // pass already cached.
  //
  // `jsonb_array_length` is O(1) on jsonb, and a jsonpath index range reads only
  // the elements it names, because jsonb stores an array as a binary structure
  // with an offset table rather than as text to be parsed. So the bounds are
  // computed as integers and the slice is addressed directly.
  //
  // The cost of doing it this way: the slice is over RAW array positions, so a
  // non-renderable entry inside it (a summary or meta line `turnLineToBlock`
  // rejects) yields a page slightly shorter than `limit` rather than reaching
  // further back to backfill. That is a real difference and an acceptable one —
  // the caller asked for AT MOST `limit`, `oldestTurnIndex` still says exactly
  // where the page ends, and paging is unaffected. It is also rare in practice:
  // `agent_transcripts.transcript` holds only user/assistant lines (attachments
  // live in their own table), which is why the ETag's `jsonb_array_length` and
  // the renderable count agree at 2,236 on this conversation.
  const [rowsWindow, snapshotStructure, spawnChildrenByToolUseId, spawnParent] = await Promise.all([
    db.execute<WindowedQueryRow>(sql`
      with t as (
        select harness, transcript, jsonb_array_length(transcript) as total
        from agent_transcripts
        where agent_session_id = ${agentSessionId}
        limit 1
      ),
      bounds as (
        select
          harness,
          transcript,
          total,
          -- hi is EXCLUSIVE, mirroring the before cursor's own meaning.
          least(coalesce(${before}::int, total), total) as hi,
          greatest(least(coalesce(${before}::int, total), total) - ${limit}, 0) as lo
        from t
      ),
      sliced as (
        select
          harness,
          total,
          lo,
          -- mt#4909: raw entry 0, but only when the slice did not already
          -- reach it — otherwise the brief is in the raw slice below and
          -- sending it twice would render it twice. The arrow operator is an
          -- O(1) offset read into the same binary structure the jsonpath range
          -- addresses, so this adds one element to the payload and no scan.
          case when lo > 0 then transcript -> 0 else null end as head,
          case
            when hi > lo then coalesce(
              jsonb_path_query_array(
                transcript,
                ('$[' || lo || ' to ' || (hi - 1) || ']')::jsonpath
              ),
              '[]'::jsonb
            )
            else '[]'::jsonb
          end as raw
        from bounds
      )
      select
        s.harness as harness,
        s.total as total_turns,
        s.lo as slice_start,
        s.raw as lines,
        s.head as head_line,
        coalesce(
          -- PR #3586 R1 (NON-BLOCKING): an EMPTY slice must not re-send every
          -- attachment. When hi <= lo the slice is an empty array, so the
          -- min/max bounds below coalesce to -infinity and +infinity — and the
          -- upper bound then stops bounding anything, so a request that selects
          -- no turns would return the whole attachment set for the conversation.
          -- The UI cannot reach it (TanStack halts paging on a null cursor), but
          -- the route is public and can be called directly. Short-circuit on the
          -- slice being empty, which is the same condition in a form this scope
          -- can see.
          case when jsonb_array_length(s.raw) = 0 then '[]'::jsonb else (
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
              -- Bounded by the window's TIMESTAMP RANGE, not by an index:
              -- attachment line_index and turn index are different index
              -- spaces, and the two streams are merged by timestamp below.
              and a.timestamp >= coalesce(
                (
                  select min((e->>'timestamp')::timestamptz)
                  from jsonb_array_elements(s.raw) e
                  where e->>'timestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                ),
                '-infinity'::timestamptz
              )
              -- The UPPER bound exists only on a scroll-back page, and it is
              -- not an optimization. Without it the bound is open-ended, so
              -- every page back re-sends every attachment newer than its own
              -- oldest turn — measured 30, then 54, then 76 attachments over
              -- three consecutive pages of one conversation, each page
              -- re-delivering what the client already had. On the NEWEST page
              -- the bound stays open on purpose: a live conversation can land
              -- an attachment after its last turn, and that one belongs here.
              and ${
                before === null
                  ? sql`true`
                  : sql`a.timestamp <= coalesce(
                      (
                        select max((e->>'timestamp')::timestamptz)
                        from jsonb_array_elements(s.raw) e
                        where e->>'timestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                      ),
                      'infinity'::timestamptz
                    )`
              }
          ) end,
          '[]'::jsonb
        ) as attachments
      from sliced s
    `),
    resolvedStructure,
    resolveSpawnChildren(db, agentSessionId),
    resolveSpawnParent(db, agentSessionId),
  ]);

  const row = rowsWindow[0];
  // `harness` is null only when no `agent_transcripts` row matched — every
  // other field defaults to an empty aggregate, so this is the miss signal and
  // it must return null exactly as the unwindowed path does.
  if (row === undefined || row.harness === null) return null;

  const blocks: SessionContextSnapshotBlock[] = [];
  const sliceStart = toInt(row.slice_start) ?? 0;
  let returnedTurns = 0;
  let oldestTurnIndex: number | null = null;

  (row.lines ?? []).forEach((line, position) => {
    // The ORIGINAL transcript-array index — not the position in this page.
    // Block ids embed it and `SemanticEvent.turnIndex` is index-identical with
    // it, so re-basing here would silently renumber every id and break deep
    // links into a turn.
    const turnIndex = sliceStart + position;
    const block = turnLineToBlock(agentSessionId, turnIndex, line);
    if (block === null) return;
    blocks.push(block);
    returnedTurns += 1;
    if (oldestTurnIndex === null) oldestTurnIndex = turnIndex;
  });

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

  const markedBlocks = applyAbandonedBlockIds(blocks, new Set(snapshotStructure.abandonedBlockIds));

  // The SQL supplies `head_line` only when the slice did not reach index 0, so
  // the in-window case arrives null here and this is a no-op (mt#4909).
  const headBlock = dispatchBriefHeadBlock(agentSessionId, row.head_line);

  const window: SessionContextSnapshotWindow = {
    // The RAW array length, which is also what the route's version token counts
    // — so the two never disagree about how long the conversation is.
    totalTurns: toInt(row.total_turns) ?? 0,
    returnedTurns,
    oldestTurnIndex,
    // Both derived from the SLICE, never from what it rendered. The slice
    // consumed raw indices [sliceStart, hi), so the next page starts below
    // sliceStart whether or not any of those entries produced a block — which
    // is what keeps a page of purely non-renderable entries from dead-ending
    // paging with `hasMore: true` and nothing to advance on (PR #3148 R1).
    nextBefore: sliceStart > 0 ? sliceStart : null,
    hasMore: sliceStart > 0,
  };

  return {
    agentSessionId,
    harness: typeof row.harness === "string" ? row.harness : "unknown",
    blocks: markedBlocks,
    ...(spawnChildrenByToolUseId ? { spawnChildrenByToolUseId } : {}),
    ...(spawnParent ? { spawnParent } : {}),
    window,
    ...(headBlock ? { headBlock } : {}),
    toolNamesByUseId: snapshotStructure.toolNamesByUseId,
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
