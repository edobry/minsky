/**
 * Agent Transcript Service
 *
 * Ingests Claude Code JSONL session transcripts into the database and provides
 * message statistics for authorship tier judging. Only `user` and `assistant`
 * messages are retained; metadata types are filtered out.
 *
 * ID SPACE (mt#3066): every `sessionId` parameter here is an `AgentSessionId`
 * (= `ConversationId`, the harness conversation UUID keying
 * `agent_transcripts.agent_session_id`) — NOT a Minsky workspace session id.
 * These were plain `string` with internal `as AgentSessionId` casts, and that
 * cast is what let three call sites pass a workspace id and silently get
 * `null` back. Measured 2026-07-23: all 1,756 rows carry `harness =
 * 'claude_code'` and zero carry the transitional `'legacy'` harness below, so
 * the workspace-id-as-agent-session-id keying the mt#1324 note describes is
 * not present in the data.
 *
 * @see mt#968 — Phase 4a: transcript DB schema and ingestion pipeline
 * @see mt#1324 — Foundation schema migration + TranscriptService rename
 * @see mt#1325 — Harness-agnostic ingestion (fixes agent_session_id keying)
 * @see mt#3066 — typed this seam; @see mt#3101 — the remaining wrong-space callers
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { extractTextFromContent, resolveTranscriptMessageContent } from "./transcript-content";
import { promises as fs } from "fs";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import type { AgentSessionId } from "../transcripts/transcript-source";
import { isOperatorAuthored } from "../transcripts/user-line-origin";
import { provenanceTable } from "../storage/schemas/provenance-schema";
import { log } from "@minsky/shared/logger";

/** Message types retained from Claude Code JSONL transcripts. */
const RETAINED_TYPES = new Set(["user", "assistant"]);

/** Signals in user messages that indicate a correction/redirection. */
const CORRECTION_PATTERNS = [
  /\bno[,.]?\s/i,
  /\bwrong\b/i,
  /\binstead\b/i,
  /\bactually\b/i,
  /\bdon'?t\b/i,
  /\bstop\b/i,
  /\bnot that\b/i,
  /\bshouldn'?t\b/i,
  /\bfix\b/i,
  /\brevert\b/i,
];

/**
 * A transcript message as stored in the database.
 *
 * TWO shapes reach this type, and the difference is load-bearing (mt#4196):
 *
 * - **Raw harness JSONL** — what the live ingest path writes, and the only shape with rows
 *   in prod. The text is nested at `message.content`; there is NO top-level `content` key.
 * - **Pre-extracted (legacy)** — what the transitional `ingestTranscript` below writes,
 *   with `content` flattened onto the message. Zero live rows carry it.
 *
 * Both fields are declared so neither read is undeclared, and so a reader is confronted
 * with the choice rather than defaulting into the one that happens to be wrong. **Do not
 * read either field directly** — call `resolveTranscriptMessageContent` (or
 * `resolveMessageText`) from `./transcript-content`, which tries nested first and falls
 * back to flat. Reading `.content` alone is what left three consumers blind for months.
 */
export interface TranscriptMessage {
  type: "user" | "assistant";
  role: string;
  /**
   * The pre-extracted (legacy) content payload. `undefined` on every live row — prefer
   * `resolveTranscriptMessageContent`, which handles both shapes.
   */
  content: unknown;
  /**
   * The raw harness line's nested payload — where the text actually lives on stored rows.
   * Optional because the legacy shape omits it, not because it is rare: it is the common case.
   */
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  timestamp?: string;
  uuid?: string;
  model?: string;
  /**
   * Harness provenance markers, carried verbatim from the stored line (mt#4289).
   *
   * Declared for the same reason `message` is: they ARE on every live row —
   * `getTranscript` casts the stored JSONB straight to this type — and omitting
   * them from the declaration is what made a machine-written compact summary
   * indistinguishable from operator speech at every reader of this interface.
   * Do not branch on them directly; call `isOperatorAuthored` from
   * `../transcripts/user-line-origin`, which knows their precedence.
   */
  isCompactSummary?: boolean;
  isMeta?: boolean;
  origin?: { kind?: string };
  promptSource?: string;
}

/**
 * True iff this message is the OPERATOR speaking, rather than a `user`-role
 * line Claude Code generated (mt#4289).
 *
 * Both counts below used a bare `type === "user"` test, which reads a compact
 * summary, an injected skill body, and a background-task notification as things
 * the human said. `countCorrections` was the sharper case: a compact summary
 * NARRATES the corrections in the conversation it summarizes, so it matches
 * `CORRECTION_PATTERNS` almost by construction and inflated the count with the
 * conversation's own history.
 */
function isOperatorMessage(msg: TranscriptMessage): boolean {
  return msg.type === "user" && isOperatorAuthored(msg);
}

/** Statistics computed from a stored transcript. */
export interface MessageStats {
  humanMessages: number;
  assistantMessages: number;
  totalMessages: number;
  corrections: number;
}

/**
 * Extracts the text content from an already-resolved content payload (string or array).
 *
 * Delegates to the shared extractor (mt#4196) rather than keeping a fourth copy of the
 * same string-or-blocks logic. Behavior is unchanged: `""` for an unextractable payload,
 * where the shared function returns `null`.
 *
 * It extracts from whatever payload it is HANDED — resolving WHICH payload is the caller's
 * job, and `countCorrections` below now does that through `resolveTranscriptMessageContent`
 * (mt#4225). Until then it handed over `msg.content`, the flat field absent from every live
 * row, so `computeMessageStats` reported 0 corrections for any stored transcript.
 */
function extractTextContent(content: unknown): string {
  return extractTextFromContent(content) ?? "";
}

/**
 * Counts correction signals in a sequence of messages.
 *
 * Serves BOTH shapes deliberately (mt#4225): `ingestTranscript` passes freshly-parsed lines
 * carrying flat `content`, while `computeMessageStats` passes stored rows carrying nested
 * `message.content`. The resolver tries nested first and falls back to flat, so the ingest
 * path is unchanged and the stored path stops reading a field that is never there.
 */
function countCorrections(messages: TranscriptMessage[]): number {
  let corrections = 0;
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i] as TranscriptMessage;
    const prev = messages[i - 1] as TranscriptMessage;
    // An OPERATOR message after an assistant message that contains correction
    // signals (mt#4289 narrowed this from any `user`-role line).
    if (isOperatorMessage(msg) && prev.type === "assistant") {
      const text = extractTextContent(resolveTranscriptMessageContent(msg));
      if (CORRECTION_PATTERNS.some((pattern) => pattern.test(text))) {
        corrections++;
      }
    }
  }
  return corrections;
}

export class AgentTranscriptService {
  constructor(private readonly db: PostgresJsDatabase) {}

  /**
   * Ingest a Claude Code JSONL transcript file into the database.
   * Filters to only user/assistant messages and stores essential fields.
   *
   * Transitional: writes `harness='legacy'`. No row in the live table carries
   * that harness (measured 2026-07-23), and the only caller is
   * `scripts/test-provenance-e2e.ts`.
   */
  async ingestTranscript(sessionId: AgentSessionId, jsonlPath: string): Promise<MessageStats> {
    const raw = String(await fs.readFile(jsonlPath, "utf-8"));
    const lines = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    // Filter and extract essential fields
    const messages: TranscriptMessage[] = lines
      .filter((line) => RETAINED_TYPES.has(line.type as string))
      .map((line) => {
        const msg = line.message as Record<string, unknown> | undefined;
        return {
          type: line.type as "user" | "assistant",
          role: (msg?.role as string) ?? (line.type as string),
          content: msg?.content ?? null,
          timestamp: line.timestamp as string | undefined,
          uuid: line.uuid as string | undefined,
          model: (msg?.model as string) ?? undefined,
          // mt#4289: carry the provenance markers through the projection. This
          // path DROPS every field it does not name, so without these the two
          // stat paths would disagree — `computeMessageStats` (reading stored
          // raw lines) would exclude synthetic lines while this one, three
          // lines below, counted them as human.
          isCompactSummary: line.isCompactSummary as boolean | undefined,
          isMeta: line.isMeta as boolean | undefined,
          origin: line.origin as { kind?: string } | undefined,
          promptSource: line.promptSource as string | undefined,
        };
      });

    const humanMessages = messages.filter(isOperatorMessage).length;
    const assistantMessages = messages.filter((m) => m.type === "assistant").length;
    const corrections = countCorrections(messages);

    // Upsert into agent_transcripts using the Minsky session ID as agent_session_id.
    // harness='legacy' signals that this row was ingested via the transitional path.
    const existing = await this.db
      .select()
      .from(agentTranscriptsTable)
      .where(eq(agentTranscriptsTable.agentSessionId, sessionId))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(agentTranscriptsTable)
        .set({
          transcript: messages,
          ingestedAt: new Date(),
        })
        .where(eq(agentTranscriptsTable.agentSessionId, sessionId));
    } else {
      await this.db.insert(agentTranscriptsTable).values({
        agentSessionId: sessionId,
        harness: "legacy",
        transcript: messages,
      });
    }

    log.debug(`Ingested transcript for session ${sessionId}`, {
      totalMessages: messages.length,
      humanMessages,
      assistantMessages,
      corrections,
    });

    return { humanMessages, assistantMessages, totalMessages: messages.length, corrections };
  }

  /** Retrieve the stored transcript for a session. */
  async getTranscript(sessionId: AgentSessionId): Promise<TranscriptMessage[] | null> {
    const rows = await this.db
      .select()
      .from(agentTranscriptsTable)
      .where(eq(agentTranscriptsTable.agentSessionId, sessionId))
      .limit(1);

    const row = rows[0];
    return row ? (row.transcript as TranscriptMessage[]) : null;
  }

  /** Compute message statistics from a stored transcript. */
  async computeMessageStats(sessionId: AgentSessionId): Promise<MessageStats | null> {
    const messages = await this.getTranscript(sessionId);
    if (!messages) return null;

    const humanMessages = messages.filter(isOperatorMessage).length;
    const assistantMessages = messages.filter((m) => m.type === "assistant").length;
    const corrections = countCorrections(messages);

    return {
      humanMessages,
      assistantMessages,
      totalMessages: messages.length,
      corrections,
    };
  }

  /** Link a transcript to its provenance record by updating transcript_id. */
  async linkToProvenance(sessionId: string): Promise<boolean> {
    const result = await this.db
      .update(provenanceTable)
      .set({ transcriptId: sessionId, updatedAt: new Date() })
      .where(eq(provenanceTable.sessionId, sessionId));

    const updated = (result as { rowCount?: number }).rowCount ?? 0;
    if (updated > 0) {
      log.debug(`Linked transcript to ${updated} provenance record(s) for session ${sessionId}`);
    }
    return updated > 0;
  }
}
