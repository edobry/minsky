/**
 * Tests for the supervision-independent restart/stop path (mt#4232).
 *
 * Every dependency is injected through `RestartProbes`, so nothing here patches
 * `fetch`, `process.kill`, or a module import in place (ADR-036). The clock is
 * virtual: `sleep` advances it, so a 75s budget costs no wall-clock time and the
 * timeout branches are exercised deterministically rather than by waiting.
 */
import { describe, test, expect } from "bun:test";
import {
  describeOutcome,
  isRestartConfirmed,
  resolveRestart,
  resolveStop,
  RESTART_POLL_INTERVAL_MS,
  type RestartProbes,
  type ServingProcess,
} from "./daemon-restart";

const PORT = 3737;
const OURS = "minsky-cockpit";

function serving(over: Partial<ServingProcess> = {}): ServingProcess {
  return { pid: 100, processStartedAtMs: 1_000, service: OURS, ...over };
}

interface Fake {
  probes: RestartProbes;
  signalled: Array<{ pid: number; signal: string }>;
}

/**
 * `serving` is a queue: entry 0 answers the pre-signal read, the rest answer
 * successive polls. When it runs dry the LAST entry repeats forever, which is
 * how "nothing ever comes back" and "it never dies" are expressed.
 */
function fakeProbes(opts: {
  serving: Array<ServingProcess | null>;
  portHolderPid?: number | null;
  alive?: boolean;
  /** Simulates the identity check refusing, or the kill failing — one negative, per the primitive. */
  signalRefused?: string;
}): Fake {
  const signalled: Array<{ pid: number; signal: string }> = [];
  let clock = 0;
  let i = 0;

  const probes: RestartProbes = {
    serving: async () => {
      const next = opts.serving[Math.min(i, opts.serving.length - 1)] ?? null;
      i += 1;
      return next;
    },
    portHolderPid: () => opts.portHolderPid ?? null,
    signal: async (pid, signal) => {
      if (opts.signalRefused) return { ok: false, reason: opts.signalRefused };
      signalled.push({ pid, signal });
      return { ok: true };
    },
    isAlive: () => opts.alive ?? false,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };

  return { probes, signalled };
}

describe("isRestartConfirmed (mt#4232)", () => {
  test("a changed processStartedAtMs confirms the restart", () => {
    const before = serving({ pid: null, processStartedAtMs: 1_000 });
    const after = serving({ pid: null, processStartedAtMs: 2_000 });
    expect(isRestartConfirmed(before, after, 100)).toBe(true);
  });

  test("an unchanged processStartedAtMs does not", () => {
    const before = serving({ pid: null, processStartedAtMs: 1_000 });
    const after = serving({ pid: null, processStartedAtMs: 1_000 });
    expect(isRestartConfirmed(before, after, 100)).toBe(false);
  });

  test("the pid alone confirms it when the payload carries no start time", () => {
    // The upgrade case: the daemon being restarted predates processStartedAtMs
    // in its payload, but the replacement reports a pid.
    const before = serving({ pid: 100, processStartedAtMs: null });
    const after = serving({ pid: 201, processStartedAtMs: null });
    expect(isRestartConfirmed(before, after, 100)).toBe(true);
  });

  test("the SIGNALLED pid still answering outranks a changed start time", () => {
    // If we are demonstrably reading the same process, the start time is the
    // field to distrust — not evidence of a restart that plainly did not happen.
    const before = serving({ pid: 100, processStartedAtMs: 1_000 });
    const after = serving({ pid: 100, processStartedAtMs: 9_999 });
    expect(isRestartConfirmed(before, after, 100)).toBe(false);
  });

  test("with neither discriminator available, no restart is claimed", () => {
    const before = serving({ pid: null, processStartedAtMs: null });
    const after = serving({ pid: null, processStartedAtMs: null });
    expect(isRestartConfirmed(before, after, 100)).toBe(false);
  });
});

describe("resolveRestart (mt#4232)", () => {
  test("confirms a restart by observing processStartedAtMs change", async () => {
    const fake = fakeProbes({
      serving: [
        serving({ pid: 100, processStartedAtMs: 1_000 }),
        null, // the respawn gap
        serving({ pid: 200, processStartedAtMs: 2_000 }),
      ],
    });

    const outcome = await resolveRestart(PORT, fake.probes);

    expect(outcome.kind).toBe("restarted");
    expect(fake.signalled).toEqual([{ pid: 100, signal: "SIGTERM" }]);
  });

  test("nothing serving is reported as such, and nothing is signalled", async () => {
    const fake = fakeProbes({ serving: [null] });
    expect(await resolveRestart(PORT, fake.probes)).toEqual({ kind: "not-running" });
    expect(fake.signalled).toEqual([]);
  });

  test("a FOREIGN service on the port is never signalled", async () => {
    // The safety property of this whole path. Every Minsky service builds from
    // one monorepo and answers 200 identically (mt#3148), so the identity
    // assertion is the only thing standing between this command and SIGTERMing
    // an unrelated process that happens to hold the port.
    const fake = fakeProbes({ serving: [serving({ service: "minsky-mcp" })] });

    const outcome = await resolveRestart(PORT, fake.probes);

    expect(outcome).toEqual({ kind: "foreign-service", service: "minsky-mcp" });
    expect(fake.signalled).toEqual([]);
  });

  test("a service-less payload is foreign too, and is not signalled", async () => {
    const fake = fakeProbes({ serving: [serving({ service: null })] });
    expect((await resolveRestart(PORT, fake.probes)).kind).toBe("foreign-service");
    expect(fake.signalled).toEqual([]);
  });

  test("falls back to the port holder when health names no pid", async () => {
    // The common case on FIRST use: the daemon you are restarting is the stale
    // build that predates the `pid` field, which is why it needs restarting.
    const fake = fakeProbes({
      serving: [
        serving({ pid: null, processStartedAtMs: 1_000 }),
        serving({ pid: null, processStartedAtMs: 2_000 }),
      ],
      portHolderPid: 777,
    });

    const outcome = await resolveRestart(PORT, fake.probes);

    expect(outcome.kind).toBe("restarted");
    expect(fake.signalled).toEqual([{ pid: 777, signal: "SIGTERM" }]);
  });

  test("with no pid from either source, it refuses rather than guessing", async () => {
    const fake = fakeProbes({
      serving: [serving({ pid: null })],
      portHolderPid: null,
    });

    expect(await resolveRestart(PORT, fake.probes)).toEqual({ kind: "pid-unresolved" });
    expect(fake.signalled).toEqual([]);
  });

  test("a signal that never produces a replacement is NOT reported as a restart", async () => {
    // The failure this confirmation step exists for: under a manual `cockpit
    // start` there is no supervisor, so the daemon stops and stays stopped.
    // Reporting "restarted" here — which is what returning on the kill alone
    // would do — would be a false completion claim.
    const fake = fakeProbes({ serving: [serving(), null], alive: false });

    const outcome = await resolveRestart(PORT, fake.probes);

    expect(outcome).toEqual({ kind: "stopped", pid: 100 });
  });

  test("a daemon that ignores SIGTERM is reported as still-running", async () => {
    const fake = fakeProbes({ serving: [serving()], alive: true });
    expect(await resolveRestart(PORT, fake.probes)).toEqual({ kind: "still-running", pid: 100 });
  });

  test("a refused or failed signal is surfaced, not swallowed", async () => {
    // The identity primitive collapses "the live command line no longer matches"
    // and "kill() itself failed" into one false. Neither is recoverable here, and
    // both must reach the operator rather than being read as a restart.
    const fake = fakeProbes({ serving: [serving()], signalRefused: "identity refused" });
    const outcome = await resolveRestart(PORT, fake.probes);
    expect(outcome).toEqual({ kind: "signal-failed", pid: 100, reason: "identity refused" });
    expect(fake.signalled).toEqual([]);
  });

  test("stop surfaces a refused signal too", async () => {
    const fake = fakeProbes({ serving: [serving()], signalRefused: "pid reused" });
    expect(await resolveStop(PORT, fake.probes)).toEqual({
      kind: "signal-failed",
      pid: 100,
      reason: "pid reused",
    });
  });

  test("the respawn gap is not mistaken for a completed restart", async () => {
    // A null read means the port is momentarily dead, which happens on the way
    // to a successful respawn. Treating it as terminal would report a restart
    // before a replacement existed.
    const fake = fakeProbes({
      serving: [serving(), null, null, null, serving({ pid: 300, processStartedAtMs: 5_000 })],
    });

    const outcome = await resolveRestart(PORT, fake.probes);

    expect(outcome.kind).toBe("restarted");
    if (outcome.kind === "restarted") {
      expect(outcome.waitedMs).toBe(RESTART_POLL_INTERVAL_MS * 4);
    }
  });
});

describe("resolveStop (mt#4232)", () => {
  test("reports a genuine stop when nothing brings it back", async () => {
    const fake = fakeProbes({ serving: [serving(), null], alive: false });
    expect(await resolveStop(PORT, fake.probes)).toEqual({ kind: "stopped", pid: 100 });
  });

  test("a supervisor respawn is reported as a restart, never as a stop", async () => {
    // The spec's stated concern: "a stop that is silently undone is worse than a
    // refusal." The undoing is fine; reporting it as a stop is not.
    const fake = fakeProbes({
      serving: [serving(), null, serving({ pid: 400, processStartedAtMs: 8_000 })],
    });

    const outcome = await resolveStop(PORT, fake.probes);

    expect(outcome.kind).toBe("restarted");
  });

  test("a brief dead window does not short-circuit into a false 'stopped'", async () => {
    // Same edge as the restart case, and it matters MORE here: "stopped" is the
    // success wording, so an early return would report success on a daemon the
    // tray was about to bring back.
    const fake = fakeProbes({
      serving: [serving(), null, null, serving({ pid: 401, processStartedAtMs: 9_000 })],
      alive: false,
    });

    expect((await resolveStop(PORT, fake.probes)).kind).toBe("restarted");
  });

  test("a foreign service is not signalled by stop either", async () => {
    const fake = fakeProbes({ serving: [serving({ service: "something-else" })] });
    expect((await resolveStop(PORT, fake.probes)).kind).toBe("foreign-service");
    expect(fake.signalled).toEqual([]);
  });
});

describe("describeOutcome (mt#4232)", () => {
  test("the same outcome reads as success for one operation and failure for the other", () => {
    const restarted = { kind: "restarted", pid: 5, waitedMs: 3_000 } as const;
    expect(describeOutcome(restarted, "restart", PORT).failed).toBe(false);
    // A respawn during a STOP is a failure to stop, and must say so.
    expect(describeOutcome(restarted, "stop", PORT).failed).toBe(true);

    const stopped = { kind: "stopped", pid: 5 } as const;
    expect(describeOutcome(stopped, "stop", PORT).failed).toBe(false);
    // Stopping without a replacement is a failure to RESTART.
    expect(describeOutcome(stopped, "restart", PORT).failed).toBe(true);
  });

  test("the stop-was-undone message names how to actually stop it", () => {
    const { message } = describeOutcome({ kind: "restarted", pid: 5, waitedMs: 1 }, "stop", PORT);
    expect(message).toContain("supervisor restarted it");
    expect(message).toContain("tray menu");
  });

  test("every outcome kind produces a non-empty message", () => {
    const kinds = [
      { kind: "not-running" },
      { kind: "foreign-service", service: "x" },
      { kind: "pid-unresolved" },
      { kind: "restarted", pid: 1, waitedMs: 1 },
      { kind: "stopped", pid: 1 },
      { kind: "still-running", pid: 1 },
      { kind: "signal-failed", pid: 1, reason: "boom" },
    ] as const;

    for (const outcome of kinds) {
      for (const op of ["restart", "stop"] as const) {
        expect(describeOutcome(outcome, op, PORT).message.length).toBeGreaterThan(0);
      }
    }
  });
});
