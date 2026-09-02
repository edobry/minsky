/**
 * The shared `projection` parameter for `transcripts.search` and
 * `transcripts.search-text` (mt#4917).
 *
 * Declared once, like `conversationIdParam`, so the two search tools cannot
 * drift on the default or on how it is described — a caller reading one tool's
 * description and applying it to the other must not be surprised.
 *
 * @see packages/domain/src/transcripts/transcript-search-projection.ts — the projection itself
 */

import { z } from "zod";
import { DEFAULT_TRANSCRIPT_SEARCH_PROJECTION } from "@minsky/domain/transcripts/transcript-search-projection";

/**
 * Build the `projection` parameter definition.
 *
 * The description states the default explicitly and points at the escape hatch
 * for reading a hit in full, because the whole point of defaulting to `snippet`
 * is that a caller who needs the body has to know where to get it.
 */
export function projectionParam() {
  return {
    schema: z.enum(["snippet", "full"]),
    description:
      "How much of each matching turn to return. 'snippet' (the DEFAULT) returns the bounded " +
      "excerpt plus the turn's coordinates (agentSessionId, turnIndex, role, timestamps, score) " +
      "and OMITS the full userText/assistantText, reporting how many characters it dropped as " +
      "`omittedTextChars`. 'full' additionally returns the complete turn text. Prefer the " +
      "default: a transcript turn can run to hundreds of kilobytes, so a full-projection search " +
      "of ~10 hits routinely exceeds the MCP response limit and spools to disk. To read one hit " +
      "in full, call transcripts_get passing the hit's `agentSessionId` as its `conversationId` " +
      "(the two name the same harness conversation — the result field and the parameter simply " +
      "differ per ADR-022), with `turnRange` set to the hit's `turnIndex`.",
    required: false,
    defaultValue: DEFAULT_TRANSCRIPT_SEARCH_PROJECTION,
  };
}

/**
 * The sentence appended to each search tool's own description.
 *
 * Separate from the parameter description because MCP clients surface the two
 * differently — some list only the tool description — and the default is the
 * one fact a caller cannot afford to miss either way.
 */
export const PROJECTION_TOOL_DESCRIPTION_SUFFIX =
  "By default each hit returns its `snippet` and coordinates WITHOUT the full turn text " +
  '(`projection: "full"` restores it); to read one hit in full, pass its `agentSessionId` to ' +
  "transcripts_get as `conversationId`, with `turnRange` set to its `turnIndex`. ";
