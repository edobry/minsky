#!/usr/bin/env bun
/**
 * Fixture child for `upstream-eof-shutdown.test.ts` (mt#5096).
 *
 * Stands in for `minsky mcp start` with exactly the two behaviours the test
 * needs from an inner server, and nothing else:
 *
 * 1. It announces its pid by appending to the file named by `MT5096_PIDFILE`,
 *    so the test can count how many children the proxy spawned — the loop the
 *    task fixes is visible as a growing pid list.
 * 2. It exits 0 when ITS stdin ends, exactly as the real inner server does on
 *    `stdin_close`. That is the mechanism under test: with the proxy's stdin
 *    at EOF, the pipe propagates `end` here, and the question is whether the
 *    proxy respawns the next one of us or shuts down.
 *
 * It does not answer the proxy's ready probe. The probe times out after
 * `READY_PROBE_TIMEOUT_MS` and `spawnChild` still resolves, so the fixture stays
 * minimal. The `data` listener is what keeps stdin flowing so the probe's
 * write never backs up, and what keeps this process alive until EOF.
 */

/* eslint-disable custom/no-real-fs-in-tests -- see the note directly below */
/*
 * This is a fixture, not a test: a separate OS process spawned by the proxy
 * under test. The pid file is the only channel it has back to the test, and
 * an injected mock cannot cross a process boundary. The path is per-run
 * (`mkdtemp` in the test) so parallel runs cannot collide.
 */
import { appendFileSync } from "fs";

const pidFile = process.env["MT5096_PIDFILE"];
if (!pidFile) {
  process.stderr.write("stdin-eof-child: MT5096_PIDFILE is not set\n");
  process.exit(2);
}
appendFileSync(pidFile, `${process.pid}\n`);

process.stdin.on("data", () => {
  // Consumed and dropped: the ready probe is the only thing the proxy writes.
});
process.stdin.on("end", () => {
  process.exit(0);
});
