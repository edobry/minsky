#!/usr/bin/env bun
/**
 * Exercise the two OS interfaces the tray's memory ceiling rests on, against a
 * process that is genuinely wedged (mt#4105).
 *
 * The tray's enforcement is Rust and lives inside a supervisor poll loop, so
 * unit tests can only reach its pure parts. What they cannot answer is the
 * premise the whole design rests on:
 *
 *   1. Can `footprint(1)` measure a process whose event loop is BLOCKED?
 *      (The in-process watcher cannot — it is a `setInterval` on that loop.)
 *   2. Does SIGTERM fail against such a process, so SIGKILL is actually needed?
 *
 * This script answers both live. It does NOT exercise the tray's poll loop —
 * see `## Live verification` in the PR for what that would take.
 *
 * Two traps this deliberately avoids, both from mem#1021:
 *
 * - **`Buffer.alloc` does not dirty pages.** 128 MB allocated read as a 9 MB
 *   footprint; only a non-zero FILL charges them to the task. A version of this
 *   script that skipped the fill would measure nothing and still pass.
 * - **A process with NO SIGTERM handler dies on SIGTERM even when wedged** — the
 *   kernel's default action needs no JS. So the child below REGISTERS one,
 *   mirroring `src/commands/mcp/start-command.ts:2132-2134`. That is what makes
 *   the SIGTERM-survives check meaningful rather than a coin flip.
 *
 * Bounded on purpose: the child allocates at most `ALLOC_MB` and the test
 * ceiling is far below the 2048 MB production value, so a failing run cannot
 * become the runaway this task exists to prevent.
 */

import { spawn } from "child_process";

const ALLOC_MB = 300;
const TEST_CEILING_BYTES = 150 * 1024 * 1024;
const GROWTH_TIMEOUT_MS = 20_000;
const SIGTERM_GRACE_MS = 2_000;

if (process.platform !== "darwin") {
  process.stdout.write(
    "SKIP: footprint(1) is macOS-only; the Linux path reads /proc/<pid>/status\n"
  );
  process.exit(0);
}

/** The child: allocate and DIRTY memory, then block the loop forever. */
const CHILD = `
  process.on("SIGTERM", () => process.exit(0));
  const chunks = [];
  for (let i = 0; i < ${ALLOC_MB}; i++) {
    const b = Buffer.alloc(1024 * 1024);
    b.fill(i % 251 + 1);
    chunks.push(b);
  }
  console.log("allocated");
  while (true) {} // wedge the event loop — no timer or handler can run past here
`;

/** Read `phys_footprint` the same way the Rust supervisor does. */
function footprintBytes(pid: number): number | null {
  const proc = Bun.spawnSync(["/usr/bin/footprint", "-f", "bytes", "-p", String(pid)]);
  if (!proc.success) return null;
  for (const line of proc.stdout.toString().split("\n")) {
    const [label, rest] = line.split(":", 2);
    if (label?.trim() !== "phys_footprint") continue;
    const digits = (rest ?? "").trim().match(/^\d+/)?.[0];
    if (digits) return Number(digits);
  }
  return null;
}

/**
 * Whether the pid still exists in the process table.
 *
 * NOT the same as "still running": a killed child of THIS process becomes a
 * zombie until reaped, and `kill(pid, 0)` succeeds on a zombie. The first live
 * run of this script failed on exactly that — `goneAfterSigkill: false` for a
 * child that was already dead. Use [`waitForExit`] to ask whether it DIED; this
 * is only for the best-effort cleanup in `finally`.
 *
 * The supervisor does not have this problem: it owns a `std::process::Child` and
 * calls `try_wait()` every poll, which reaps.
 */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve true if the child is reaped within `ms`, false on timeout. */
function waitForExit(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const child = spawn("bun", ["-e", CHILD], { stdio: ["ignore", "pipe", "pipe"] });
const pid = child.pid;
if (!pid) {
  process.stderr.write("FAIL: could not spawn the child\n");
  process.exit(1);
}

const failures: string[] = [];
const record: Record<string, unknown> = { pid, ceilingBytes: TEST_CEILING_BYTES };

try {
  // (1) The reader sees a wedged process grow past the ceiling.
  const deadline = Date.now() + GROWTH_TIMEOUT_MS;
  let peak = 0;
  while (Date.now() < deadline) {
    const bytes = footprintBytes(pid);
    if (bytes !== null) peak = Math.max(peak, bytes);
    if (peak > TEST_CEILING_BYTES) break;
    Bun.sleepSync(250);
  }
  record["peakBytes"] = peak;
  record["crossedCeiling"] = peak > TEST_CEILING_BYTES;
  if (peak <= TEST_CEILING_BYTES) {
    failures.push(
      `footprint never read past the ceiling (peak ${peak} <= ${TEST_CEILING_BYTES}); ` +
        `the reader cannot see a wedged process grow`
    );
  }

  // (2) The wedge is real: SIGTERM is registered but cannot run, so it survives.
  //     This is the control — without it, (3) proves only that kill works.
  process.kill(pid, "SIGTERM");
  const exitedOnSigterm = await waitForExit(SIGTERM_GRACE_MS);
  record["survivedSigterm"] = !exitedOnSigterm;
  if (exitedOnSigterm) {
    failures.push(
      "the child exited on SIGTERM, so its loop was not actually wedged — " +
        "this run proves nothing about the case the ceiling exists for"
    );
  }

  // (3) SIGKILL removes it, needing no cooperation.
  process.kill(pid, "SIGKILL");
  const goneAfterSigkill = await waitForExit(5_000);
  record["goneAfterSigkill"] = goneAfterSigkill;
  if (!goneAfterSigkill) failures.push("the child survived SIGKILL");
} finally {
  if (pidExists(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone between the check and the signal — nothing to clean up.
    }
  }
}

process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`FAIL: ${f}\n`);
  process.exit(1);
}
process.stdout.write(
  "PASS: a wedged process is measurable by footprint, survives SIGTERM, dies on SIGKILL\n"
);
process.exit(0);
