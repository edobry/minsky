#!/usr/bin/env bun
/**
 * Fixture inner server for mt#4112's out-of-process ceiling tests.
 *
 * Stands in for `minsky mcp start` under `minsky mcp proxy`. Every run appends
 * its own pid to `MT4112_PIDFILE`, which is how the test observes which child is
 * serving — see the note on that file in `child-memory-restart.test.ts`.
 *
 * Two modes, chosen by whether this is the FIRST run (the pid file was empty):
 *
 * - **First run (pid file empty)** — allocates past the test's
 *   ceiling, then spins in a tight SYNCHRONOUS loop. This is the case the whole
 *   task exists for: the event loop never turns, so no timer, no `process.on`
 *   handler and no SIGTERM handler in this process can run. Only SIGKILL, sent
 *   by another process, ends it.
 * - **Later runs (pid file non-empty)** — a healthy server: answers any JSON-RPC
 *   request with an empty result and otherwise idles. This is what the proxy's
 *   respawn produces, so a test can assert the replacement actually serves.
 *
 * Selecting on the pid file is what makes the two-phase test deterministic: the
 * respawned child inherits the same environment, so mode cannot be chosen by an
 * env var alone.
 *
 * **Self-termination is deliberate and must stay.** The spin loop checks a
 * wall-clock deadline on every iteration, because a `setTimeout` could not fire
 * here. Without it, a test killed mid-run would leave a process spinning at 100%
 * CPU holding hundreds of MB — which is the exact incident (mt#4098) that
 * produced this task.
 */

/* eslint-disable custom/no-real-fs-in-tests -- see the note directly below */
/*
 * This file lives under `tests/` but is NOT a test: it is a standalone program
 * the integration test spawns as a real OS process, standing in for
 * `minsky mcp start`. The rule's concern — tests interfering with each other
 * through shared real filesystem state — does not apply to a subprocess whose
 * only filesystem touch is a marker path the test hands it inside that test's
 * own `mkdtemp` directory. Nor could an injected mock reach here: this code
 * runs in a different process from the test that spawns it. Its `Date.now()`
 * uses are a wall-clock deadline, not path construction.
 */

import { appendFileSync, existsSync, readFileSync } from "fs";

/** Hard ceiling on this fixture's lifetime, whatever the test does. */
const SELF_TERMINATE_AFTER_MS = 60_000;
/** One allocation chunk. */
const CHUNK_BYTES = 16 * 1024 * 1024;
/**
 * Non-zero fill byte, and it is load-bearing.
 *
 * `Buffer.alloc` zero-fills, but a fresh anonymous mapping is already zero, so
 * the runtime can satisfy it without touching a single page — measured here:
 * 128MB allocated read as a **9MB** `phys_footprint`, and 137MB only after
 * filling with a non-zero byte. An allocate-only fixture would therefore sit
 * far under any realistic ceiling and the test would report "the guard never
 * fired" while testing nothing.
 */
const FILL_BYTE = 0x41;
/** Chunks to hold. 24 x 16MB = 384MB, comfortably past the tests' 200MB ceiling. */
const CHUNK_COUNT = 24;

/**
 * Announce this run's pid, and read how many runs preceded it.
 *
 * The pid file does double duty: it is the test's only handle on which process
 * is currently serving (no `ps` parsing, so nothing depends on a platform's
 * `ps` flavour), and its emptiness is what selects allocate-and-wedge mode.
 */
function announceRunAndCountPriors(): number {
  const pidFile = process.env.MT4112_PIDFILE;
  if (pidFile === undefined) return 0;
  const prior = existsSync(pidFile) ? String(readFileSync(pidFile, "utf-8")) : "";
  const priorRuns = prior.split("\n").filter((line) => line.trim() !== "").length;
  appendFileSync(pidFile, `${process.pid}\n`);
  return priorRuns;
}

const alreadyRan = announceRunAndCountPriors() > 0;

/**
 * Install the same signal handlers `mcp start` does
 * (`src/commands/mcp/start-command.ts`), and this is the detail that makes the
 * fixture faithful rather than merely slow.
 *
 * With NO handler registered, SIGTERM's OS default action terminates the
 * process immediately — no JS involvement, so a wedged event loop is no
 * obstacle. Registering one REPLACES that default with "queue a JS callback",
 * which a wedged loop can never run. That is precisely why the 2026-08-13
 * specimens "ignored SIGTERM" and needed SIGKILL.
 *
 * Measured: without these handlers the fixture died 203ms after crossing the
 * ceiling, and the test passed — while exercising none of the escalation it
 * exists to check.
 */
function installUnrunnableSignalHandlers(): void {
  const noop = () => {
    /* never runs once the loop below wedges — that is the point */
  };
  process.on("SIGTERM", noop);
  process.on("SIGINT", noop);
  process.on("SIGHUP", noop);
}

if (!alreadyRan) {
  installUnrunnableSignalHandlers();

  // Retained so nothing is collected. Allocation happens BEFORE the spin so the
  // breach is measurable within a poll tick or two rather than after a delay.
  const held: Uint8Array[] = [];
  for (let i = 0; i < CHUNK_COUNT; i += 1) {
    const chunk = new Uint8Array(CHUNK_BYTES);
    // Touch every page — see FILL_BYTE. Without this the allocation is not
    // charged to the process and the ceiling has nothing to see.
    chunk.fill(FILL_BYTE);
    held.push(chunk);
  }
  // Keep a reference the optimizer cannot drop.
  // eslint-disable-next-line custom/no-excessive-as-unknown -- stashing on globalThis is the point; there is no typed slot for it
  (globalThis as unknown as { __mt4112Held: Uint8Array[] }).__mt4112Held = held;

  const deadline = Date.now() + SELF_TERMINATE_AFTER_MS;
  while (true) {
    if (Date.now() > deadline) process.exit(0);
  }
}

// Healthy mode: minimal JSON-RPC responder over stdin/stdout.
let buffered = "";
process.stdin.on("data", (chunk: Buffer | string) => {
  buffered += String(chunk);
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const message = JSON.parse(line) as { id?: unknown; method?: unknown };
      if (message.id === undefined) continue;
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
    } catch {
      // Not JSON — the proxy pipes raw bytes, so ignoring is the right response.
    }
  }
});

// Do not outlive the test run even in healthy mode.
setTimeout(() => process.exit(0), SELF_TERMINATE_AFTER_MS).unref();
// Keep the process alive while stdin is open. `resume` is absent from this
// project's narrowed ambient `process.stdin` type, the same gap `proxy.ts`
// works around at its own pipe wiring.
// eslint-disable-next-line custom/no-excessive-as-unknown -- the runtime method exists; the ambient type omits it, same as proxy.ts
(process.stdin as unknown as { resume: () => void }).resume();
