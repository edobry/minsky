#!/usr/bin/env bun
/**
 * Read a real `tools/list` response and assert `mcpHidden` params are absent (mt#4579).
 *
 * SC1 says "verified by reading a `tools/list` response, not by reading the code
 * that builds it." This does exactly that: it spawns the MCP server over stdio
 * from THIS working tree, performs the JSON-RPC handshake, requests
 * `tools/list`, and inspects the advertised `inputSchema` of the tools that
 * declare a hidden parameter.
 *
 * Checks both directions, so the probe can fail:
 *   - `callerActorId` is ABSENT from each hidden-param tool's schema.
 *   - a normal parameter (`taskId`) is still PRESENT — otherwise "absent" would
 *     also pass against a tool whose schema failed to build at all.
 *
 * Exit 0 = pass, non-zero = fail. No env vars required; the server is started
 * with a stdio transport and killed on completion.
 *
 * Usage:
 *   bun scripts/verify-mcp-hidden-params.ts
 */

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

/** Tools that declare a `mcpHidden` parameter, and the param each hides. */
const EXPECTATIONS = [
  { tool: "tasks_claims_release", hidden: "callerActorId", visible: "taskId" },
  { tool: "tasks_dispatch-recover", hidden: "callerActorId", visible: "taskId" },
  { tool: "asks_create", hidden: "callerActorId", visible: null },
  { tool: "observability_calibration-review", hidden: "callerActorId", visible: null },
] as const;

interface JsonRpcMessage {
  id?: number;
  error?: { code?: number; message?: string };
  result?: {
    protocolVersion?: string;
    tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  };
}

async function main() {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "mcp", "start"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MINSKY_MCP_TRANSPORT: "stdio" },
  });

  const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      // Sourced from the SDK, never pinned to a literal (PR #3352 R1): a
      // hard-coded date couples this probe to one protocol revision, so a
      // server bump would break the HARNESS and mask the product regression it
      // exists to catch. Same import `scripts/deploy-minsky-mcp.ts` already
      // uses. A rejected version fails loudly below rather than surfacing as a
      // missing tools/list reply.
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "verify-mcp-hidden-params", version: "1.0.0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await proc.stdin.flush();

  // Read stdout until the tools/list reply (id 2) arrives, or we time out.
  const decoder = new TextDecoder();
  const deadline = Date.now() + 90_000;
  let buffer = "";
  let tools: Array<{
    name: string;
    inputSchema?: { properties?: Record<string, unknown> };
  }> | null = null;

  const reader = proc.stdout.getReader();
  while (Date.now() < deadline && tools === null) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineAt: number;
    while ((newlineAt = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      if (!line.startsWith("{")) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // not a JSON-RPC frame (log line on stdout)
      }
      // A rejected handshake must fail HERE, naming the version, rather than
      // timing out later as a missing tools/list reply — otherwise a protocol
      // bump reads as "the tool surface is broken" (PR #3352 R1).
      if (msg.id === 1 && msg.error) {
        console.error(
          `[verify-mcp-hidden-params] FAIL: server rejected initialize at ` +
            `protocolVersion "${LATEST_PROTOCOL_VERSION}" (from the MCP SDK): ` +
            `${msg.error.message ?? "no message"}. The SDK and the server disagree on the ` +
            `protocol — update @modelcontextprotocol/sdk, or negotiate a version this server ` +
            `accepts. This is a HARNESS failure, not a finding about mcpHidden.`
        );
        proc.kill();
        process.exit(1);
      }
      if (msg.id === 1 && msg.result?.protocolVersion) {
        console.log(
          `[verify-mcp-hidden-params] handshake ok at protocolVersion ` +
            `${msg.result.protocolVersion} (requested ${LATEST_PROTOCOL_VERSION})`
        );
      }
      if (msg.id === 2 && msg.error) {
        console.error(
          `[verify-mcp-hidden-params] FAIL: tools/list returned an error: ` +
            `${msg.error.message ?? "no message"}`
        );
        proc.kill();
        process.exit(1);
      }
      if (msg.id === 2 && msg.result?.tools) {
        tools = msg.result.tools;
        break;
      }
    }
  }

  proc.kill();

  if (!tools) {
    console.error("[verify-mcp-hidden-params] FAIL: no tools/list response within the deadline");
    process.exit(1);
  }

  console.log(`[verify-mcp-hidden-params] tools/list returned ${tools.length} tools`);

  let failures = 0;
  for (const expect of EXPECTATIONS) {
    const tool = tools.find((t) => t.name === expect.tool);
    if (!tool) {
      console.error(`  FAIL ${expect.tool}: not present in tools/list`);
      failures++;
      continue;
    }
    const props = Object.keys(tool.inputSchema?.properties ?? {});
    const hiddenPresent = props.includes(expect.hidden);
    const visibleOk = expect.visible === null || props.includes(expect.visible);

    if (hiddenPresent) {
      console.error(
        `  FAIL ${expect.tool}: advertises "${expect.hidden}" — properties: ${props.join(", ")}`
      );
      failures++;
    } else if (!visibleOk) {
      // Guards the inverse reading: an empty/broken schema would also omit the
      // hidden key, which is not the property being asserted.
      console.error(
        `  FAIL ${expect.tool}: "${expect.visible}" missing too — schema looks empty, not filtered`
      );
      failures++;
    } else {
      console.log(`  ok   ${expect.tool}: no "${expect.hidden}"; advertises [${props.join(", ")}]`);
    }
  }

  if (failures > 0) {
    console.error(`[verify-mcp-hidden-params] FAIL: ${failures} tool(s)`);
    process.exit(1);
  }
  console.log("[verify-mcp-hidden-params] PASS");
}

main().catch((err) => {
  console.error(
    "[verify-mcp-hidden-params] FAIL:",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
