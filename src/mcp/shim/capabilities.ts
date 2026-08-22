/**
 * Capability-declaration narrowing for `minsky mcp shim` (mt#4450).
 *
 * ## What this exists for
 *
 * A client capability is a claim about a CONNECTION, not about the client
 * program. The MCP spec states the client half normatively — "Clients that
 * support elicitation MUST declare the `elicitation` capability during
 * initialization" — and says nothing about an intermediary, because its model
 * has a client and a server on one wire.
 *
 * The shim is on that wire, and it is one-directional by construction: it reads
 * a line from stdin, POSTs it, and writes the responses back (`main.ts`'s
 * `handleLine` + `client.ts`'s `postOnce`). It opens no GET/SSE stream and holds
 * no correlation table, so a SERVER-INITIATED request has no path to the client.
 * Worse, `postOnce` reads the response with `await response.text()`, which fully
 * buffers — so a server request sent inside the response stream cannot surface
 * until the stream closes, and the stream cannot close until the request is
 * answered. Deadlock by construction, not a race.
 *
 * Forwarding the client's declaration verbatim therefore tells the daemon this
 * connection can service something it structurally cannot. That is what
 * mt#4450 diagnosed: Claude Code advertises `"elicitation": {}` (captured
 * verbatim in ADR-038 §Question 1 "Observation B"), the ask router honored it,
 * and every `direction.decide` ask hung for minutes and then landed suspended.
 *
 * ## Why the whole class, not just `elicitation`
 *
 * `SERVER_INITIATED_CAPABILITIES` is defined by the property that breaks —
 * "the capability's only use is a request the SERVER sends to the CLIENT" — and
 * not by which one happens to be exercised today. As of this writing the
 * `Server` class's `elicitInput` method is the only such call Minsky makes
 * (named without its call syntax on purpose: `elicitation-containment.test.ts`
 * scans the repo for that literal and allowlists exactly two files, so writing
 * it here would trip a guard this file does not belong inside). `sampling` and
 * `roots` are declared by Claude Code and used by nothing here. Stripping only
 * the exercised one would leave two declarations that are equally false about
 * this connection, and a future `roots/list` call would deadlock identically
 * and just as silently. The set is the class.
 *
 * ## What this deliberately does NOT do
 *
 * It does not make elicitation work, and it is not a permanent verdict against
 * it. If the shim later carries server-initiated requests — a GET/SSE stream
 * plus request correlation — deleting this transform restores the capability
 * with no other change, which is why the narrowing lives in one place with one
 * exported set rather than being spread across the handshake path.
 *
 * @see src/mcp/shim/main.ts — the caller, in `handleLine`
 * @see src/mcp/shim/client.ts — `postOnce`, the buffering that makes it a deadlock
 * @see docs/architecture/adr-038-local-shared-mcp-daemon.md §Question 1
 * @see https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
 */

import type { JsonRpcMessage } from "./protocol";

/**
 * Client capabilities whose only use is a request the SERVER sends to the
 * CLIENT. None of them can be serviced across the shim's one-directional
 * transport, so none may be declared on a connection that runs through it.
 *
 * Keep this list defined by the PROPERTY, not by usage: an entry earns its
 * place by requiring a server-initiated request, whether or not Minsky makes
 * that request today.
 */
export const SERVER_INITIATED_CAPABILITIES = ["elicitation", "sampling", "roots"] as const;

/**
 * Remove capabilities the shim's transport cannot service from an `initialize`
 * request's declared set.
 *
 * Returns a NEW message when something was removed, or `null` when nothing was
 * — the caller then forwards the original message untouched. This mirrors
 * `injectAgentIdMeta`'s contract in `identity.ts` so `handleLine` treats both
 * transforms the same way.
 *
 * No-op cases:
 * - not an `initialize` request (every other method passes through)
 * - `params` missing, non-object, or an array
 * - `capabilities` missing, non-object, or an array
 * - `capabilities` declares none of {@link SERVER_INITIATED_CAPABILITIES}
 *
 * A capability present but explicitly `undefined` still counts as declared and
 * is removed: `"elicitation" in caps` is the test, not truthiness, because the
 * MCP declaration form is an empty object (`"elicitation": {}`) and every
 * falsy-value check would pass it through.
 */
export function stripUnsupportedCapabilities(msg: JsonRpcMessage): JsonRpcMessage | null {
  if (msg.method !== "initialize") return null;
  if (!msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)) return null;

  const params = msg.params as Record<string, unknown>;
  const capabilities = params["capabilities"];
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }

  const declared = capabilities as Record<string, unknown>;
  const toRemove = SERVER_INITIATED_CAPABILITIES.filter((name) => name in declared);
  if (toRemove.length === 0) return null;

  const narrowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(declared)) {
    if (!(toRemove as readonly string[]).includes(key)) narrowed[key] = value;
  }

  return {
    ...msg,
    params: {
      ...params,
      capabilities: narrowed,
    },
  };
}
