/**
 * Bounds a tool response's TEXT before it is embedded in the MCP `content`
 * block the `CallToolRequestSchema` handler returns (mt#4749).
 *
 * ## Why here, and not only at the shim
 *
 * `src/mcp/server.ts`'s tools/call handler is the SINGLE point both
 * transports funnel through: the stdio-direct `mcp start` process serves
 * requests straight off this handler, and the ADR-038 shared daemon runs the
 * SAME handler behind an HTTP transport before forwarding its response to
 * `minsky mcp shim` for the final stdio hop back to the harness (see
 * `src/mcp/shim/response-bound.ts` for that SECOND, independent backstop on
 * the shim leg). Bounding the response text here, at construction time,
 * catches an oversized result regardless of which transport carries it
 * onward — including the direct-stdio path the shim never sees at all.
 *
 * ## The incident this closes
 *
 * Observed live: a `forge_ci_run_view_log` call returned a ~12 MB /
 * ~11.97M-character result for a CI failure whose diagnostic content was
 * ~200 bytes; a second oversized fetch killed the MCP connection outright.
 * `forge_ci_run_view_log`'s OWN payload is now bounded at the domain layer
 * (`boundLogPayload` in
 * `packages/domain/src/repository/github-workflow-runs.ts`) — this module is
 * the transport-level backstop for every OTHER tool whose own bound is
 * missing, wrong, or not yet applied.
 *
 * Kept to a bounded response TEXT, not an error, deliberately: the tool call
 * itself still SUCCEEDED (the underlying operation worked; only its output
 * was too large to forward whole), so the caller gets `success` semantics
 * with a pointer to the full content, rather than reading a genuinely
 * successful call as a tool failure.
 */

import fs from "node:fs";
import path from "node:path";
import { getMinskyStateDir } from "@minsky/shared/paths";
import { safeTruncate } from "@minsky/shared/safe-truncate";

/**
 * Maximum size, in UTF-8 bytes, of a tool response's text this module will
 * embed in the MCP `content` block inline (mt#4749).
 *
 * Sized well under both the incident's own payload (~12 MB) and the shim's
 * independent `MAX_STDOUT_FRAME_BYTES` (5 MB, `src/mcp/shim/response-bound.ts`)
 * — this is the FIRST checkpoint a response passes through, so keeping its
 * cap tighter than the shim's leaves headroom for the small amount of
 * additional JSON-RPC/content-block framing added downstream without
 * re-tripping the shim's own bound on an already-bounded payload.
 */
export const MAX_TOOL_RESPONSE_TEXT_BYTES = 2 * 1024 * 1024;

/** Subdirectory of the Minsky state dir an oversized tool response is spooled to. */
const SPOOL_SUBDIR = "mcp-oversized-tool-responses";

export interface ResponseSizeGuardDeps {
  /** Injected for tests — defaults to the real `fs.mkdirSync`. */
  mkdirSync?: typeof fs.mkdirSync;
  /** Injected for tests — defaults to the real `fs.writeFileSync`. */
  writeFileSync?: typeof fs.writeFileSync;
  /** Injected for tests — defaults to `getMinskyStateDir()`. */
  stateDir?: string;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Write `text` to a file under `<stateDir>/mcp-oversized-tool-responses/` and
 * return its path. The filename carries the tool name (sanitized), a
 * timestamp, and a random suffix so two oversized responses from the same
 * tool in the same millisecond never collide.
 */
function spoolResponseText(text: string, toolName: string, deps: ResponseSizeGuardDeps): string {
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync;
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync;
  const dir = path.join(deps.stateDir ?? getMinskyStateDir(), SPOOL_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]+/g, "-") || "tool";
  const suffix = Math.random().toString(36).slice(2, 8);
  const filePath = path.join(dir, `${safeName}-${Date.now()}-${suffix}.txt`);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

/**
 * Return `text` unchanged if it fits within `MAX_TOOL_RESPONSE_TEXT_BYTES`;
 * otherwise spool the full text to a file and return a bounded replacement
 * naming the tool, the size, and the spooled path.
 *
 * Called once per `tools/call` response, immediately after `responseText` is
 * built and before it is embedded in the returned `content` block — see
 * `server.ts`'s `CallToolRequestSchema` handler.
 */
export function boundToolResponseText(
  text: string,
  toolName: string,
  deps: ResponseSizeGuardDeps = {}
): string {
  const byteLength = utf8ByteLength(text);
  if (byteLength <= MAX_TOOL_RESPONSE_TEXT_BYTES) return text;

  const spooledPath = spoolResponseText(text, toolName, deps);
  const preview = safeTruncate(text, 2000, "head");
  return (
    `[TRUNCATED: the "${toolName}" tool's response is ${byteLength} bytes, exceeding the ` +
    `${MAX_TOOL_RESPONSE_TEXT_BYTES}-byte MCP response-safety limit (mt#4749). The tool call ` +
    `itself succeeded — only the output was too large to return inline. ` +
    `Full response spooled to: ${spooledPath}\n\n` +
    `--- preview (first 2000 bytes) ---\n${preview}`
  );
}
