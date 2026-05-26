/**
 * Shared attachment-row construction for `agent_transcript_attachments` writes.
 *
 * Used by:
 * - `agent-transcript-ingest-service.ts` — incremental ingest as new lines stream in
 * - `scripts/backfill-agent-transcript-attachments.ts` — one-time backfill for sessions
 *   already ingested before mt#2022 shipped
 *
 * Centralizing the logic prevents drift between the two paths (e.g., future
 * hook-attribution changes or field-normalization tweaks would otherwise need
 * to land twice). Extracted from the ingest service per PR #1229 reviewer
 * feedback.
 *
 * @see mt#2022 — substrate extension
 */

import { extractAttachmentContentString, matchHookScript } from "./hook-preamble-matcher";

/**
 * Shape of a single `agent_transcript_attachments` row before insert.
 * Mirrors the schema in `agent-transcript-attachments-schema.ts`.
 */
export interface AttachmentRow {
  agentSessionId: string;
  lineIndex: number;
  rawJsonlType: string;
  attachmentType: string;
  hookEvent: string | null;
  hookName: string | null;
  parentUuid: string | null;
  content: unknown;
  timestamp: Date | null;
}

/**
 * Build an attachment-row from a raw JSONL line. Returns `null` when the line
 * doesn't fit the attachment/system shape we expect (defensive — malformed
 * lines are skipped rather than crashing the ingest).
 *
 * Routing semantics:
 * - `attachment` lines: read `attachment.type` for `attachmentType`. For
 *   `hook_additional_context`, lift `hookEvent` (the JSONL field `attachment.hookName`
 *   — misnamed in the harness; it's the event class, not the script) and run the
 *   preamble matcher against `attachment.content` to populate the script `hookName` column.
 * - `system` lines: read `subtype` for `attachmentType`.
 *
 * @param line - The raw JSONL line (as a plain object).
 * @returns The constructed row, or `null` if the line shape is unrecognized.
 */
export function buildAttachmentRow(
  agentSessionId: string,
  lineIndex: number,
  line: unknown,
  timestamp: Date | null
): AttachmentRow | null {
  if (line === null || typeof line !== "object") return null;
  const l = line as Record<string, unknown>;

  const rawJsonlType = typeof l.type === "string" ? l.type : "";
  if (rawJsonlType !== "attachment" && rawJsonlType !== "system") return null;

  let attachmentType = "";
  let hookEvent: string | null = null;
  let hookName: string | null = null;

  if (rawJsonlType === "attachment") {
    const att = l.attachment;
    if (att && typeof att === "object") {
      const inner = att as Record<string, unknown>;
      if (typeof inner.type === "string") attachmentType = inner.type;
      // hook_additional_context attachments carry the hook EVENT in `hookName`
      // (despite the field name). Disambiguate the specific script via the
      // preamble matcher.
      if (attachmentType === "hook_additional_context") {
        const evt = inner.hookEvent ?? inner.hookName;
        if (typeof evt === "string") hookEvent = evt;
        const contentStr = extractAttachmentContentString(inner.content);
        if (hookEvent !== null) {
          hookName = matchHookScript(hookEvent, contentStr);
        }
      }
    }
  } else {
    // system line
    const subtype = l.subtype;
    if (typeof subtype === "string") attachmentType = subtype;
  }

  if (!attachmentType) {
    // Unrecognized shape — skip rather than write a row with a NOT-NULL violation.
    return null;
  }

  const parentUuid = l.parentUuid;

  return {
    agentSessionId,
    lineIndex,
    rawJsonlType,
    attachmentType,
    hookEvent,
    hookName,
    parentUuid: typeof parentUuid === "string" ? parentUuid : null,
    content: line,
    timestamp,
  };
}
