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

/**
 * mt#4342 — the third deployment `--local-daemon` could not reach.
 *
 * mt#4338's tests above cover two argv forms and both still pass unchanged.
 * The gap they left is a THIRD: a plain `mcp start --http --port N` on a
 * developer machine, which carries no `--local-daemon` and so was
 * indistinguishable from the Dockerfile CMD. It classified hosted and had
 * `git.*` refused with git on PATH.
 *
 * The table these assert, one row per real deployment:
 *
 *   argv                                        | where  | hosted
 *   --http --host 0.0.0.0 --require-auth (CMD)  | hosted | true
 *   --http --local-daemon (tray / setup)        | local  | false
 *   --http --port N (plain local)               | local  | false  <- mt#4342
 */
describe("isHostedMcpServer — mt#4342 capability, not just the launcher flag", () => {
  test("row 3: a plain `--http --port N` WITH a local git workspace is NOT hosted", () => {
    // The defect. Pre-fix this returned true, because the predicate was
    // `http && !localDaemon` and row 3 sets neither discriminating flag.
    expect(isHostedMcpServer({ http: true, hasLocalWorkspace: true })).toBe(false);
  });

  test("row 1: the same argv WITHOUT a local git workspace is still hosted", () => {
    // The container: no `.git` (excluded by .dockerignore) and no git binary.
    // This is the assertion that would break if the fix widened too far.
    expect(isHostedMcpServer({ http: true, hasLocalWorkspace: false })).toBe(true);
  });

  test("an UNDETERMINED capability resolves to hosted — the fail-closed direction", () => {
    // mt#1601: "a false _allow_ reaches the raw `git: not found` … a false
    // _block_ only returns a clean 'use the local server' message." So an
    // absent/unknown answer must land on hosted, never on local.
    expect(isHostedMcpServer({ http: true })).toBe(true);
    expect(isHostedMcpServer({ http: true, hasLocalWorkspace: undefined })).toBe(true);
  });

  test("row 2 is unchanged: --local-daemon alone still proves local", () => {
    // The mt#4338 discriminator is not replaced, only joined. The tray spawns
    // without --repo, so it must not depend on the workspace probe.
    expect(isHostedMcpServer({ http: true, localDaemon: true, hasLocalWorkspace: false })).toBe(
      false
    );
  });

  test("stdio is still never hosted, whatever the capability says", () => {
    expect(isHostedMcpServer({ hasLocalWorkspace: false })).toBe(false);
  });
});

// The capability probe itself moved to `@minsky/domain/utils/git-exec` in
// PR #3233 R1 so it could reuse `isInsideGitWorkTree`'s upward walk; its tests
// live in `packages/domain/src/utils/git-exec.test.ts`.
