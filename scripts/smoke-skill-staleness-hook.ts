#!/usr/bin/env bun
// Smoke test for the skill-staleness-detector hook (mt#1622).
//
// Exercises the hook's entrypoint end-to-end without needing a live Claude
// Code session: pipes input JSON through stdin, captures stdout, and
// verifies the full lifecycle:
//   1. First invocation in a session → baseline-init, no warning.
//   2. Touch a watched file → next invocation emits a staleness warning
//      naming the modified file.
//   3. Same change a third time → re-warning suppressed (lastReported wins).
//   4. Opt-out env var → no warning even after touch.
//
// Run from repo root: `bun scripts/smoke-skill-staleness-hook.ts`.
// Exit code 0 = pass. Non-zero exit + stderr message = fail.

import { mkdtempSync, writeFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HOOK_PATH = join(REPO_ROOT, ".claude/hooks/skill-staleness-detector.ts");

interface HookOutput {
  hookSpecificOutput?: { hookEventName: string; additionalContext?: string };
}

interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: HookOutput | null;
}

function runHook(input: {
  cwd: string;
  sessionId: string;
  home: string;
  optOut?: string;
}): HookRunResult {
  const payload = {
    session_id: input.sessionId,
    cwd: input.cwd,
    hook_event_name: "UserPromptSubmit",
    prompt: "smoke-test prompt",
  };

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: input.home,
  };
  if (input.optOut !== undefined) env.MINSKY_SKIP_SKILL_STALENESS = input.optOut;

  const proc = Bun.spawnSync({
    cmd: ["bun", HOOK_PATH],
    stdin: Buffer.from(JSON.stringify(payload)),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();

  let parsed: HookOutput | null = null;
  if (stdout.trim()) {
    try {
      parsed = JSON.parse(stdout) as HookOutput;
    } catch {
      parsed = null;
    }
  }

  return { exitCode: proc.exitCode ?? 1, stdout, stderr, parsed };
}

function fail(msg: string): never {
  process.stderr.write(`SMOKE FAIL: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Setup: temp project + temp HOME
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "skill-staleness-smoke-"));
const project = join(tmp, "project");
const home = join(tmp, "home");
mkdirSync(home, { recursive: true });

const skillDir = join(project, ".claude/skills/example");
mkdirSync(skillDir, { recursive: true });
const skillFile = join(skillDir, "SKILL.md");
writeFileSync(skillFile, "# example skill\n", "utf8");

const sessionId = "smoke-session-1";

// ---------------------------------------------------------------------------
// Step 1: first invocation — baseline-init, no warning
// ---------------------------------------------------------------------------

process.stdout.write("Step 1: first invocation (baseline-init expected)... ");
{
  const result = runHook({ cwd: project, sessionId, home });
  if (result.exitCode !== 0) {
    fail(`expected exit 0, got ${result.exitCode}. stderr: ${result.stderr}`);
  }
  if (result.stdout.trim() !== "") {
    fail(`expected no stdout on first invocation; got: ${result.stdout}`);
  }
  // Baseline file should now exist
  const expectedBaseline = join(
    home,
    ".claude/skill-staleness",
    project.replace(/[/\\]/g, "-").replace(/^-/, ""),
    `${sessionId}.json`
  );
  try {
    statSync(expectedBaseline);
  } catch {
    fail(`baseline file not created at ${expectedBaseline}`);
  }
  process.stdout.write("OK\n");
}

// ---------------------------------------------------------------------------
// Step 2: touch the watched file → next invocation should warn
// ---------------------------------------------------------------------------

process.stdout.write("Step 2: touch watched file → expect warning... ");
{
  const future = new Date(Date.now() + 5000); // bump mtime well into the future
  utimesSync(skillFile, future, future);

  const result = runHook({ cwd: project, sessionId, home });
  if (result.exitCode !== 0) {
    fail(`expected exit 0, got ${result.exitCode}. stderr: ${result.stderr}`);
  }
  if (!result.parsed || !result.parsed.hookSpecificOutput) {
    fail(`expected hookSpecificOutput; got stdout: ${result.stdout}`);
  }
  const hso = result.parsed.hookSpecificOutput;
  if (hso.hookEventName !== "UserPromptSubmit") {
    fail(`expected hookEventName=UserPromptSubmit, got ${hso.hookEventName}`);
  }
  const ctx = hso.additionalContext ?? "";
  if (!ctx.includes("SKILL.md (modified)")) {
    fail(`expected additionalContext to mention SKILL.md (modified); got: ${ctx}`);
  }
  if (!ctx.includes("fresh session")) {
    fail(`expected reload hint (fresh session) in additionalContext; got: ${ctx}`);
  }
  process.stdout.write("OK\n");
}

// ---------------------------------------------------------------------------
// Step 3: third invocation with no further change → re-warn suppressed
// ---------------------------------------------------------------------------

process.stdout.write("Step 3: re-warn suppression... ");
{
  const result = runHook({ cwd: project, sessionId, home });
  if (result.exitCode !== 0) {
    fail(`expected exit 0, got ${result.exitCode}. stderr: ${result.stderr}`);
  }
  if (result.stdout.trim() !== "") {
    fail(`expected no stdout on suppressed re-warn; got: ${result.stdout}`);
  }
  process.stdout.write("OK\n");
}

// ---------------------------------------------------------------------------
// Step 4: opt-out short-circuits even after a touch
// ---------------------------------------------------------------------------

process.stdout.write("Step 4: opt-out env var... ");
{
  const future = new Date(Date.now() + 10000);
  utimesSync(skillFile, future, future);
  const result = runHook({ cwd: project, sessionId: "opt-out-session", home, optOut: "1" });
  if (result.exitCode !== 0) {
    fail(`expected exit 0, got ${result.exitCode}. stderr: ${result.stderr}`);
  }
  if (result.stdout.trim() !== "") {
    fail(`expected no stdout when opted out; got: ${result.stdout}`);
  }
  process.stdout.write("OK\n");
}

process.stdout.write("\nAll smoke checks passed.\n");
process.exit(0);
