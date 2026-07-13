#!/usr/bin/env bun
/**
 * Live smoke test for the ADR-028 Phase 2a UserPromptSubmit dispatcher
 * (mt#2652). Verifies the end-to-end chain that no unit test covers:
 *
 *   1. `.minsky/hooks/dispatch-userpromptsubmit.ts` reads a crafted
 *      transcript, runs the six migrated guidance detectors in-process, and
 *      emits a consolidated `additionalContext` on stdout.
 *   2. A guard that logs calibration (retrospective-trigger-scanner) writes
 *      a record to `.minsky/retrospective-trigger-calibration.jsonl` in the
 *      exact shape `CALIBRATION_LOG_REGISTRY` / the calibration-review sweep
 *      already expects — i.e., the D4 framework calibration service is
 *      byte-compatible with the pre-migration hand-rolled writers.
 *   3. `src/domain/calibration/calibration-sweep.ts`'s `runSweep` parses that
 *      record without error (no watermark reset, no shape drift).
 *
 * Read-only / non-destructive: runs entirely inside a temp directory (never
 * touches the repo's real `.minsky/*-calibration.jsonl` logs). No env vars
 * required — always runs. Exit 0 on pass, non-zero on failure.
 *
 * @see mt#2652 — ADR-028 Phase 2a (UserPromptSubmit guidance-detector family
 *      migration onto the mt#2650 guard-dispatcher framework)
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSweep,
  parseCalibrationRecord,
  CALIBRATION_LOG_REGISTRY,
} from "../src/domain/calibration/calibration-sweep";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const projectDir = mkdtempSync(join(tmpdir(), "dispatch-ups-smoke-"));
  try {
    // Two real user prompts bound the "just-completed turn" per transcript.ts's
    // real-prompt discriminator; the assistant line between them carries an
    // R1 retrospective-trigger phrase ("I owe you an apology").
    const transcriptLines = [
      { type: "user", message: { role: "user", content: "first prompt" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I owe you an apology for that mistake." }],
        },
      },
      { type: "user", message: { role: "user", content: "second prompt (fires the hook)" } },
    ];
    const transcriptPath = join(projectDir, "transcript.jsonl");
    writeFileSync(transcriptPath, transcriptLines.map((l) => JSON.stringify(l)).join("\n"));

    const hookInput = {
      session_id: "smoke-dispatch-userpromptsubmit",
      transcript_path: transcriptPath,
      cwd: projectDir,
      hook_event_name: "UserPromptSubmit",
    };

    const dispatcherPath = join(
      import.meta.dirname,
      "..",
      ".minsky",
      "hooks",
      "dispatch-userpromptsubmit.ts"
    );
    const proc = Bun.spawn(["bun", "run", dispatcherPath], {
      cwd: projectDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
    proc.stdin.write(JSON.stringify(hookInput));
    proc.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    console.log(`dispatcher exit code: ${exitCode}`);
    if (stderr.trim()) console.log(`dispatcher stderr:\n${stderr}`);
    console.log(`dispatcher stdout:\n${stdout}`);

    if (exitCode !== 0) fail(`dispatcher exited ${exitCode}, expected 0 (fail-open contract)`);
    if (!stdout.includes("Retrospective trigger detected")) {
      fail("stdout did not contain the retrospective-trigger-scanner's additionalContext");
    }

    // --- Step 2: calibration record written in the framework's shared path ---
    const calibrationPath = join(projectDir, ".minsky", "retrospective-trigger-calibration.jsonl");
    if (!existsSync(calibrationPath)) {
      fail(`expected calibration log at ${calibrationPath} — logCalibrationRecord did not fire`);
    }
    const raw = readFileSync(calibrationPath, "utf8").trim();
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length !== 1) fail(`expected exactly 1 calibration record, got ${lines.length}`);
    console.log(`calibration record (raw):\n${lines[0]}`);

    // --- Step 3: the calibration-sweep pure parser reads it without error ---
    const entry = CALIBRATION_LOG_REGISTRY.find((e) => e.name === "retrospective-trigger");
    if (!entry) fail("retrospective-trigger not found in CALIBRATION_LOG_REGISTRY");

    const results = await runSweep(
      [entry as NonNullable<typeof entry>],
      async (p) => (p === entry?.path ? raw : null),
      {}
    );
    const result = results[0];
    if (!result) fail("runSweep returned no result");
    // firesSinceLastReview=1 is below FIRES_THRESHOLD (10), so `newRecords`
    // is intentionally empty per computeLogResult's "surfaced once the COUNT
    // bar is hit" gate — totalFires/distinctPhrases are the byte-compat
    // signal at this volume, not newRecords.
    if (result.totalFires !== 1) fail(`expected totalFires=1, got ${result?.totalFires}`);
    if (result.distinctPhrases !== 1) {
      fail(`expected 1 distinct phrase, got ${result?.distinctPhrases}`);
    }

    // Directly parse the raw record too, for an unambiguous shape check
    // independent of the review-threshold gate.
    const parsed = parseCalibrationRecord(lines[0] as string, "retrospective-trigger") as {
      matches: Array<{ family: string; phrase: string }>;
    } | null;
    if (!parsed) fail("parseCalibrationRecord returned null — record shape drifted");
    if (!parsed.matches.some((m) => m.family === "R1")) {
      fail(`expected a parsed R1-family match, got: ${JSON.stringify(parsed)}`);
    }

    console.log("PASS: dispatcher fired, calibration record written, sweep parsed it correctly.");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

await main();
