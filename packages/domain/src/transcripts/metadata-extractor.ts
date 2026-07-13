/**
 * MetadataExtractor — pure functions for extracting task IDs and PR numbers
 * from transcript text content.
 *
 * Runs as a post-ingest pass over agent_transcripts rows: reads each row's
 * transcript JSONB, extracts references, and UPDATEs related_task_ids and
 * related_pr_numbers columns.
 *
 * @see mt#1329 — this file
 * @see mt#1313 — Transcript search: harness-agnostic ingestion
 */

import type { RawTurnLine } from "./transcript-source";

// ── Patterns ──────────────────────────────────────────────────────────────────

/**
 * Matches task IDs in the format `mt#<digits>`.
 * Examples: mt#1313, mt#42
 */
const TASK_ID_PATTERN = /mt#\d+/g;

/**
 * Matches standalone PR/issue numbers in the format `#<digits>`.
 * Negative lookbehind `(?<!mt)` prevents matching the `#<digits>` portion of
 * task IDs like `mt#1313`. Word boundary `\b` at the end prevents partial matches.
 * Leading context `(?:^|[\s([{])` ensures the `#` is not part of a word.
 *
 * Examples matched: `#763`, ` #42`, `(#100)`
 * Examples not matched: `mt#1313`, `foo#bar`, `a#1`
 */
const PR_NUMBER_PATTERN = /(?:^|[\s([{])(?<!mt)#(\d+)\b/gm;

// ── Extraction functions ───────────────────────────────────────────────────────

/**
 * Extract all task IDs (format: `mt#<digits>`) from a text string.
 * Returns a deduplicated, sorted array of task ID strings.
 */
export function extractTaskIds(text: string): string[] {
  const matches = text.match(TASK_ID_PATTERN) ?? [];
  const unique = [...new Set(matches)];
  return unique.sort();
}

/**
 * Extract all PR/issue numbers (format: `#<digits>`, not preceded by `mt`)
 * from a text string.
 * Returns a deduplicated, numerically sorted array of PR numbers.
 */
export function extractPrNumbers(text: string): number[] {
  const numbers: number[] = [];
  PR_NUMBER_PATTERN.lastIndex = 0; // Reset regex state for reuse
  let match: RegExpExecArray | null;
  while ((match = PR_NUMBER_PATTERN.exec(text)) !== null) {
    const num = parseInt(match[1] ?? "0", 10);
    if (!isNaN(num) && num > 0) {
      numbers.push(num);
    }
  }
  const unique = [...new Set(numbers)];
  return unique.sort((a, b) => a - b);
}

// ── TranscriptLine type (subset used for extraction) ──────────────────────────

/**
 * Minimal turn representation for metadata extraction.
 * Compatible with ExtractedTurn and RawTurnLine.
 */
export interface TranscriptLine {
  userText?: string | null;
  assistantText?: string | null;
}

/**
 * Metadata extracted from a transcript.
 */
export interface ExtractedMetadata {
  task_ids: string[];
  pr_numbers: number[];
}

/**
 * Extract task IDs and PR numbers from an array of transcript turns.
 *
 * Concatenates all userText and assistantText fields from every turn,
 * runs the regex extractors over the combined text, and returns
 * deduplicated + sorted results.
 *
 * Also accepts RawTurnLine arrays by reading the raw content fields.
 * Casting to `Array<Record<string, unknown>>` avoids union-type narrowing issues
 * while preserving the intent of handling both typed and raw turns.
 */
export function extractMetadata(transcript: TranscriptLine[] | RawTurnLine[]): ExtractedMetadata {
  // Collect all text content from the transcript.
  const textParts: string[] = [];

  for (const turn of transcript as Array<Record<string, unknown>>) {
    const userText = turn["userText"];
    if (typeof userText === "string" && userText.length > 0) {
      textParts.push(userText);
    } else if ("message" in turn && turn["message"]) {
      // RawTurnLine — extract text from message content
      const msg = turn["message"] as Record<string, unknown>;
      const content = msg["content"];
      if (typeof content === "string") {
        textParts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as Record<string, unknown>)["type"] === "text" &&
            typeof (block as Record<string, unknown>)["text"] === "string"
          ) {
            textParts.push((block as Record<string, unknown>)["text"] as string);
          }
        }
      }
    }

    const assistantText = turn["assistantText"];
    if (typeof assistantText === "string" && assistantText.length > 0) {
      textParts.push(assistantText);
    }
  }

  const combinedText = textParts.join("\n");

  return {
    task_ids: extractTaskIds(combinedText),
    pr_numbers: extractPrNumbers(combinedText),
  };
}

/**
 * Extract metadata from a raw JSONB transcript array as stored in the DB.
 * The JSONB content is an array of RawTurnLine objects.
 */
export function extractMetadataFromJsonb(transcript: unknown): ExtractedMetadata {
  if (!Array.isArray(transcript)) {
    return { task_ids: [], pr_numbers: [] };
  }
  return extractMetadata(transcript as RawTurnLine[]);
}
