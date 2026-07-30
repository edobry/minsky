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

import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptAttachmentsTable } from "../storage/schemas/agent-transcript-attachments-schema";
import type { AgentSessionId } from "./transcript-source";
import { markAbandonedRewindBranches } from "./rewind-detection";
import type {
  ContextElement,
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
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
  agentSessionId: AgentSessionId
): Promise<SessionContextSnapshot | null> {
  // 1. Fetch the parent transcripts row (provides turn jsonb + harness).
  const transcriptRows = await db
    .select({
      harness: agentTranscriptsTable.harness,
      transcript: agentTranscriptsTable.transcript,
    })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
    .limit(1);

  const parentRow = transcriptRows[0];
  if (!parentRow) return null;

  const { harness, transcript } = parentRow;
  const turnArray = Array.isArray(transcript) ? transcript : [];

  // 2. Fetch the attachment rows, ordered by line_index (stable per JSONL).
  const attachmentRows = await db
    .select()
    .from(agentTranscriptAttachmentsTable)
    .where(eq(agentTranscriptAttachmentsTable.agentSessionId, agentSessionId))
    .orderBy(asc(agentTranscriptAttachmentsTable.lineIndex));

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

  return {
    agentSessionId,
    harness: typeof harness === "string" ? harness : "unknown",
    blocks: markedBlocks,
    assembledAt: new Date().toISOString(),
  };
}
