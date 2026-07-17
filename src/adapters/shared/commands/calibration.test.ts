/**
 * Tests for the observability.calibration-review command adapter (mt#2866).
 *
 * Exercises the silent-stretch registry entry through the ACTUAL command
 * surface — not just the pure `calibration-sweep.ts` functions covered in
 * `src/domain/calibration/calibration-sweep.test.ts`. `formatResult` in
 * `calibration.ts` has its own record-shape-detection branches (mirrors the
 * ones in `extractDistinctPhrases`), and mt#2866's acceptance criterion #3
 * ("/calibration-review can classify silent-stretch records ... without
 * erroring") targets this command surface directly — a synthetic log that
 * parses fine in the pure sweep layer could still crash here if this file's
 * shape-detection fallthrough weren't also updated.
 *
 * Uses real filesystem operations against a unique temp directory (mirrors
 * `src/adapters/shared/commands/ask-form-lint-calibration.test.ts`) because
 * this exercises the real JSONL read path through `readFileOrNull`.
 */
/* eslint-disable custom/no-real-fs-in-tests -- exercises the real JSONL read
   path via a unique per-test temp workspace dir (mirrors
   ask-form-lint-calibration.test.ts's justification) */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedCommandRegistry } from "../command-registry";
import { registerCalibrationCommands } from "./calibration";

const COMMAND_ID = "observability.calibration-review";
const SILENT_STRETCH_LOG = "silent-stretch-calibration.jsonl";

function getCommand() {
  let command = sharedCommandRegistry.getCommand(COMMAND_ID);
  if (!command) {
    registerCalibrationCommands();
    command = sharedCommandRegistry.getCommand(COMMAND_ID);
  }
  if (!command) throw new Error(`${COMMAND_ID} not registered`);
  return command;
}

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "calibration-review-command-test-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, ".minsky"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSilentStretchRecord(sessionId: string): string {
  return JSON.stringify({
    timestamp: "2026-07-16T00:00:00Z",
    session_id: sessionId,
    gapMinutes: 12.5,
    toolCallCount: 15,
    hadTextInTurn: false,
  });
}

/** 12 fires across 4 distinct conversations — the mt#2866 acceptance-test fixture. */
function writeAcceptanceFixture(workspace: string): void {
  const conversations = ["conv-a", "conv-b", "conv-c", "conv-d"];
  const lines = Array.from({ length: 12 }, (_, i) =>
    makeSilentStretchRecord(conversations[i % conversations.length] as string)
  );
  writeFileSync(join(workspace, ".minsky", SILENT_STRETCH_LOG), `${lines.join("\n")}\n`, "utf-8");
}

describe("observability.calibration-review — silent-stretch (mt#2866)", () => {
  test("classifies a synthetic silent-stretch log without erroring (json mode)", async () => {
    const workspace = makeWorkspace();
    writeAcceptanceFixture(workspace);

    const command = getCommand();
    const result = (await command.execute(
      { ack: false, json: true },
      { workspacePath: workspace }
    )) as {
      success: boolean;
      results: Array<{
        name: string;
        totalFires: number;
        distinctPhrases: number;
        pastThreshold: boolean;
      }>;
    };

    expect(result.success).toBe(true);
    const silentStretchResult = result.results.find((r) => r.name === "silent-stretch");
    expect(silentStretchResult).toBeDefined();
    expect(silentStretchResult?.totalFires).toBe(12);
    expect(silentStretchResult?.distinctPhrases).toBe(4);
    expect(silentStretchResult?.pastThreshold).toBe(true);
  });

  test("classifies a synthetic silent-stretch log without erroring (text mode)", async () => {
    const workspace = makeWorkspace();
    writeAcceptanceFixture(workspace);

    const command = getCommand();
    const result = (await command.execute(
      { ack: false, json: false },
      { workspacePath: workspace }
    )) as { success: boolean; message: string };

    expect(result.success).toBe(true);
    expect(result.message).toContain("silent-stretch");
    expect(result.message).toContain("gap=");
  });

  test("--ack advances the silent-stretch watermark without erroring", async () => {
    const workspace = makeWorkspace();
    writeAcceptanceFixture(workspace);

    const command = getCommand();
    const result = (await command.execute(
      { ack: true, json: true },
      { workspacePath: workspace }
    )) as { success: boolean; watermarkAdvanced: boolean };

    expect(result.success).toBe(true);
    expect(result.watermarkAdvanced).toBe(true);
  });
});
