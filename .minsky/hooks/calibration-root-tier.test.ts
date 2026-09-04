/**
 * mt#4885 — the two calibration writers put their cwd-derived root in the `fallbackCwd`
 * tier, not `projectDir`.
 *
 * **Why a dedicated file rather than an assertion in each writer's own suite.** The existing
 * suites (`gate-walk-provenance.test.ts`, `require-execution-evidence-before-merge.test.ts`,
 * 264 tests between them) pass IDENTICALLY before and after the fix, because they run with
 * `CLAUDE_PROJECT_DIR` unset — and with an empty top tier, `projectDir: root` and
 * `fallbackCwd: root` resolve to the same path. A test that cannot fail against the defect is
 * not evidence about it (mem#704), so the discriminating condition has to be constructed:
 * `CLAUDE_PROJECT_DIR` SET, to a directory that is not the one the caller passes.
 *
 * Against the pre-fix code every assertion below inverts — the record lands under the passed
 * root because `projectDir` outranks `CLAUDE_PROJECT_DIR`. That is the negative control, and
 * it is recorded in the PR body.
 */
/* eslint-disable custom/no-real-fs-in-tests -- The assertion under test IS the on-disk location a writer resolves to. Injecting a mock fs would move the writes into a fake filesystem and leave the real path-resolution ladder — the only thing this file exists to pin — unexercised, so the rule's remedy would defeat the test. Blast radius is bounded to per-test `mkdtemp` directories under the OS temp dir, with `MINSKY_STATE_DIR` redirected so nothing touches the operator's real calibration streams. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Env var names, extracted so the ladder's two tiers are named once each. */
const STATE_DIR_ENV = "MINSKY_STATE_DIR";
const PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR";

import { calibrationLogPath } from "./dispatcher";
import { appendCalibrationRecord } from "./gate-walk-provenance";
import {
  appendAtCoverageCalibration,
  AT_COVERAGE_STREAM,
} from "./require-execution-evidence-before-merge";

/**
 * `gate-walk-provenance.ts` keeps its stream name module-private, so it is spelled here rather
 * than exported purely for this test. A rename there makes these cases fail (the record is not
 * found under either root), which is the correct signal — not a silent pass.
 */
const GATE_WALK_STREAM = "gate-walk-provenance";

/**
 * Two roots that cannot collapse to one key. Both live under the OS temp dir, which has no
 * `.git` above it, so `findRepoRoot` degrades to its input unchanged (the documented behavior
 * `calibrationLogPath`'s docblock relies on for synthetic paths) and the sha256 keys differ.
 *
 * `authoritativeRoot` stands in for the real project — what `CLAUDE_PROJECT_DIR` names.
 * `callerRoot` stands in for the session-workspace clone a guard's `findRepoRoot(input.cwd)`
 * actually returns.
 */
let stateDir: string;
let authoritativeRoot: string;
let callerRoot: string;
let priorStateDir: string | undefined;
let priorProjectDir: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mt4885-state-"));
  authoritativeRoot = mkdtempSync(join(tmpdir(), "mt4885-project-"));
  callerRoot = mkdtempSync(join(tmpdir(), "mt4885-clone-"));

  priorStateDir = process.env[STATE_DIR_ENV];
  priorProjectDir = process.env[PROJECT_DIR_ENV];
  process.env[STATE_DIR_ENV] = stateDir;
  process.env[PROJECT_DIR_ENV] = authoritativeRoot;
});

afterEach(() => {
  if (priorStateDir === undefined) delete process.env[STATE_DIR_ENV];
  else process.env[STATE_DIR_ENV] = priorStateDir;
  if (priorProjectDir === undefined) delete process.env[PROJECT_DIR_ENV];
  else process.env[PROJECT_DIR_ENV] = priorProjectDir;

  for (const d of [stateDir, authoritativeRoot, callerRoot]) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** Read the one record a writer just appended, resolving the path the READER's own way. */
function readRecordAt(stream: string, root: string): Record<string, unknown> | null {
  const path = calibrationLogPath(stream, { projectDir: root });
  if (!existsSync(path)) return null;
  const body = readFileSync(path, "utf-8").trim();
  if (body === "") return null;
  return JSON.parse(body.split("\n")[0] ?? "{}") as Record<string, unknown>;
}

describe("mt#4885 — cwd-derived roots land in the fallbackCwd tier", () => {
  it("gate-walk-provenance: CLAUDE_PROJECT_DIR outranks the caller's findRepoRoot(input.cwd)", () => {
    appendCalibrationRecord({ marker: "gate-walk" }, callerRoot);

    // The record belongs to the PROJECT, not the clone the guard happened to run in.
    expect(readRecordAt(GATE_WALK_STREAM, authoritativeRoot)?.["marker"]).toBe("gate-walk");
    // The absence half — this is what fails pre-fix, where `projectDir` won.
    expect(readRecordAt(GATE_WALK_STREAM, callerRoot)).toBeNull();
  });

  it("require-execution-evidence: same tier, same outcome", () => {
    appendAtCoverageCalibration({ marker: "at-coverage" }, callerRoot);

    expect(readRecordAt(AT_COVERAGE_STREAM, authoritativeRoot)?.["marker"]).toBe("at-coverage");
    expect(readRecordAt(AT_COVERAGE_STREAM, callerRoot)).toBeNull();
  });

  it("with CLAUDE_PROJECT_DIR unset the caller's root is still used — the tier is a ladder, not a redirect", () => {
    // Guards the OTHER direction: demoting the tier must not break the ordinary case where
    // nothing outranks it. This is also why the fix does NOT by itself stop the stranding
    // mt#4885 documents — that is SC3's separate decision about which root a clone resolves to.
    delete process.env[PROJECT_DIR_ENV];

    appendCalibrationRecord({ marker: "no-project-dir" }, callerRoot);

    expect(readRecordAt(GATE_WALK_STREAM, callerRoot)?.["marker"]).toBe("no-project-dir");
  });
});
