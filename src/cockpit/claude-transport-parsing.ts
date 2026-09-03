/**
 * Wire-format interpretation for `ClaudeStreamJsonTransport` (mt#4934) — how
 * to read the genuine `claude` binary's stream-json OUTPUT and how to build
 * its stream-json INPUT. Moved out of driven-session-host.ts verbatim (not
 * rewritten): every function here is byte-for-byte the same logic that used
 * to live inline in the supervisor, just relocated so the supervisor no
 * longer needs to know this protocol exists.
 *
 * Defensive throughout, per the mt#2750 spec Context — the upstream event
 * schema is thin and unconfirmed (anthropics/claude-code#24594 / #24596): a
 * malformed line becomes a `minsky_parse_error` payload rather than a thrown
 * exception, and field extraction returns `null` rather than throwing on an
 * unexpected shape.
 *
 * @see mt#4934 — this split
 * @see ./driver-transport.ts — the normalized types this module produces
 * @see ./claude-transport.ts — the transport that wires this in
 */

import type {
  DrivenSessionCostSummary,
  DrivenSessionModelUsage,
  DrivenSessionUsageTotals,
  DrivenInputImage,
} from "./driver-transport";

// ---------------------------------------------------------------------------
// Output: defensive stream-json line parsing
// ---------------------------------------------------------------------------

/**
 * Normalize a stream `"data"` chunk (Buffer or string, per Node stream
 * conventions) to a string. Deliberately avoids calling `chunk.toString("utf-8")`
 * with an explicit encoding argument — this project's root `@types/node` vs.
 * bun-types' bundled copy disagree on the `Buffer#toString` overload set (the
 * same ambient-typing ambiguity documented in ./auth.ts's token-encoding
 * comment), which either mis-narrows a `Buffer | string` union to zero-arg
 * `string.prototype.toString` or drops the `Buffer` global's static methods
 * entirely depending on which copy wins. `String(chunk)` sidesteps it:
 * for a real Node Buffer this invokes `.toString()` with no arguments, whose
 * documented default encoding is already `"utf8"`.
 */
export function chunkToString(chunk: unknown): string {
  return typeof chunk === "string" ? chunk : String(chunk);
}

/** Accumulates chunked stdout data and yields complete newline-delimited lines. */
export class NewlineSplitter {
  private buffer = "";

  /** Feed a chunk; returns zero or more complete (non-empty) lines. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    return parts.filter((line) => line.length > 0);
  }
}

/**
 * Parse one stdout line as a stream-json event. Defensive per the mt#2750
 * spec (the upstream event schema is thin — anthropics/claude-code#24594 /
 * #24596): a non-JSON or non-object line becomes a `minsky_parse_error`
 * event rather than throwing, so one malformed line never kills the parser
 * loop or the session.
 */
export function parseStreamJsonLine(line: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { type: "minsky_parse_error", raw: line, error: "parsed value is not a JSON object" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: "minsky_parse_error", raw: line, error: message };
  }
}

/**
 * Extract the harness session id from a `system`/`init` event. Checked
 * defensively against BOTH `session_id` (the raw CLI stream's documented
 * snake_case field) and `sessionId` (camelCase) since the upstream schema is
 * thin and unconfirmed field casing is exactly the kind of gap
 * anthropics/claude-code#24594 tracks.
 */
export function extractHarnessSessionId(payload: Record<string, unknown>): string | null {
  const raw = payload["session_id"] ?? payload["sessionId"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function isInitEvent(payload: Record<string, unknown>): boolean {
  return (
    payload["type"] === "system" &&
    payload["subtype"] === "init" &&
    extractHarnessSessionId(payload) !== null
  );
}

// ---------------------------------------------------------------------------
// Output: cost/usage extraction from the terminal `result` event (mt#2753,
// Rung 2D).
//
// Per the Claude Code headless docs (code.claude.com/docs/en/headless) and
// the Agent SDK cost-tracking guide (code.claude.com/docs/en/agent-sdk/cost-tracking),
// the terminal `result` message of EACH turn (a driven session is multi-turn —
// the transport's input format reads a continuous stream of user messages over
// stdin, so a long-lived session emits one `result` event per turn, not just
// one at process exit) carries:
//   - `total_cost_usd` (top-level, includes subagent activity)
//   - `duration_ms` / `duration_api_ms`
//   - `num_turns` (tool-round count for that turn — NOT the session's turn
//     index, which the caller tracks separately as `DrivenSessionCostSummary.turnIndex`)
//   - `usage` — `{ input_tokens, output_tokens, cache_creation_input_tokens,
//     cache_read_input_tokens }` (top-level agent loop only — undercounts
//     under subagent nesting; see `total_cost_usd`/`modelUsage` for whole-tree)
//   - `modelUsage` — map of model name to `{ inputTokens, outputTokens,
//     cacheReadInputTokens, cacheCreationInputTokens, costUSD }` (whole-tree,
//     the "model mix" the mt#2753 spec asks for)
// Extraction is defensive (same posture as parseStreamJsonLine/extractHarnessSessionId
// above) — the upstream event schema is thin (anthropics/claude-code#24594/#24596)
// and `total_cost_usd`/`costUSD` are documented as CLIENT-SIDE ESTIMATES, not
// authoritative billing data.
// ---------------------------------------------------------------------------

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractUsageTotals(raw: unknown): DrivenSessionUsageTotals | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: numOrNull(u["input_tokens"]),
    outputTokens: numOrNull(u["output_tokens"]),
    cacheCreationInputTokens: numOrNull(u["cache_creation_input_tokens"]),
    cacheReadInputTokens: numOrNull(u["cache_read_input_tokens"]),
  };
}

function extractModelUsage(raw: unknown): Record<string, DrivenSessionModelUsage> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, DrivenSessionModelUsage> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    out[model] = {
      inputTokens: numOrNull(v["inputTokens"]),
      outputTokens: numOrNull(v["outputTokens"]),
      cacheCreationInputTokens: numOrNull(v["cacheCreationInputTokens"]),
      cacheReadInputTokens: numOrNull(v["cacheReadInputTokens"]),
      // costUSD is the documented TS SDK field name; costUsd tolerated defensively.
      costUsd: numOrNull(v["costUSD"] ?? v["costUsd"]),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Parse ONE `result`-type stream-json event into a cost summary. Returns
 * `null` for a non-`result` payload (callers gate on `payload["type"] ===
 * "result"` before calling this, but the guard is repeated here so the
 * function is safe to call unconditionally).
 */
export function extractResultSummary(
  payload: Record<string, unknown>,
  turnIndex: number
): DrivenSessionCostSummary | null {
  if (payload["type"] !== "result") return null;
  return {
    turnIndex,
    subtype: typeof payload["subtype"] === "string" ? payload["subtype"] : null,
    isError: payload["is_error"] === true || payload["subtype"] === "error",
    totalCostUsd: numOrNull(payload["total_cost_usd"]),
    durationMs: numOrNull(payload["duration_ms"]),
    durationApiMs: numOrNull(payload["duration_api_ms"]),
    numTurns: numOrNull(payload["num_turns"]),
    usage: extractUsageTotals(payload["usage"]),
    modelUsage: extractModelUsage(payload["modelUsage"]),
    observedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Input: building the stream-json user-turn payload
// ---------------------------------------------------------------------------

/**
 * Assemble the content-block array for one input turn (mt#3235).
 *
 * Text is omitted when blank rather than sent as an empty block: the Messages
 * API rejects an empty text block, so a caption-less image would otherwise fail
 * the whole turn. An empty result means there is genuinely nothing to send, and
 * the caller reports that as a failed delivery rather than writing a
 * content-less message the child cannot answer.
 */
export function buildInputContent(
  text: string,
  images: readonly DrivenInputImage[]
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (text.trim().length > 0) {
    content.push({ type: "text", text });
  }
  for (const image of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.base64 },
    });
  }
  return content;
}
