/**
 * Test-only access to the registered `tools/call` handler (mt#4854).
 *
 * ## Why this module exists
 *
 * Four test files drive the MCP dispatch path by reaching into the SDK `Server`'s
 * PRIVATE `_requestHandlers` map — `server.test.ts` (8 sites),
 * `server-response-size-guard.test.ts` (3), `drift-gate.test.ts` (2), and
 * `server-in-flight-tool-calls.test.ts` (1). That coupling predates this task by
 * months and is tracked at **mt#4844**, which migrates these sites to the supported
 * `MinskyMCPServer.connectTransport` + `InMemoryTransport` seam.
 *
 * This module does NOT do mt#4844's job. It collapses fourteen copies of the reach
 * into one, so that migration is a single edit instead of fourteen — and so the
 * v2-context detail below is stated once rather than repeated four times.
 *
 * ## Why the context argument is no longer `{}`
 *
 * Under SDK v1 the low-level handler received a flat `extra` object, and these tests
 * passed a bare `{}` because Minsky's own handlers only ever read `sessionId`.
 *
 * SDK v2 routes every **input-required-capable** handler — `tools/call` among them —
 * through `Server._invokeInputRequiredCapableHandler`, which reads
 * `ctx.mcpReq.requestState()` BEFORE delegating to the registered handler. A bare `{}`
 * therefore throws inside the SDK now, before any Minsky code runs:
 *
 *     TypeError: undefined is not an object (evaluating 'ctx.mcpReq.requestState')
 *
 * `tools/list` is NOT input-required-capable, so the `tools/list` invocations in these
 * suites still pass `{}` unchanged and need nothing from here. That asymmetry is the
 * reason this helper is scoped to `tools/call` rather than to handlers in general.
 *
 * `requestState: () => undefined` is the "this round carries no request state" case,
 * which is what every test using this means; the SDK skips the rest of its wrapper
 * once the handler returns an ordinary (non-input-required) result.
 */

/** The shape these tests reach through — an SDK `Server`'s private handler registry. */
interface SdkServerWithPrivateHandlers {
  _requestHandlers: Map<string, (request: unknown, ctx: unknown) => Promise<unknown>>;
}

/**
 * Look up the registered `tools/call` handler on `sdkServer` and return it wrapped so
 * callers can keep passing `{}` (or nothing) as the context.
 *
 * @param sdkServer the SDK `Server` instance — NOT the `MinskyMCPServer` wrapper. Callers
 *   holding the wrapper should reach its `.server` field first, as they already do.
 * @throws if no `tools/call` handler is registered, which means the server was not
 *   configured — a test-setup bug, and worth failing loudly rather than returning
 *   `undefined` for the caller to dereference.
 */
export function getToolsCallHandler(
  sdkServer: unknown
): (request: unknown, ctx?: unknown) => Promise<unknown> {
  const handlers = (sdkServer as SdkServerWithPrivateHandlers)._requestHandlers;
  const handler = handlers?.get("tools/call");
  if (!handler) throw new Error("Expected tools/call handler to be registered");
  return (request: unknown, ctx: unknown = {}) =>
    handler(request, {
      ...(ctx as Record<string, unknown>),
      // Defaults FIRST, caller's `mcpReq` spread over them — so a test that supplies its
      // own member wins, and one that supplies none still gets both defaults. The outer
      // spread cannot do this: it sets sibling keys, so a literal `mcpReq` after it would
      // silently discard whatever the caller passed (PR #3547 R2 caught exactly that —
      // the comment here claimed caller-first while the code was default-wins).
      mcpReq: {
        requestState: () => undefined,
        // `notify` is the second `ctx.mcpReq` member our own dispatch path reaches:
        // `server.ts:1471` passes it to `buildProgressReporter` whenever the request
        // carries a `progressToken` (mt#2677). It is the ONLY other one — verified by
        // grepping `ctx.mcpReq.` across src, packages and scripts. No test sets a
        // progressToken today, so this default is never exercised; without it, the first
        // test that did would fail on an undefined callee rather than on its assertion.
        //
        // A no-op is the right default because the spec makes progress delivery optional
        // ("the receiver is not obligated to provide these notifications"). A test that
        // ASSERTS on progress passes its own `notify`, which the spread below honours.
        notify: async () => {},
        ...(((ctx as { mcpReq?: Record<string, unknown> } | undefined)?.mcpReq ?? {}) as Record<
          string,
          unknown
        >),
      },
    });
}
