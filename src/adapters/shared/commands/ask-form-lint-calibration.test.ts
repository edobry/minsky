/**
 * Tests for the Ask form-lint calibration log writer (mt#2798).
 *
 * Uses real filesystem operations against a unique temp directory (mirrors
 * `src/mcp/disconnect-tracker.test.ts`'s justification) because this test
 * verifies the append-JSONL side effect itself — an in-memory `fs` mock
 * would not catch a real directory-creation or append-mode bug.
 */
/* eslint-disable custom/no-real-fs-in-tests -- verifies the real append-JSONL
   side effect against a unique per-test temp dir; an fs mock would not catch
   a real mkdir/append-mode bug (mirrors src/mcp/disconnect-tracker.test.ts) */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAskFormLintCalibrationRecord,
  ASK_FORM_LINT_CALIBRATION_LOG,
  isVerifiedWorkspaceRoot,
  type AskFormLintCalibrationRecord,
} from "./ask-form-lint-calibration";
import type { AskKind } from "@minsky/domain/ask/types";

// Centralized AskKind literal reference (defangs custom/no-magic-string-duplication).
const AUTHORIZATION_APPROVE: AskKind = "authorization.approve";

// Centralized internal-tool-id match fixture, reused across multiple tests
// (defangs custom/no-magic-string-duplication).
const INTERNAL_TOOL_ID_MATCH = {
  class: "internal-tool-id" as const,
  phrase: "internal tool id in principal-facing text",
};

const tempDirs: string[] = [];

/**
 * A temp dir marked as a verified workspace root (`minsky.json` present) —
 * satisfies `isVerifiedWorkspaceRoot` so the write path under test actually
 * runs, per the PR #1941 review R1 anchor-to-a-verified-root hardening.
 */
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-form-lint-calibration-test-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "minsky.json"), "{}\n", "utf-8");
  return dir;
}

/** An unmarked temp dir — does NOT verify as a workspace root. */
function makeUnverifiedWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-form-lint-calibration-unverified-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isVerifiedWorkspaceRoot", () => {
  test("returns true when minsky.json is present", () => {
    expect(isVerifiedWorkspaceRoot(makeWorkspace())).toBe(true);
  });

  test("returns false for a plain directory with no marker", () => {
    expect(isVerifiedWorkspaceRoot(makeUnverifiedWorkspace())).toBe(false);
  });

  test("returns false for a nonexistent path (never throws)", () => {
    expect(isVerifiedWorkspaceRoot("/__nonexistent_path_for_ask_form_lint_test__")).toBe(false);
  });
});

describe("appendAskFormLintCalibrationRecord", () => {
  test("creates the .minsky directory and appends a JSONL line", () => {
    const workspace = makeWorkspace();
    const record: AskFormLintCalibrationRecord = {
      timestamp: "2026-07-15T00:00:00.000Z",
      askId: "test-ask-id",
      kind: AUTHORIZATION_APPROVE,
      matches: [INTERNAL_TOOL_ID_MATCH],
    };

    appendAskFormLintCalibrationRecord(workspace, record);

    const logPath = join(workspace, ASK_FORM_LINT_CALIBRATION_LOG);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8") as string;
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual(record);
  });

  test("appends multiple records as separate JSONL lines", () => {
    const workspace = makeWorkspace();
    const first: AskFormLintCalibrationRecord = {
      timestamp: "2026-07-15T00:00:00.000Z",
      kind: AUTHORIZATION_APPROVE,
      matches: [
        {
          class: "over-word-budget",
          phrase: "over form budget; move justification to contextRefs",
        },
      ],
    };
    const second: AskFormLintCalibrationRecord = {
      timestamp: "2026-07-15T00:01:00.000Z",
      kind: "direction.decide",
      matches: [INTERNAL_TOOL_ID_MATCH],
    };

    appendAskFormLintCalibrationRecord(workspace, first);
    appendAskFormLintCalibrationRecord(workspace, second);

    const logPath = join(workspace, ASK_FORM_LINT_CALIBRATION_LOG);
    const lines = (readFileSync(logPath, "utf-8") as string).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual(first);
    expect(JSON.parse(lines[1] as string)).toEqual(second);
  });

  test("does not throw when the workspace path is unwritable (fail-open)", () => {
    const record: AskFormLintCalibrationRecord = {
      timestamp: "2026-07-15T00:00:00.000Z",
      kind: AUTHORIZATION_APPROVE,
      matches: [{ class: "portal-no-link", phrase: "portal action with no direct link" }],
    };

    // A path under /dev/null cannot be created as a directory — this must
    // not throw (fail-open posture: a calibration-log write failure never
    // blocks or fails Ask creation). It also never verifies as a workspace
    // root, so this exercises the same "skip, don't throw" path as the test
    // below — kept as its own case since the assertion under test here is
    // specifically "never throws," regardless of which guard skipped it.
    expect(() =>
      appendAskFormLintCalibrationRecord("/dev/null/unwritable-workspace", record)
    ).not.toThrow();
  });

  test("skips the write (no file created) when workspacePath is not a verified workspace root", () => {
    const workspace = makeUnverifiedWorkspace();
    const record: AskFormLintCalibrationRecord = {
      timestamp: "2026-07-15T00:00:00.000Z",
      kind: AUTHORIZATION_APPROVE,
      matches: [INTERNAL_TOOL_ID_MATCH],
    };

    appendAskFormLintCalibrationRecord(workspace, record);

    const logPath = join(workspace, ASK_FORM_LINT_CALIBRATION_LOG);
    expect(existsSync(logPath)).toBe(false);
  });
});
