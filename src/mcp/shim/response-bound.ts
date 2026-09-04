/**
 * Bounds an oversized JSON-RPC response before the shim writes it to stdout
 * (mt#4749).
 *
 * ## The incident this closes
 *
 * The daemon can return a response whose serialized size runs into the tens
 * of megabytes — observed live: a ~12 MB / ~11.97M-character
 * `forge_ci_run_view_log` result for a CI failure whose diagnostic content
 * was ~200 bytes. Writing that directly to `process.stdout` — the JSON-RPC
 * channel back to the harness (Claude Code) — killed the connection
 * outright, twice, once per configured server alias, after which the harness
 * marked BOTH aliases disconnected and every MCP-dependent step in flight
 * (session_commit, session_pr_merge, tasks_create) was blocked until
 * reconnect.
 *
 * `boundOversizedResponse` is the last checkpoint before that write: any
 * response whose serialized size exceeds `MAX_STDOUT_FRAME_BYTES` is spooled
 * to a file and replaced with a JSON-RPC ERROR frame naming the size and the
 * spooled path, so the connection survives and the caller gets an actionable
 * pointer instead of a dead transport or a silently truncated stream.
 *
 * ## This is a backstop, not the fix for any one tool
 *
 * The primary fix for `forge_ci_run_view_log` specifically is bounding ITS
 * OWN payload — see `boundLogPayload` in
 * `packages/domain/src/repository/github-workflow-runs.ts`, which spools and
 * truncates at the domain layer before the result is even handed to the MCP
 * response serializer. This module exists because a domain-level bound can
 * be missing, wrong, or simply not yet applied to some OTHER tool — the
 * transport itself should never be able to die regardless of which tool
 * produced the oversized result. AT2 (mt#4749): "a deliberately oversized
 * tool response produces a structured error or spooled-file pointer, and the
 * next tool call on the same connection succeeds" is verified against THIS
 * module, independent of any one tool's own bound.
 *
 * Deliberately minimal imports (`node:fs`, `node:path`,
 * `@minsky/shared/paths`) — no DI container, no CLI, no shared command
 * registry — matching the constraint `main.ts`'s own docblock states for the
 * rest of this module family (see that file's header for why).
 */

import fs from "node:fs";
import path from "node:path";
import { getMinskyStateDir } from "@minsky/shared/paths";
import { makeErrorResponse, type JsonRpcMessage } from "./protocol";

/**
 * Maximum size, in UTF-8 bytes, of a JSON-RPC frame this module will write to
 * stdout inline (mt#4749).
 *
 * Sized two orders of magnitude below the incident's own payload (~12 MB), so
 * this is a real backstop rather than a bound the incident itself would have
 * cleared. 5 MB is generous for any ordinary tool result — well above what a
 * domain-level bound like `boundLogPayload`'s 1 MB cap should ever let
 * through — while remaining far short of the size that killed the connection.
 */
export const MAX_STDOUT_FRAME_BYTES = 5 * 1024 * 1024;

/** Subdirectory of the Minsky state dir an oversized response is spooled to. */
const SPOOL_SUBDIR = "mcp-oversized-responses";

/** JSON-RPC error code for a response the shim refused to forward whole. */
const OVERSIZED_RESPONSE_ERROR_CODE = -32050;

export interface ResponseBoundDeps {
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
 * Write `serialized` to a file under `<stateDir>/mcp-oversized-responses/`
 * and return its path. The filename includes both a timestamp and a random
 * suffix so two oversized responses landing in the same millisecond (a burst
 * of parallel tool calls) never collide.
 */
function spoolResponse(serialized: string, deps: ResponseBoundDeps): string {
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync;
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync;
  const dir = path.join(deps.stateDir ?? getMinskyStateDir(), SPOOL_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const suffix = Math.random().toString(36).slice(2, 8);
  const fileName = `response-${Date.now()}-${suffix}.json`;
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, serialized, "utf8");
  return filePath;
}

/**
 * Return `resp` unchanged if its serialized JSON-RPC frame fits within
 * `MAX_STDOUT_FRAME_BYTES`; otherwise spool the full frame to a file and
 * return a JSON-RPC error response naming the size and the spooled path.
 *
 * Called once per response, immediately before `handleLine` writes it to
 * stdout — see `main.ts`. Never throws: a spool failure (e.g. an unwritable
 * state dir) propagates as a normal exception from `writeFileSync`/`mkdirSync`,
 * which `handleLine`'s existing try/catch already converts into a JSON-RPC
 * error frame the same way any other daemon-request failure is — so this
 * function does not need its own fallback path.
 */
export function boundOversizedResponse(
  resp: JsonRpcMessage,
  deps: ResponseBoundDeps = {}
): JsonRpcMessage {
  const serialized = JSON.stringify(resp);
  const byteLength = utf8ByteLength(serialized);
  if (byteLength <= MAX_STDOUT_FRAME_BYTES) return resp;

  const spooledPath = spoolResponse(serialized, deps);
  return makeErrorResponse(
    resp.id,
    OVERSIZED_RESPONSE_ERROR_CODE,
    `minsky mcp shim: response too large (${byteLength} bytes) exceeds the ` +
      `${MAX_STDOUT_FRAME_BYTES}-byte transport-safe limit (mt#4749) and was not ` +
      `forwarded, to protect the connection. Full response spooled to: ${spooledPath}`
  );
}
