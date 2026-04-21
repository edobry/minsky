/**
 * Transcript Service
 *
 * Ingests Claude Code JSONL session transcripts into the database and provides
 * message statistics for authorship tier judging. Only `user` and `assistant`
 * messages are retained; metadata types are filtered out.
 *
 * @see mt#968 — Phase 4a: transcript DB schema and ingestion pipeline
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { promises as fs } from "fs";

import { sessionTranscriptsTable } from "../storage/schemas/transcript-schema";
import { provenanceTable } from "../storage/schemas/provenance-schema";
import { log } from "../../utils/logger";

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

/** A filtered transcript message stored in the database. */
export interface TranscriptMessage {
  type: "user" | "assistant";
  role: string;
  content: unknown;
  timestamp?: string;
  uuid?: string;
  model?: string;
}

/** Statistics computed from a stored transcript. */
export interface MessageStats {
  humanMessages: number;
  assistantMessages: number;
  totalMessages: number;
  corrections: number;
}

/** Extracts the text content from a message's content field (string or array). */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: { type?: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text ?? "")
      .join(" ");
  }
  return "";
}

/** Counts correction signals in a sequence of messages. */
function countCorrections(messages: TranscriptMessage[]): number {
  let corrections = 0;
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i] as TranscriptMessage;
    const prev = messages[i - 1] as TranscriptMessage;
    // A user message after an assistant message that contains correction signals
    if (msg.type === "user" && prev.type === "assistant") {
      const text = extractTextContent(msg.content);
      if (CORRECTION_PATTERNS.some((pattern) => pattern.test(text))) {
        corrections++;
      }
    }
  }
  return corrections;
}

// eslint-disable-next-line custom/require-injectable -- Not yet registered in DI container; will be wired in Phase 4b
export class TranscriptService {
  constructor(private readonly db: PostgresJsDatabase) {}

  /**
   * Ingest a Claude Code JSONL transcript file into the database.
   * Filters to only user/assistant messages and stores essential fields.
   */
  async ingestTranscript(sessionId: string, jsonlPath: string): Promise<MessageStats> {
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
        };
      });

    const humanMessages = messages.filter((m) => m.type === "user").length;
    const assistantMessages = messages.filter((m) => m.type === "assistant").length;
    const corrections = countCorrections(messages);

    // Upsert into DB
    const existing = await this.db
      .select()
      .from(sessionTranscriptsTable)
      .where(eq(sessionTranscriptsTable.sessionId, sessionId))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(sessionTranscriptsTable)
        .set({
          transcript: messages,
          messageCount: messages.length,
          humanMessageCount: humanMessages,
          assistantMessageCount: assistantMessages,
          ingestedAt: new Date(),
        })
        .where(eq(sessionTranscriptsTable.sessionId, sessionId));
    } else {
      await this.db.insert(sessionTranscriptsTable).values({
        sessionId,
        transcript: messages,
        messageCount: messages.length,
        humanMessageCount: humanMessages,
        assistantMessageCount: assistantMessages,
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
  async getTranscript(sessionId: string): Promise<TranscriptMessage[] | null> {
    const rows = await this.db
      .select()
      .from(sessionTranscriptsTable)
      .where(eq(sessionTranscriptsTable.sessionId, sessionId))
      .limit(1);

    const row = rows[0];
    return row ? (row.transcript as TranscriptMessage[]) : null;
  }

  /** Compute message statistics from a stored transcript. */
  async computeMessageStats(sessionId: string): Promise<MessageStats | null> {
    const messages = await this.getTranscript(sessionId);
    if (!messages) return null;

    const humanMessages = messages.filter((m) => m.type === "user").length;
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
