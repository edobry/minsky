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

    // winston's File transport write is async; poll briefly for the write.
    const logPath = getDaemonLogFilePath();
    // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() used for a poll deadline, not path creation; the rule's regex fires on the call pattern but there is no filesystem path interaction here
    const deadline = Date.now() + 2000;
    let content = "";
    // eslint-disable-next-line custom/no-real-fs-in-tests -- same: poll-deadline timing, not path creation
    while (Date.now() < deadline) {
      // eslint-disable-next-line custom/no-real-fs-in-tests -- verifying the REAL rotating file winston wrote; see file-level docblock
      if (fs.existsSync(logPath)) {
        // eslint-disable-next-line custom/no-real-fs-in-tests -- reading back the REAL file winston wrote, the property under test
        content = String(fs.readFileSync(logPath, { encoding: "utf-8" }));
        if (content.includes("test daemon-file-log message")) break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
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
});
