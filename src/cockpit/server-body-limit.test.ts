/**
 * mt#3539 AT3 — round-trip: a body the run-state hook actually produces must
 * survive the real cockpit server's JSON parser, and a genuinely unbounded one
 * must still be refused.
 *
 * This is the seam the defect lived in. The hook's own unit tests prove the
 * payload is bounded; they cannot prove the daemon accepts the result, because
 * the accepted ceiling lives on the other side of an HTTP boundary.
 *
 * Both requests target an unmatched `/api/*` path rather than
 * `/api/conversation-run-state` itself. The body limit is enforced by
 * `express.json` middleware, which runs BEFORE any route — so an unmatched path
 * exercises exactly the same parser with exactly the same configured ceiling,
 * while the real route's handler would additionally reach for a database that
 * `db-providers.ts` (correctly) refuses to resolve inside a test process
 * (mt#3254), and `createCockpitServer` exposes no seam to inject one. The
 * distinguishing signal is unchanged: 413 means the parser refused the body,
 * anything else means it accepted it.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { createCockpitServer } from "./server";
import { buildIngestBody } from "../../.minsky/hooks/record-conversation-run-state";
import type { ClaudeHookInput } from "../../.minsky/hooks/types";

const TEST_TOKEN = "b".repeat(64);
/** Unmatched on purpose — see the docblock. */
const ROUTE = "/api/mt3539-body-limit-probe";

const app = createCockpitServer({ overrideToken: TEST_TOKEN });
const server: Server = createServer(app);
const listening = new Promise<number>((resolve) =>
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
    resolve(addr.port);
  })
);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

async function post(body: string): Promise<number> {
  const port = await listening;
  const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body,
  });
  return res.status;
}

/** A `PostToolUse` carrying a large `tool_response` — the ordinary shape. */
const LARGE_INPUT = {
  session_id: "conv-at3",
  hook_event_name: "PostToolUse",
  cwd: "/repo",
  tool_name: "Grep",
  tool_response: "x".repeat(5 * 1024 * 1024),
} as unknown as ClaudeHookInput;

describe("conversation-run-state body limit (mt#3539 AT3)", () => {
  test("parses a body the hook actually produces", async () => {
    const bounded = JSON.stringify(buildIngestBody(LARGE_INPUT, new Date()));
    // 404 from the unmatched-/api guard, which only runs once the body parsed.
    expect(await post(bounded)).toBe(404);
  });

  test("still refuses a genuinely unbounded body", async () => {
    // The pre-fix shape, pinned so a future limit bump cannot silently turn the
    // daemon into an unbounded buffer.
    const unbounded = JSON.stringify({
      conversationId: "conv-at3",
      eventName: "PostToolUse",
      observedAt: new Date().toISOString(),
      cwd: "/repo",
      payload: { tool_response: "x".repeat(5 * 1024 * 1024) },
    });
    expect(await post(unbounded)).toBe(413);
  });
});
