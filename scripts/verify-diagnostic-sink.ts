#!/usr/bin/env bun
/**
 * mt#2464 — verify that domain-channel diagnostics reach a captured-stderr process, and that
 * STDOUT stays clean.
 *
 * Why this needs subprocesses rather than a unit test: the property under test is a claim about
 * real file descriptors. `resolveDiagnosticSink` is unit-tested for the decision, and the logger
 * exposes the sink it wired — but neither observes an actual write landing on fd 2 and not fd 1.
 * Spawning with piped stdio is what makes `isTTY` false the same way a container does, and it is
 * the only shape in which "stdout was not polluted" is a measurement instead of an inference.
 *
 * The stdout assertion is the load-bearing half. A regression that put these lines on stdout would
 * corrupt a piped CLI payload and the MCP stdio JSON-RPC stream — see `resolveDiagnosticSink`.
 *
 * Both branches run. Checking only the emit branch could not distinguish "routes correctly" from
 * "always emits", and always-emits means every interactive CLI command gets noisier.
 *
 * Usage:
 *   bun scripts/verify-diagnostic-sink.ts            # run the check (exit 0 pass, 1 fail)
 *   bun scripts/verify-diagnostic-sink.ts --emit     # child mode: emit the probe lines
 *
 * No env vars, no network, no external service — runnable anywhere the repo builds.
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";

const PAYLOAD = "MT2464-PAYLOAD-ON-STDOUT";
const INFO_LINE = "mt2464-probe: info line";
const WARN_LINE = "mt2464-probe: warn line";

// --- child mode -------------------------------------------------------------------------------

if (process.argv.includes("--emit")) {
  const { log } = await import("@minsky/shared/logger");

  // Stands in for a CLI payload / the MCP stdio protocol stream: the thing that must not be
  // interleaved with diagnostics.
  process.stdout.write(`${PAYLOAD}\n`);

  log.info(INFO_LINE, { probe: "info" });
  log.warn(WARN_LINE, { probe: "warn" });
  process.exit(0);
}

// --- parent mode ------------------------------------------------------------------------------

const failures: string[] = [];

/**
 * Assert the DEFAULT posture. Inheriting either of these from the caller's shell would let a
 * developer's own environment decide the result, which is how a check stops measuring anything.
 */
const NEUTRAL_ENV = { ...process.env, MINSKY_LOG_MODE: "", ENABLE_AGENT_LOGS: "" };

// --- branch 1: stderr captured (container, CI, MCP stdio child) -> lines must appear on stderr --

let stdout = "";
let stderr = "";
let childExitCode: number | null = null;

try {
  const child = Bun.spawnSync({
    cmd: ["bun", import.meta.path, "--emit"],
    // Piped stdio, so the child's stderr is not a TTY — the same condition a deployed container
    // has.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    env: NEUTRAL_ENV,
  });
  stdout = child.stdout.toString();
  stderr = child.stderr.toString();
  childExitCode = child.exitCode;
} catch (error) {
  console.error(`FAIL: could not spawn the probe child: ${(error as Error).message}`);
  process.exit(1);
}

if (!stderr.includes(INFO_LINE)) {
  failures.push("log.info did not reach stderr");
}
if (!stderr.includes(WARN_LINE)) {
  failures.push("log.warn did not reach stderr");
}
if (!stderr.includes("info:") || !stderr.includes("warn:")) {
  failures.push("stderr lines carry no level prefix (a warn is indistinguishable from an info)");
}
if (!stdout.includes(PAYLOAD)) {
  failures.push("the child's own stdout payload went missing");
}
if (stdout.includes(INFO_LINE) || stdout.includes(WARN_LINE)) {
  failures.push("diagnostics leaked onto STDOUT — this corrupts piped CLI output and MCP stdio");
}
// The payload must be ALONE on stdout: any extra line is contamination even if it is not one of
// the probe strings above.
const strayStdout = stdout
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && line !== PAYLOAD);
if (strayStdout.length > 0) {
  failures.push(`unexpected extra stdout line(s): ${JSON.stringify(strayStdout.slice(0, 3))}`);
}

// --- branch 2: a real terminal -> the same lines must stay silent -------------------------------
//
// This needs a genuine pty, because the branch turns on `process.stderr.isTTY`, and setting that
// property by hand would test the harness rather than the runtime. `script(1)` cannot help: it
// clones termios from ITS OWN stdin, so it exits "Operation not supported on socket" whenever the
// caller is not already at a terminal (an agent session, CI). `pty.openpty()` carries no such
// requirement, which is why this shells out to Python instead of reusing `script`.
//
// SKIPs rather than fails when python3 is absent — the branch-1 assertions are the ones this
// script exists to enforce, and they need nothing extra.

const PTY_PROBE = `
import os, pty, subprocess, sys
master, slave = pty.openpty()
p = subprocess.Popen(sys.argv[1:], stdout=slave, stderr=slave, stdin=slave, close_fds=True)
os.close(slave)
out = b""
while True:
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
p.wait()
sys.stdout.write(out.decode(errors="replace"))
`;

let ptyBranch: string;
try {
  const pty = Bun.spawnSync({
    cmd: ["python3", "-c", PTY_PROBE, "bun", import.meta.path, "--emit"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    env: NEUTRAL_ENV,
  });

  if (pty.exitCode !== 0) {
    ptyBranch = `SKIP: pty probe exited ${pty.exitCode} (${safeTruncate(pty.stderr.toString().trim(), 200)})`;
  } else {
    const ptyOut = pty.stdout.toString();
    if (!ptyOut.includes(PAYLOAD)) {
      failures.push("pty probe produced no payload — the child did not run under the pty");
      ptyBranch = "FAIL";
    } else if (ptyOut.includes(INFO_LINE) || ptyOut.includes(WARN_LINE)) {
      failures.push(
        "diagnostics printed at a real terminal — the discard branch regressed, and every " +
          "interactive CLI command just got noisier"
      );
      ptyBranch = "FAIL";
    } else {
      ptyBranch = "PASS (quiet at a real terminal)";
    }
  }
} catch (error) {
  ptyBranch = `SKIP: python3 unavailable (${(error as Error).message})`;
}

// --- report -------------------------------------------------------------------------------------

console.log(
  JSON.stringify(
    {
      check: "mt2464-diagnostic-sink",
      capturedStderrBranch: failures.length === 0 ? "PASS" : "see failures",
      ptyBranch,
      childExitCode,
      stdoutLines: stdout.split("\n").filter((l) => l.trim().length > 0).length,
      stderrLines: stderr.split("\n").filter((l) => l.trim().length > 0).length,
      stderrSample: stderr.trim().split("\n").slice(0, 4),
      stdoutSample: stdout.trim().split("\n").slice(0, 4),
      failures,
      result: failures.length === 0 ? "PASS" : "FAIL",
    },
    null,
    2
  )
);

process.exit(failures.length === 0 ? 0 : 1);
