#!/usr/bin/env bun
/**
 * Live smoke test for the MCP initialize handshake (mt#1821).
 *
 * Verifies end-to-end that the shared `callMcp` helper:
 *   1. Performs the MCP Streamable HTTP `initialize` request first.
 *   2. Captures the `Mcp-Session-Id` header.
 *   3. Sends `notifications/initialized`.
 *   4. Calls a real read-only tool (`session_list`) with the session id header
 *      and observes a non-error response.
 *
 * Without the mt#1821 fix this script would fail at step 4 with the JSON-RPC
 * error code -32600 "Invalid Request: first request must be initialize" — the
 * exact bug reported in the merge-state-sweeper logs that motivated this task.
 *
 * ## Env gate
 *
 * Skips gracefully (exit 0) when MINSKY_MCP_URL or MINSKY_MCP_AUTH_TOKEN is unset
 * so it is safe to ship in CI without live credentials. The main agent runs
 * this against the deployed minsky-mcp endpoint and pastes the redacted output
 * into the PR body's "## Live verification" section per implement-task §7a.
 *
 * Usage:
 *   MINSKY_MCP_URL=https://minsky-mcp-production.up.railway.app/mcp \
 *     MINSKY_MCP_AUTH_TOKEN=$(cat ~/.config/minsky/minsky-mcp.env | grep AUTH | cut -d= -f2) \
 *     bun services/reviewer/scripts/smoke-mcp-init.ts
 */

import { callMcp } from "../src/mcp-client";

const mcpUrl = process.env["MINSKY_MCP_URL"];
// mt#1825: prefer canonical name; fall back to legacy during rename migration.
const mcpToken = process.env["MINSKY_MCP_AUTH_TOKEN"] ?? process.env["MINSKY_MCP_TOKEN"];

if (!mcpUrl || !mcpToken) {
  console.log("SKIP: MINSKY_MCP_URL or MINSKY_MCP_AUTH_TOKEN not set; skipping live smoke test.");
  process.exit(0);
}

console.log(JSON.stringify({ event: "smoke_mcp_init.start", mcpUrl }));

const start = Date.now();
const result = await callMcp(
  "session_list",
  {},
  { mcpUrl, mcpToken },
  { logPrefix: "smoke_mcp_init.mcp", timeoutMs: 30_000 }
);
const elapsedMs = Date.now() - start;

if (!result.ok) {
  console.log(
    JSON.stringify({
      event: "smoke_mcp_init.fail",
      reason: result.reason,
      message: result.message,
      httpStatus: result.httpStatus,
      rpcErrorCode: result.rpcError?.code,
      rpcErrorMessage: result.rpcError?.message,
      elapsedMs,
    })
  );
  process.exit(1);
}

// Trim content for visibility — full list can be megabytes on busy installs.
const contentPreview = result.contentText !== null ? result.contentText.slice(0, 200) : null;
const sessionCount = (() => {
  if (!result.contentText) return null;
  try {
    const parsed = JSON.parse(result.contentText) as { sessions?: unknown[] };
    return Array.isArray(parsed.sessions) ? parsed.sessions.length : null;
  } catch {
    return null;
  }
})();

console.log(
  JSON.stringify({
    event: "smoke_mcp_init.pass",
    elapsedMs,
    sessionCount,
    contentPreview,
  })
);

process.exit(0);
