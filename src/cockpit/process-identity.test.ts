/**
 * Tests for ./process-identity.ts's PID probes (mt#4255).
 *
 * The module had no test file before this: its original two functions are
 * exercised only indirectly, through the resume path's orphan cleanup. The
 * four-way probe added here decides whether a persisted row gets RETIRED, so
 * its boundaries are asserted directly — particularly the ones that must fail
 * OPEN, which are invisible from the caller's side once collapsed.
 *
 * @see ./process-identity.ts
 * @see ./driven-session-launch-persistence.test.ts — the consuming boot loop
 */

import { describe, test, expect } from "bun:test";

import {
  probeProcessIdentity,
  readPidPresence,
  type ExecFileFn,
  type PidPresence,
} from "./process-identity";

/** An `execFileFn` that returns a fixed command line, and records its calls. */
function fakePs(stdout: string) {
  const calls: { command: string; args: string[] }[] = [];
  const execFileFn: ExecFileFn = async (command, args) => {
    calls.push({ command, args });
    return { stdout, stderr: "" };
  };
  return { calls, execFileFn };
}

const CLAUDE_CMDLINE = "claude -p --input-format stream-json --output-format stream-json";

describe("readPidPresence", () => {
  test("a pid that is not a positive integer is absent, never a probe", () => {
    // Guards the caller from ever passing one of these to `kill`.
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(readPidPresence(pid)).toBe("absent");
    }
  });

  test("this very process is present", () => {
    // The only PID a test can assert about without racing anything: it is
    // running the assertion.
    expect(readPidPresence(process.pid)).toBe("present");
  });

  test("a pid above any platform maximum is absent", () => {
    // 2^30 exceeds the pid ceiling on both macOS (99998) and Linux's default
    // and maximum `pid_max` (4194304), so the kernel answers ESRCH rather than
    // this racing some unrelated process that happens to hold the number.
    expect(readPidPresence(1_073_741_824)).toBe("absent");
  });
});

describe("probeProcessIdentity", () => {
  test("an absent pid is `gone`, and the command line is never read", async () => {
    // The ordering guarantee the rest of the contract rests on. Reading a
    // command line for a PID the kernel says does not exist could only produce
    // a failure, which would then be indistinguishable from a broken probe.
    const { calls, execFileFn } = fakePs(CLAUDE_CMDLINE);
    const verdict = await probeProcessIdentity(4242, CLAUDE_CMDLINE, {
      readPresence: () => "absent",
      execFileFn,
    });
    expect(verdict).toBe("gone");
    expect(calls).toHaveLength(0);
  });

  test("a live process whose command line still matches is `ours`", async () => {
    const { execFileFn } = fakePs(CLAUDE_CMDLINE);
    const verdict = await probeProcessIdentity(4242, CLAUDE_CMDLINE, {
      readPresence: () => "present",
      execFileFn,
    });
    expect(verdict).toBe("ours");
  });

  test("a live process whose command line does NOT match is `not-ours`", async () => {
    // PID reuse. Observed on prod 2026-08-18: a row's recorded pid was alive as
    // BeeperDesktop's ContactsServer, 18 days after the `claude` child that
    // originally held the number exited.
    const { execFileFn } = fakePs(
      "/Applications/BeeperDesktop.app/Contents/Resources/app.asar.unpacked/build/ContactsServer"
    );
    const verdict = await probeProcessIdentity(1119, CLAUDE_CMDLINE, {
      readPresence: () => "present",
      execFileFn,
    });
    expect(verdict).toBe("not-ours");
  });

  test("presence the kernel could not determine is `unknown`, not `gone`", async () => {
    // The distinction this whole function exists for. Collapsing it — which is
    // what `verifyProcessIdentity` does, correctly, for the kill path — would
    // let a caller retire every row in the table the first time `kill` returned
    // an errno nobody anticipated.
    const verdict = await probeProcessIdentity(4242, CLAUDE_CMDLINE, {
      readPresence: () => "unknown",
      execFileFn: fakePs(CLAUDE_CMDLINE).execFileFn,
    });
    expect(verdict).toBe("unknown");
  });

  test("a command line that cannot be read for a PRESENT pid is `unknown`", async () => {
    // The kernel already confirmed the process exists, so a failure here is our
    // probe's, not evidence about the process.
    const throwingPs: ExecFileFn = async () => {
      throw new Error("ps: command not found");
    };
    const verdict = await probeProcessIdentity(4242, CLAUDE_CMDLINE, {
      readPresence: () => "present",
      execFileFn: throwingPs,
    });
    expect(verdict).toBe("unknown");
  });

  test("an EMPTY command line for a present pid is `unknown`, not `not-ours`", async () => {
    // A blank read says nothing about identity, and calling it `not-ours` would
    // retire a row on no evidence at all.
    const { execFileFn } = fakePs("   \n");
    const verdict = await probeProcessIdentity(4242, CLAUDE_CMDLINE, {
      readPresence: () => "present",
      execFileFn,
    });
    expect(verdict).toBe("unknown");
  });

  test("matching is a SUBSTRING check, so the bare binary name works as a fallback", async () => {
    // `driven-session-launch.ts` passes `row.pidCmdline ?? CLAUDE_BINARY`; a row
    // predating cmdline capture falls back to the binary name, which must still
    // match a full live argv.
    const { execFileFn } = fakePs(CLAUDE_CMDLINE);
    const verdict = await probeProcessIdentity(4242, "claude", {
      readPresence: () => "present",
      execFileFn,
    });
    expect(verdict).toBe("ours");
  });

  test("every presence value maps to a verdict — none falls through", async () => {
    const presences: PidPresence[] = ["present", "absent", "unknown"];
    for (const presence of presences) {
      const verdict = await probeProcessIdentity(4242, CLAUDE_CMDLINE, {
        readPresence: () => presence,
        execFileFn: fakePs(CLAUDE_CMDLINE).execFileFn,
      });
      expect(["ours", "not-ours", "gone", "unknown"]).toContain(verdict);
    }
  });
});
