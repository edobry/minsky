/**
 * mt#4338 — hosted-mode DERIVATION.
 *
 * The distinction this file exists to hold: `guard.test.ts` asserts what the
 * hosted guard DOES once the flag is set (it calls `setHostedMode(true)`
 * directly, then checks that `git.*` is refused). Those assertions were correct
 * and passing throughout the incident. Nothing asserted how the flag GETS its
 * value, so `mcp start --local-daemon` — the tray's own daemon, on the
 * developer's laptop — set it to true and lost every `git.*` and most
 * `session.*` commands.
 *
 * A flag whose value is asserted and whose ASSIGNMENT is not is the gap; these
 * tests close it for this flag.
 */

import { describe, test, expect } from "bun:test";

import { isHostedMcpServer } from "./cli-discriminators";

describe("isHostedMcpServer — mt#4338 hosted-vs-local derivation", () => {
  // The two argv forms that actually exist in production. Both reach this
  // predicate with `http: true` — the local one because the `--local-daemon`
  // mode branch in start-command.ts sets `options.http = true` itself, which
  // is precisely why transport cannot be the discriminator.

  test("`mcp start --http --host 0.0.0.0 --port $PORT --require-auth` (Dockerfile CMD) is hosted", () => {
    expect(isHostedMcpServer({ http: true })).toBe(true);
  });

  test("`mcp start --local-daemon` (tray argv, implies --http) is NOT hosted", () => {
    // The regression. Pre-fix this returned true and the daemon refused
    // `git.*` / `session.*` with "use the local server for this command"
    // while running on the local server.
    expect(isHostedMcpServer({ http: true, localDaemon: true })).toBe(false);
  });

  test("`mcp start --http --local-daemon` (setup local-http argv) is NOT hosted", () => {
    // `minsky setup local-http` spawns with BOTH flags explicit. Same verdict
    // as the tray form — the mode flag wins over the transport flag.
    expect(isHostedMcpServer({ http: true, localDaemon: true })).toBe(false);
  });

  test("bare `mcp start` (stdio) is not hosted", () => {
    expect(isHostedMcpServer({})).toBe(false);
  });

  test("a local daemon is not hosted even if --http was never resolved", () => {
    // Defensive: the mode branch sets options.http itself, but the predicate
    // must not depend on the caller having run that mutation first.
    expect(isHostedMcpServer({ localDaemon: true })).toBe(false);
  });
});
