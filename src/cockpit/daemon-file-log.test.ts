/**
 * Tests for the cockpit daemon rotating file logger (mt#2894).
 *
 * Does NOT assert against the real `~/.local/state/minsky/logs/` path — the
 * module resolves its directory from `getStateDir()`, which honors
 * `MINSKY_STATE_DIR`. Tests point that env var at a scratch tmp dir so the
 * suite never touches (or depends on) the operator's real state directory.
 *
 * This suite deliberately uses the REAL filesystem (a scratch tmp dir, never
 * the operator's actual `~/.local/state/minsky/`) rather than a mocked `fs`
 * — the property under test IS "does winston's File transport actually
 * write bytes to disk and rotate," which a mock would tautologically assert
 * away. Each real-fs call below carries an eslint-disable with that
 * justification per project convention (see sweepers.test.ts for the same
 * pattern applied to its own real-timer-based assertions).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- see file-level docblock: this suite verifies a real winston File-transport write, which a mocked fs would tautologically assert away
import fs from "fs";
import os from "os";
import path from "path";
import {
  installDaemonFileLogging,
  getDaemonLogFilePath,
  _resetDaemonFileLoggingForTest,
} from "./daemon-file-log";
import { log } from "@minsky/shared/logger";
import { _resetDefaultLoggerForTests } from "@minsky/shared/logger";

/**
 * Poll the rotating log file until it contains `needle`, or give up after
 * `timeoutMs`. Returns the full file content read at whichever point the
 * loop stopped (either the match or the timeout).
 */
async function pollLogFileFor(needle: string, timeoutMs = 2000): Promise<string> {
  const logPath = getDaemonLogFilePath();
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() used for a poll deadline, not path creation; the rule's regex fires on the call pattern but there is no filesystem path interaction here
  const deadline = Date.now() + timeoutMs;
  let content = "";
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same: poll-deadline timing, not path creation
  while (Date.now() < deadline) {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- verifying the REAL rotating file winston wrote; see file-level docblock
    if (fs.existsSync(logPath)) {
      // eslint-disable-next-line custom/no-real-fs-in-tests -- reading back the REAL file winston wrote, the property under test
      content = String(fs.readFileSync(logPath, { encoding: "utf-8" }));
      if (content.includes(needle)) break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return content;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Reads `process.env[name]` from inside a separate function scope so TS's
 * post-`delete` control-flow narrowing (which otherwise pins a literal
 * `process.env.FOO` access to type `undefined` for the rest of the
 * enclosing scope) can't apply.
 */
function readEnv(name: string): string | undefined {
  return process.env[name];
}

let scratchDir: string;
let prevStateDir: string | undefined;
let prevEnableAgentLogs: string | undefined;

beforeEach(() => {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- real scratch tmp dir, isolated per test via mkdtempSync's unique suffix, never the operator's real state dir; needed to exercise a real winston File-transport write
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-daemon-log-test-"));
  prevStateDir = process.env.MINSKY_STATE_DIR;
  prevEnableAgentLogs = process.env.ENABLE_AGENT_LOGS;
  process.env.MINSKY_STATE_DIR = scratchDir;
  _resetDaemonFileLoggingForTest();
  _resetDefaultLoggerForTests();
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
  else process.env.MINSKY_STATE_DIR = prevStateDir;
  if (prevEnableAgentLogs === undefined) delete process.env.ENABLE_AGENT_LOGS;
  else process.env.ENABLE_AGENT_LOGS = prevEnableAgentLogs;
  _resetDaemonFileLoggingForTest();
  _resetDefaultLoggerForTests();
  try {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- cleanup for the real scratch dir created in beforeEach above
    fs.rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("installDaemonFileLogging (mt#2894)", () => {
  test("creates the log directory and a log.warn call is written to the rotating file", async () => {
    installDaemonFileLogging();
    log.warn("cockpit: test daemon-file-log message", { probe: true });

    const content = await pollLogFileFor("test daemon-file-log message");
    expect(content).toContain("test daemon-file-log message");
    // Structured JSON with a real timestamp — not the colorized plain-text
    // programLogFormat that would otherwise leak ANSI codes into the file.
    expect(content).toContain('"timestamp"');
  });

  test("is idempotent — a second call does not throw or double-install", () => {
    installDaemonFileLogging();
    expect(() => installDaemonFileLogging()).not.toThrow();
  });

  test("sets ENABLE_AGENT_LOGS so log.warn is no longer a silent no-op", () => {
    delete process.env.ENABLE_AGENT_LOGS;
    installDaemonFileLogging();
    expect(readEnv("ENABLE_AGENT_LOGS")).toBe("true");
  });

  // ── PR #2019 R1 BLOCKING #3: env var alone is not enough — must reinit ────

  test("a log call that happened BEFORE installDaemonFileLogging() does not permanently defeat it — a call AFTER still persists", async () => {
    // Force the shared logger singleton to initialize NOW, with
    // ENABLE_AGENT_LOGS unset — reproduces "something already called log.*
    // earlier in the process" (e.g. CLI bootstrap code, before `cockpit
    // start`'s action handler runs installDaemonFileLogging()).
    delete process.env.ENABLE_AGENT_LOGS;
    log.warn("cockpit: pre-install message (must not appear in the file)");

    installDaemonFileLogging();

    // Without reinitializeDefaultLoggerFromEnv() inside installDaemonFileLogging(),
    // this call would ALSO be dropped — the singleton's wrapper closures had
    // already baked in enableAgentLogs=false at the pre-install log.warn above.
    log.warn("cockpit: post-install message (must persist)");

    const content = await pollLogFileFor("post-install message");
    expect(content).toContain("post-install message");
    // The pre-install call genuinely never reached agentLogger (it was a
    // no-op under the old singleton) — confirms this isn't a case where the
    // file transport just wasn't attached yet at the time of the write.
    expect(content).not.toContain("pre-install message");
  });

  // ── PR #2019 R1 NON-BLOCKING #4: one transport attachment, no duplicate lines ─

  test("a single log.warn call (agentLogger) produces exactly one line in the file — no duplication from a second attachment", async () => {
    installDaemonFileLogging();
    log.warn("cockpit: dedup-check message");

    const content = await pollLogFileFor("dedup-check message");
    expect(countOccurrences(content, "dedup-check message")).toBe(1);
  });

  test("a log.cli call (programLogger-routed) is not written to the file — only agentLogger is attached", async () => {
    installDaemonFileLogging();
    // log.warn/info/debug/error all route through agentLogger once
    // ENABLE_AGENT_LOGS is set; log.cli* is the ONLY surface that still
    // targets programLogger — confirms the file transport is attached to
    // agentLogger alone (not both), per the R1 fix.
    log.cli("cockpit: program-logger-only message");
    log.warn("cockpit: agent-logger sentinel message");

    // Wait for the sentinel (agentLogger-routed, definitely written) so we
    // know the file write has settled before checking the cli message's
    // absence.
    const content = await pollLogFileFor("agent-logger sentinel message");
    expect(content).not.toContain("program-logger-only message");
  });
});
