import { isLegacyRequest } from "@modelcontextprotocol/server";
import { toWebRequest, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";

/**
 * Which protocol era must serve this HTTP request (mt#4608).
 *
 * Extracted from `MinskyMCPServer.handleHttpRequest` so the era decision is a
 * pure input -> output function. A test can hand it a realistic request and
 * assert the classification against the REAL vendor classifier, instead of
 * patching a collaborator the routing reaches itself
 * (`testing-standards.mdc §Testable Design`).
 *
 * **The classification is the vendor's, and is deliberately not re-derived
 * here.** `createMcpHandler` routes with the same predicate, so any local copy
 * of the rules would diverge from it silently — the request would be sent to
 * one era and served by the other.
 *
 * What the vendor's classifier actually does, read from the installed dist and
 * pinned by `era-routing.test.ts` rather than taken from prose about it:
 *
 * - **A non-POST is unconditionally legacy.** `classifyInboundRequest` returns
 *   `{ kind: "legacy", reason: "http-method" }` before looking at the body, so
 *   nothing can pull a GET (the 2025 SSE stream) or DELETE onto the modern
 *   handler.
 * - **A POST whose body is absent or unparseable is legacy**, via
 *   `step: "no-json-body"`, before any other rule runs.
 * - **Otherwise the BODY decides.** The era is claimed by the `_meta` envelope;
 *   `modernOnlyStrictRejection` names the legacy reasons `initialize` and
 *   `no-claim` ("the request did not name a protocol version"). The
 *   `mcp-protocol-version` header is read, but it is NOT what makes a request
 *   modern — a body carrying the envelope classifies modern without it.
 *
 * The practical consequence for the dual-path split: an existing 2025 client
 * cannot be routed modern by accident, because it never emits that `_meta` key.
 *
 * Pass `parsedBody` whenever the caller already has it (Express's
 * `express.json()` middleware does). Without it the vendor reads the body from
 * an internal clone, which leaves the original request readable for whichever
 * handler is chosen — but re-reading costs a parse we have already paid for.
 */
export async function isModernEraRequest(
  req: NodeIncomingMessageLike,
  parsedBody?: unknown
): Promise<boolean> {
  const webRequest = await toWebRequest(req, parsedBody);
  return !(await isLegacyRequest(webRequest, parsedBody));
}
