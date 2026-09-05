/**
 * Tests for the daemon-ensuring adapter `setup`/`init` inject (mt#4707).
 *
 * The spawn/probe DECISION belongs to `ensureDaemonRunning` and is tested with
 * the rest of that module. What this adapter owns, and what is asserted here,
 * is the TRANSLATION: turning that function's result-or-throw contract into an
 * outcome the domain can report without emitting a false sentence.
 */

import { describe, it, expect } from "bun:test";

import { ensureLocalDaemonForSetup } from "./ensure-local-daemon-for-setup";

const ARGV = ["/path/to/bun", "/path/to/minsky"];

describe("mt#4707 — translating the daemon-ensuring result", () => {
  it("reports a spawn as `started`", async () => {
    const outcome = await ensureLocalDaemonForSetup("/repo", {
      argv: ARGV,
      ensure: async () => ({ spawned: true, status: { state: "running" } }) as never,
    });

    expect(outcome).toEqual({ kind: "started" });
  });

  it("SC2 — reports an existing daemon as `already-running`, so nothing is spawned twice", async () => {
    const outcome = await ensureLocalDaemonForSetup("/repo", {
      argv: ARGV,
      ensure: async () => ({ spawned: false, status: { state: "running" } }) as never,
    });

    expect(outcome).toEqual({ kind: "already-running" });
  });

  it("converts a refusal into a reason instead of letting it throw", async () => {
    // `ensureDaemonRunning` throws on `foreign` / `not-ready`. Propagating that
    // would abort `setup` over a condition that does not invalidate the config
    // it is about to write.
    const outcome = await ensureLocalDaemonForSetup("/repo", {
      argv: ARGV,
      ensure: async () => {
        throw new Error(
          "Refusing to start the local MCP daemon: http://127.0.0.1:48765/health is already " +
            "answered by something else — some other service. Stop it first, then re-run."
        );
      },
    });

    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("expected an unavailable outcome");
    expect(outcome.reason).toContain("already answered by something else");
  });

  it("passes the repo path through to the spawn command", async () => {
    // The daemon is machine-wide but its spawn line carries a `--repo`, and
    // which repo it picked is a real choice the operator can be shown.
    let seenArgv: string[] = [];
    await ensureLocalDaemonForSetup("/some/project", {
      argv: ARGV,
      ensure: async (spawnArgv) => {
        seenArgv = spawnArgv;
        return { spawned: true, status: { state: "running" } } as never;
      },
    });

    expect(seenArgv).toContain("--repo");
    expect(seenArgv).toContain("/some/project");
    expect(seenArgv).toContain("--local-daemon");
  });

  it("does not swallow a non-Error throw", async () => {
    const outcome = await ensureLocalDaemonForSetup("/repo", {
      argv: ARGV,
      ensure: async () => {
        // The point of this case is a non-Error rejection: the adapter must
        // stringify it rather than reporting `undefined` as the reason.
        // eslint-disable-next-line no-throw-literal
        throw "a bare string";
      },
    });

    expect(outcome).toEqual({ kind: "unavailable", reason: "a bare string" });
  });
});
