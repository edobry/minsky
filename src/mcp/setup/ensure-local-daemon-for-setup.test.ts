/**
 * Tests for the daemon-ensuring adapter `setup`/`init` inject (mt#4707).
 *
 * The spawn/probe DECISION belongs to `ensureDaemonRunning` and is tested with
 * the rest of that module. What this adapter owns, and what is asserted here,
 * is the TRANSLATION: turning that function's result-or-throw contract into an
 * outcome the domain can report without emitting a false sentence.
 */

/* eslint-disable custom/no-real-fs-in-tests -- the upstream-coupling case below is ABOUT the real `local-http-apply.ts` source: a fixture would assert this file's own copy of the phrase against itself, which is the circularity that case exists to break. */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { ensureLocalDaemonForSetup } from "./ensure-local-daemon-for-setup";

const ARGV = ["/path/to/bun", "/path/to/minsky"];

describe("mt#4707 — translating the daemon-ensuring result", () => {
  it("reports a spawn as `started`", async () => {
    const outcome = await ensureLocalDaemonForSetup("/repo", {
      argv: ARGV,
      ensure: async () => ({ spawned: true, status: { state: "running" } }) as never,
    });

    expect(outcome.kind).toBe("started");
    // The endpoint travels WITH the outcome so the domain can name it without a
    // fifth hand-maintained copy of the address (PR #3658 R3).
    if (outcome.kind !== "started") throw new Error("expected a started outcome");
    expect(outcome.url).toContain("/mcp");
    expect(outcome.url).toContain("48765");
  });

  it("SC2 — reports an existing daemon as `already-running`, so nothing is spawned twice", async () => {
    const outcome = await ensureLocalDaemonForSetup("/repo", {
      argv: ARGV,
      ensure: async () => ({ spawned: false, status: { state: "running" } }) as never,
    });

    expect(outcome.kind).toBe("already-running");
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

  it("PR #3658 R1 — the daemon layer's write claim never reaches the operator", async () => {
    // `ensureDaemonRunning` ends every refusal with "Nothing has been written."
    // That is true for its own caller and FALSE here: `setup`/`init` write the
    // client config regardless, so forwarding it verbatim produced two
    // contradictory sentences in one message. The diagnosis is kept; the claim
    // is not.
    const outcome = await ensureLocalDaemonForSetup("/repo", {
      argv: ARGV,
      ensure: async () => {
        throw new Error(
          "Refusing to migrate onto the local MCP daemon at http://127.0.0.1:48765/health: " +
            "it reports unhealthy. Restart the daemon and re-run once /health reports ready. " +
            "Nothing has been written."
        );
      },
    });

    if (outcome.kind !== "unavailable") throw new Error("expected an unavailable outcome");
    expect(outcome.reason).not.toContain("Nothing has been written");
    // The useful half survives — the operator still learns which URL and why.
    expect(outcome.reason).toContain("http://127.0.0.1:48765/health");
    expect(outcome.reason).toContain("reports unhealthy");
  });

  it("PR #3658 R3 — the stripped phrase is still the one upstream actually emits", async () => {
    // Without this, the guard verifies itself in a circle: every case above
    // feeds `stripWriteClaim` a message THIS FILE wrote, so it proves the
    // stripper works on my string, not that my string is upstream's. If
    // `ensureDaemonRunning` reworded its refusals, all of them would keep
    // passing while the contradiction quietly returned — mem#704's shape, in a
    // test rather than a probe.
    //
    // The docblock on `stripWriteClaim` claims a reworded upstream message
    // "fails a test rather than silently reintroducing the contradiction."
    // This is the test that makes that sentence true.
    // `String(...)`: the `readFileSync` overload widens to `string | Buffer`
    // under this tsconfig, and bun test does not typecheck — so the untyped
    // version ran green locally and failed `validate_typecheck`.
    const upstream = String(
      readFileSync(fileURLToPath(new URL("./local-http-apply.ts", import.meta.url)), "utf-8")
    );

    const occurrences = upstream.split("Nothing has been written.").length - 1;
    expect(occurrences).toBeGreaterThan(0);
  });

  it("leaves a message that carries no write claim untouched", async () => {
    // The stripper must be a no-op on messages that never had the sentence,
    // rather than mangling them — the failure mode of a filter nobody checks.
    const outcome = await ensureLocalDaemonForSetup("/repo", {
      argv: ARGV,
      ensure: async () => {
        throw new Error("spawn ENOENT: bun not found on PATH");
      },
    });

    if (outcome.kind !== "unavailable") throw new Error("expected an unavailable outcome");
    expect(outcome.reason).toBe("spawn ENOENT: bun not found on PATH");
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
