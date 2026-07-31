#!/usr/bin/env bun
// Verification artifact for mt#2708 — proves the knowledge-acquisition-detector's
// full invocation path (dispatcher -> registry -> run() -> transcript parse ->
// detection -> calibration write) alive end-to-end, via synthetic
// positive/negative-control transcripts run through the REAL dispatcher
// entrypoint (`.minsky/hooks/dispatch-userpromptsubmit.ts`) as a subprocess —
// never through in-process instrumentation added to the detector module.
//
// Positive control: skill `engineering-writing` loaded, a `WebSearch` call
// whose query overlaps the skill's REAL frontmatter keywords (read from this
// repo's actual `.claude/skills/engineering-writing/SKILL.md`, copied into an
// isolated scratch project dir — not a synthetic stand-in), enough filler
// turns for the trailing window to elapse, no propagation call. Expected:
// exactly one calibration record appended.
//
// Negative control: identical shape, but a `mcp__minsky__memory_create`
// propagation call is inserted before the trailing window elapses. Expected:
// zero calibration records appended (the true-negative / suppressed path).
//
// Isolation: both controls run with `cwd` AND `CLAUDE_PROJECT_DIR` pointed at
// a fresh scratch temp directory (containing its own `.claude/skills/
// engineering-writing/SKILL.md` copy) — `calibrationLogPath()`
// (`.minsky/hooks/dispatcher.ts`) resolves the D4 write path from
// `CLAUDE_PROJECT_DIR ?? process.cwd()`, so this guarantees every write in
// this run lands under the scratch dir, never this repo's real
// `.minsky/knowledge-acquisition-calibration.jsonl`. The scratch dir is
// removed on exit, including on failure.
//
// Usage:   bun scripts/verify-knowledge-acquisition-detector.ts
// Exit:    0 = both controls behaved as expected, non-zero = a control diverged.
//
// @see mt#2708 — this task
// @see mt#3078 — the live synthetic positive/negative-control precedent this mirrors
// @see .minsky/hooks/dispatch-userpromptsubmit.ts — the real dispatcher entrypoint exercised here
// @see .minsky/hooks/knowledge-acquisition-detector.ts — the detector under verification

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const DISPATCHER_PATH = join(REPO_ROOT, ".minsky", "hooks", "dispatch-userpromptsubmit.ts");
const REAL_SKILL_MD_PATH = join(REPO_ROOT, ".claude", "skills", "engineering-writing", "SKILL.md");
const CALIBRATION_LOG_RELATIVE = join(".minsky", "knowledge-acquisition-calibration.jsonl");

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

const steps: Step[] = [];
let failed = false;

function record(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  if (!ok) failed = true;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}\n`);
}

// ---------------------------------------------------------------------------
// Transcript fixture builders (mirrors .minsky/hooks/knowledge-acquisition-detector.test.ts)
// ---------------------------------------------------------------------------

function userPrompt(content: string): Record<string, unknown> {
  return { type: "user", message: { role: "user", content } };
}
function assistant(content: Array<Record<string, unknown>>): Record<string, unknown> {
  return { type: "assistant", message: { role: "assistant", content } };
}
function toolUse(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "tool_use", name, input };
}
function text(t: string): Record<string, unknown> {
  return { type: "text", text: t };
}
function toolResult(id: string, resultText: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content: [{ type: "text", text: resultText }] },
      ],
    },
  };
}
function skillLoad(skill: string): Record<string, unknown> {
  return assistant([toolUse("Skill", { skill }), text(`Loading ${skill}.`)]);
}
function filler(promptText: string, assistantText: string): Record<string, unknown>[] {
  return [userPrompt(promptText), assistant([text(assistantText)])];
}

const TRAILING_WINDOW_TURNS = 5; // must match knowledge-acquisition-detector.ts's exported constant

function buildPositiveTranscript(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [
    userPrompt("please write an essay about AI writing tells"),
    skillLoad("engineering-writing"),
    userPrompt("go ahead and research it"),
    assistant([
      toolUse("WebSearch", { query: "argumentative prose AI writing tells overused phrases" }),
    ]),
    toolResult("toolu_verify_1", "Common AI tells: em dashes, tricolons, hedging phrases."),
    assistant([text("Found several AI-writing tells to avoid in the essay.")]),
  ];
  for (let i = 0; i < TRAILING_WINDOW_TURNS; i++) {
    lines.push(...filler(`turn ${i + 3}`, `continuing the draft (${i})`));
  }
  lines.push(userPrompt("current turn (triggers the hook) — POSITIVE CONTROL"));
  return lines;
}

function buildNegativeTranscript(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [
    userPrompt("please write an essay about AI writing tells"),
    skillLoad("engineering-writing"),
    userPrompt("go ahead and research it"),
    assistant([
      toolUse("WebSearch", { query: "argumentative prose AI writing tells overused phrases" }),
    ]),
    toolResult("toolu_verify_2", "Common AI tells: em dashes, tricolons, hedging phrases."),
    assistant([text("Found several AI-writing tells to avoid in the essay.")]),
    userPrompt("turn 3"),
    assistant([
      toolUse("mcp__minsky__memory_create", { content: "AI writing tells to avoid" }),
      text("Saved a memory about this."),
    ]),
  ];
  for (let i = 0; i < TRAILING_WINDOW_TURNS; i++) {
    lines.push(...filler(`turn ${i + 4}`, `continuing the draft (${i})`));
  }
  lines.push(userPrompt("current turn (triggers the hook) — NEGATIVE CONTROL"));
  return lines;
}

// ---------------------------------------------------------------------------
// Real-dispatcher subprocess invocation
// ---------------------------------------------------------------------------

interface DispatcherResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runDispatcher(
  scratchDir: string,
  transcriptPath: string,
  sessionId: string
): Promise<DispatcherResult> {
  // Strip CLAUDE_PROJECT_DIR from the subprocess env — `calibrationLogPath()`
  // (dispatcher.ts) prefers it over `cwd`, so an inherited ambient value
  // (e.g. a parent harness's own project dir) would otherwise redirect the
  // write path away from the scratch isolation this script depends on.
  const { CLAUDE_PROJECT_DIR: _unused, ...envWithoutProjectDir } = process.env;
  const proc = Bun.spawn(["bun", DISPATCHER_PATH], {
    cwd: scratchDir,
    env: envWithoutProjectDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const input = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: scratchDir,
    hook_event_name: "UserPromptSubmit",
  };
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function readCalibrationLines(scratchDir: string): Record<string, unknown>[] {
  const logPath = join(scratchDir, CALIBRATION_LOG_RELATIVE);
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(REAL_SKILL_MD_PATH)) {
    record(
      "real skill file present",
      false,
      `expected ${REAL_SKILL_MD_PATH} to exist — cannot exercise the rung-2-lite gate against real skill data`
    );
    process.exit(1);
  }

  const scratchDir = mkdtempSync(join(tmpdir(), "mt2708-verify-kad-"));
  try {
    // Isolated scratch project: a REAL copy of the engineering-writing
    // SKILL.md (not synthetic content) so readSkillDescription's
    // frontmatter-keyword extraction is exercised against real data, while
    // every read/write this run performs stays scoped to `scratchDir`.
    const scratchSkillDir = join(scratchDir, ".claude", "skills", "engineering-writing");
    mkdirSync(scratchSkillDir, { recursive: true });
    writeFileSync(join(scratchSkillDir, "SKILL.md"), readFileSync(REAL_SKILL_MD_PATH, "utf-8"));

    const positiveTranscriptPath = join(scratchDir, "positive-transcript.jsonl");
    const negativeTranscriptPath = join(scratchDir, "negative-transcript.jsonl");
    writeFileSync(
      positiveTranscriptPath,
      `${buildPositiveTranscript()
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`
    );
    writeFileSync(
      negativeTranscriptPath,
      `${buildNegativeTranscript()
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`
    );

    // --- Positive control ---------------------------------------------------
    const posResult = await runDispatcher(
      scratchDir,
      positiveTranscriptPath,
      "verify-kad-positive-control"
    );
    const afterPositive = readCalibrationLines(scratchDir);
    record(
      "positive control: dispatcher exits 0",
      posResult.exitCode === 0,
      `exitCode=${posResult.exitCode} stderr=${posResult.stderr.slice(0, 300)}`
    );
    record(
      "positive control: exactly one calibration record written",
      afterPositive.length === 1,
      `observed ${afterPositive.length} record(s): ${JSON.stringify(afterPositive)}`
    );
    const posRecord = afterPositive[0];
    if (posRecord) {
      record(
        "positive control: record shape matches spec (rung/matchedSkill/hadPropagation)",
        posRecord["detectionRung"] === "1+2-lite" &&
          posRecord["matchedSkill"] === "engineering-writing" &&
          posRecord["hadPropagation"] === false &&
          Array.isArray(posRecord["researchTools"]) &&
          (posRecord["researchTools"] as unknown[]).includes("WebSearch") &&
          Array.isArray(posRecord["loadedSkills"]) &&
          (posRecord["loadedSkills"] as unknown[]).includes("engineering-writing"),
        `record=${JSON.stringify(posRecord)}`
      );
    }

    // --- Negative control -----------------------------------------------------
    const negResult = await runDispatcher(
      scratchDir,
      negativeTranscriptPath,
      "verify-kad-negative-control"
    );
    const afterNegative = readCalibrationLines(scratchDir);
    record(
      "negative control: dispatcher exits 0",
      negResult.exitCode === 0,
      `exitCode=${negResult.exitCode} stderr=${negResult.stderr.slice(0, 300)}`
    );
    record(
      "negative control: calibration log unchanged (propagation suppressed the fire)",
      afterNegative.length === afterPositive.length,
      `before=${afterPositive.length} after=${afterNegative.length}`
    );

    process.stdout.write("\nObserved calibration records after both controls:\n");
    process.stdout.write(`${JSON.stringify(afterNegative, null, 2)}\n`);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  process.stdout.write(
    `\n${failed ? "FAIL" : "PASS"} — ${steps.filter((s) => s.ok).length}/${steps.length} checks passed.\n`
  );
  process.exit(failed ? 1 : 0);
}

await main();
