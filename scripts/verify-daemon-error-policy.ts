#!/usr/bin/env bun
/**
 * Process-level exercise of the cockpit daemon's uncaught-exception policy
 * (mt#3626), using the SAME `daemon-error-policy` module the daemon wires in.
 *
 * Unit tests assert the predicate; this asserts the thing that actually matters
 * — whether a real Bun process survives a real uncaught throw — by installing
 * the handler shape from `start-command.ts` and throwing each class at it.
 *
 * Deliberately NOT a second cockpit daemon. A cockpit daemon runs the sweeper
 * set against the SHARED PRODUCTION database, so a second one double-runs all
 * of it (recorded on mt#3534). This exercises the handler in isolation instead.
 *
 * Usage: bun scripts/verify-daemon-error-policy.ts
 * Exit code: 0 = both cases behaved as specified, non-zero = failure.
 */
import {
  classifyUncaughtException,
  createSurvivedErrorLogger,
  formatErrorForLog,
} from "../src/cockpit/daemon-error-policy";

const MODE = process.argv[2];

/** Mirrors the handler installed in `src/commands/cockpit/start-command.ts`. */
function installHandler(onExit: (code: number) => void): void {
  const logSurvived = createSurvivedErrorLogger((line) => console.log(line));
  // The project's narrowed `process` type omits EventEmitter methods. Cast to a
  // Node-shaped surface for `on` — mirrors the handler this mimics in
  // `src/commands/cockpit/start-command.ts`.
  // eslint-disable-next-line custom/no-excessive-as-unknown
  (process as unknown as { on(e: string, l: (...a: unknown[]) => void): void }).on(
    "uncaughtException",
    (err: unknown) => {
      if (classifyUncaughtException(err) === "survive") {
        logSurvived(err);
        return;
      }
      console.log(`FATAL: ${formatErrorForLog(err)}`);
      onExit(1);
    }
  );
}

/** The mt#3534 class: a runtime-internal socket throw carrying no error code. */
function throwTransientConnectError(): void {
  setTimeout(() => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:1");
    err.stack = [
      "Error: connect ECONNREFUSED 127.0.0.1:1",
      "    at new ExceptionWithHostPort (internal:shared:42:10)",
      "    at afterConnect (node:net:1172:39)",
    ].join("\n");
    throw err;
  }, 10);
}

function throwApplicationBug(): void {
  setTimeout(() => {
    throw new TypeError("genuine application bug — must not be swallowed");
  }, 10);
}

if (MODE === "survive") {
  installHandler((code) => process.exit(code));
  throwTransientConnectError();
  // If the handler swallowed it as specified, this process is still alive to
  // print PROOF and exit 0 of its own accord.
  setTimeout(() => {
    console.log("PROOF: process still alive after a transient connect throw");
    process.exit(0);
  }, 300);
} else if (MODE === "exit") {
  installHandler((code) => process.exit(code));
  throwApplicationBug();
  setTimeout(() => {
    console.log("FAILURE: process survived an application bug — policy is too broad");
    process.exit(2);
  }, 300);
} else {
  // Driver: run both child modes and report.
  const run = async (mode: string): Promise<number> => {
    const proc = Bun.spawn(["bun", import.meta.path, mode], {
      stdout: "inherit",
      stderr: "inherit",
    });
    return await proc.exited;
  };

  const surviveCode = await run("survive");
  console.log(`survive-case exit code: ${surviveCode} (expected 0)`);
  const exitCode = await run("exit");
  console.log(`exit-case exit code: ${exitCode} (expected 1)`);

  const ok = surviveCode === 0 && exitCode === 1;
  console.log(ok ? "PASS: both cases behaved as specified" : "FAIL");
  process.exit(ok ? 0 : 1);
}
