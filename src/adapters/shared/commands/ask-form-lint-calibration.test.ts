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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAskFormLintCalibrationRecord,
  ASK_FORM_LINT_CALIBRATION_LOG,
  type AskFormLintCalibrationRecord,
} from "./ask-form-lint-calibration";
import type { AskKind } from "@minsky/domain/ask/types";

// Centralized AskKind literal reference (defangs custom/no-magic-string-duplication).
const AUTHORIZATION_APPROVE: AskKind = "authorization.approve";

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-form-lint-calibration-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("appendAskFormLintCalibrationRecord", () => {
  test("creates the .minsky directory and appends a JSONL line", () => {
    const workspace = makeWorkspace();
    const record: AskFormLintCalibrationRecord = {
      timestamp: "2026-07-15T00:00:00.000Z",
      askId: "test-ask-id",
      kind: AUTHORIZATION_APPROVE,
      matches: [{ class: "internal-tool-id", phrase: "internal tool id in principal-facing text" }],
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
      matches: [{ class: "internal-tool-id", phrase: "internal tool id in principal-facing text" }],
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
    // blocks or fails Ask creation).
    expect(() =>
      appendAskFormLintCalibrationRecord("/dev/null/unwritable-workspace", record)
    ).not.toThrow();
  });
});
