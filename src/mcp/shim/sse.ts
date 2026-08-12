/**
 * Spec-correct `text/event-stream` (SSE) event-data extraction for
 * `minsky mcp shim` (mt#3812).
 *
 * The mt#3884 Rust spike's SSE handling was flagged as known-unsafe in this
 * task's spec BLOCKING section: it joins a single event's multiple `data:`
 * physical lines with `\n` — correct per the WHATWG event-stream parsing
 * algorithm — but then writes that (possibly multi-line) joined buffer
 * straight to stdout as if it were one line. If a daemon ever legitimately
 * splits one JSON-RPC message's payload across multiple `data:` lines, the
 * embedded `\n` corrupts stdio's one-JSON-RPC-message-per-line framing: the
 * client's line reader would see the tail of that buffer as a second,
 * truncated "line".
 *
 * This module only extracts and reconstructs each event's raw `data`
 * buffer (spec-correct join, still may contain embedded `\n` for a
 * legitimately multi-line event). The caller (client.ts) is responsible
 * for JSON.parse-ing each buffer and re-serializing with JSON.stringify
 * before writing to stdout — canonical single-line JSON output regardless
 * of how the daemon chose to frame it on the wire. That parse-then-
 * reserialize step is what the spike skipped and what makes this safe.
 *
 * Scope: parses ONE already-complete HTTP response body. The shim never
 * opens a GET/SSE server-push stream (matching the mt#3884 spike's
 * documented scope — Claude Code's stdio client never asks for one; that's
 * an HTTP-transport-only concept the shim absorbs by proxying only POST
 * request/response cycles).
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 */

/**
 * Extract the reconstructed `data` buffer for every event in an SSE
 * response body that carried at least one `data:` field. Events with no
 * `data:` field (e.g. a bare `event:`/`id:`-only keepalive) are skipped —
 * MCP's Streamable-HTTP transport never emits those, but skipping rather
 * than erroring keeps this parser permissive of anything upstream of the
 * MCP layer (proxies, load balancers) that might inject one.
 */
export function parseSseEventData(body: string): string[] {
  // Normalize line endings per the spec's line-splitting rule (a line ends
  // at \r\n, \r, or \n — treat all three uniformly).
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Events are separated by a blank line (two consecutive line terminators).
  const eventBlocks = normalized.split("\n\n");

  const results: string[] = [];
  for (const block of eventBlocks) {
    if (!block.trim()) continue;

    const dataLines: string[] = [];
    for (const rawLine of block.split("\n")) {
      if (!rawLine.startsWith("data:")) {
        // Other SSE field types (event:, id:, retry:) are not needed for
        // the shim's JSON-RPC-over-SSE use case — the MCP SDK's
        // StreamableHTTPServerTransport only ever writes `data:` fields for
        // JSON-RPC payloads — so they're intentionally ignored rather than
        // parsed.
        continue;
      }
      let value = rawLine.slice("data:".length);
      // Per spec: strip exactly ONE leading space after the colon, if
      // present — not all leading whitespace.
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
    }

    if (dataLines.length === 0) continue;
    // Per spec: join with "\n" (the buffer accumulates "<line>\n" per data
    // field, then the trailing \n is dropped) — equivalent to Array#join.
    results.push(dataLines.join("\n"));
  }
  return results;
}
