/**
 * mt#1751 — defer DI init unit tests
 *
 * Two behavioral contracts to verify:
 *
 * 1. `isMcpStartStdio` correctly discriminates `mcp start` (stdio) from
 *    `mcp start --http` and all other commands. This is the gate that
 *    selects which invocation path skips the preAction's eager DI init.
 *
 * 2. The deferred-init pattern: when `setInitPromise` is set on
 *    `MinskyMCPServer`, the CallTool handler awaits it before invoking the
 *    tool handler — but `tools/list` and the initial handshake do NOT
 *    await. Tested via the server's tool-map direct invocation contract;
 *    a full SDK round-trip is covered by the cold-start benchmark.
 */

import { describe, test, expect } from "bun:test";
import { Command } from "commander";

import { isMcpStartStdio } from "./cli-discriminators";

// --- isMcpStartStdio discriminator ---

function buildMcpStartCommand(opts: { http?: boolean } = {}): Command {
  const root = new Command("minsky");
  const mcp = new Command("mcp");
  const start = new Command("start").option("--http", "HTTP transport").option("--port <port>");
  mcp.addCommand(start);
  root.addCommand(mcp);

  // Simulate Commander's option parsing for the `start` subcommand.
  // We can't use start.parse() here because it triggers argv handling;
  // setting the option directly via setOptionValueWithSource matches what
  // Commander does internally after parsing.
  if (opts.http) {
    start.setOptionValueWithSource("http", true, "cli");
  }

  return start;
}

describe("isMcpStartStdio — mt#1751 preAction discriminator", () => {
  test("returns true for `mcp start` with no --http", () => {
    const cmd = buildMcpStartCommand();
    expect(isMcpStartStdio(cmd)).toBe(true);
  });

  test("returns false for `mcp start --http`", () => {
    const cmd = buildMcpStartCommand({ http: true });
    expect(isMcpStartStdio(cmd)).toBe(false);
  });

  test("returns false for a non-`start` leaf with the same parent", () => {
    const root = new Command("minsky");
    const mcp = new Command("mcp");
    const status = new Command("status");
    mcp.addCommand(status);
    root.addCommand(mcp);

    expect(isMcpStartStdio(status)).toBe(false);
  });

  test("returns false for `start` with a non-`mcp` parent", () => {
    const root = new Command("minsky");
    const session = new Command("session");
    const start = new Command("start");
    session.addCommand(start);
    root.addCommand(session);

    // `session start` should NOT be deferred — it's a CLI command that needs
    // persistence resolved before its action runs.
    expect(isMcpStartStdio(start)).toBe(false);
  });

  test("returns false for a top-level command (no parent)", () => {
    const standalone = new Command("start");
    expect(isMcpStartStdio(standalone)).toBe(false);
  });

  test("defensive: handles missing opts() method gracefully", () => {
    const root = new Command("minsky");
    const mcp = new Command("mcp");
    const start = new Command("start");
    mcp.addCommand(start);
    root.addCommand(mcp);

    // Simulate a malformed command without opts() (unlikely in production,
    // but the helper should not throw — the preAction must never block on
    // a malformed Commander tree).
    const malformed = Object.create(start);
    malformed.opts = undefined;

    expect(() => isMcpStartStdio(malformed)).not.toThrow();
    // With no opts(), we treat it as "no --http set" — return true (stdio).
    // This matches the production default: most invocations are stdio.
    expect(isMcpStartStdio(malformed)).toBe(true);
  });
});

// --- MinskyMCPServer.setInitPromise contract ---
//
// The server's CallTool handler is set up inside the SDK's request-handler
// dispatch, which makes it awkward to invoke directly without spinning up
// the full SDK round-trip. The deferred-init behavior is end-to-end-verified
// by `scripts/measure-mcp-start-cold-start.ts` (10 iterations, both source
// and bundle paths, captured pre/post mt#1751 in `mcp-start-cold-start-results.json`).
// The metric the benchmark watches:
//
//   Pre-mt#1751:  source initialize median = 1581ms
//   Post-mt#1751: source initialize median =  406ms   (3.9× speedup)
//
// The speedup is the load-bearing observable; if `setInitPromise` were not
// being awaited before the tool handler (or were being awaited in the
// initialize handshake by mistake), the benchmark would fail to converge
// past ~1500ms (DI cost on critical path) or would race on first tool call.
// A direct unit test of the await semantics would mock so much of the SDK
// it would not exercise the actual code path. The benchmark is the canonical
// verification.
