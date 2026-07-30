#!/usr/bin/env bun
/**
 * Live verification artifact for mt#3373's `drive-ready-to-implementation` hook.
 *
 * Unit tests exercise `decideReminder` with a hand-built `tool_result`. This
 * script exercises the SHIPPED ENTRYPOINT instead — it spawns
 * `.claude/hooks/drive-ready-to-implementation.ts` and pipes it the payload
 * shape Claude Code ACTUALLY sends on PostToolUse: `tool_response` carrying the
 * MCP content envelope `[{type:"text", text:"<stringified json>"}]`, with NO
 * `tool_result` key at all.
 *
 * That distinction is the whole point. mt#3308 (DONE 2026-07-29) found every
 * PostToolUse hook gating on `tool_result` was silently dead against production
 * payloads — including this hook's own sibling, `drive-pr-to-convergence`,
 * which "never fired" until `types.ts`'s `normalizeToolResult` shipped. A hook
 * that passes its unit tests and still never fires in production is the exact
 * failure this artifact exists to rule out.
 *
 * The kind read is NOT stubbed here: the state-ops case shells out to the real
 * `minsky tasks get`, so a broken CLI read surfaces as a failed case rather
 * than a silently-skipped carve-out.
 *
 * Usage: bun scripts/verify-ready-chain-walk-hook.ts
 * Exit code: 0 = every case behaved as expected, 1 = at least one did not.
 *
 * @see mt#3373 — this hook's task
 * @see mt#3308 — the payload-shape audit this script's premise rests on
 */

import { join } from "node:path";
import { spawnSync as nodeSpawnSync } from "child_process";

const HOOK_PATH = join(
  import.meta.dir,
  "..",
  ".claude",
  "hooks",
  "drive-ready-to-implementation.ts"
);

/** An implementation-kind task (fires) and a state-ops-kind task (carve-out). */
const IMPLEMENTATION_TASK_ID = "mt#3373";
const STATE_OPS_TASK_ID = "mt#2645";

interface Case {
  name: string;
  taskId: string;
  result: Record<string, unknown>;
  expectFires: boolean;
}

const CASES: Case[] = [
  {
    name: "PLANNING -> READY on an implementation task",
    taskId: IMPLEMENTATION_TASK_ID,
    result: {
      success: true,
      taskId: IMPLEMENTATION_TASK_ID,
      previousStatus: "PLANNING",
      newStatus: "READY",
      changed: true,
      status: "READY",
    },
    expectFires: true,
  },
  {
    name: "PLANNING -> READY on a state-ops task (carve-out, live CLI kind read)",
    taskId: STATE_OPS_TASK_ID,
    result: {
      success: true,
      taskId: STATE_OPS_TASK_ID,
      previousStatus: "PLANNING",
      newStatus: "READY",
      changed: true,
      status: "READY",
    },
    expectFires: false,
  },
  {
    name: "READY -> IN-PROGRESS (non-trigger status)",
    taskId: IMPLEMENTATION_TASK_ID,
    result: {
      success: true,
      taskId: IMPLEMENTATION_TASK_ID,
      previousStatus: "READY",
      newStatus: "IN-PROGRESS",
      changed: true,
      status: "IN-PROGRESS",
    },
    expectFires: false,
  },
  {
    name: "no-op re-set of an already-READY task",
    taskId: IMPLEMENTATION_TASK_ID,
    result: {
      success: true,
      taskId: IMPLEMENTATION_TASK_ID,
      previousStatus: "READY",
      newStatus: "READY",
      changed: false,
      status: "READY",
    },
    expectFires: false,
  },
];

/**
 * The measured production PostToolUse payload for an MCP tool (mt#3308): the
 * tool's JSON result is STRINGIFIED inside the first text block of
 * `tool_response`, and `tool_result` is absent.
 */
function buildProductionPayload(c: Case): string {
  return JSON.stringify({
    session_id: "verify-ready-chain-walk",
    cwd: process.cwd(),
    hook_event_name: "PostToolUse",
    tool_name: "mcp__minsky__tasks_status_set",
    tool_input: { taskId: c.taskId, status: c.result["newStatus"] },
    tool_response: [{ type: "text", text: JSON.stringify(c.result) }],
  });
}

function runCase(c: Case): { fired: boolean; context: string; stderr: string } {
  // Uses node:child_process.spawnSync (not Bun.spawnSync) — see mt#3088 spec
  // for the diagnosis: bun-types' Bun.spawnSync stdin type is hardcoded to
  // "ignore" on both overloads, with no cast-free way to pass a real stdin
  // value. node's `input` option is properly typed and has identical
  // synchronous semantics. Same precedent as scripts/smoke-transcript-ingest-hook.ts.
  const proc = nodeSpawnSync("bun", [HOOK_PATH], {
    input: buildProductionPayload(c),
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, MINSKY_SKIP_READY_CHAIN_WALK: "" },
  });
  const stdout = (proc.stdout ?? "").trim();
  const stderr = proc.stderr ?? "";
  if (stdout.length === 0) return { fired: false, context: "", stderr };
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const context = parsed.hookSpecificOutput?.additionalContext ?? "";
    return { fired: context.length > 0, context, stderr };
  } catch {
    return { fired: false, context: `<unparseable stdout: ${stdout}>`, stderr };
  }
}

let failures = 0;
console.log(`Exercising ${HOOK_PATH}`);
console.log("Payload shape: production `tool_response` MCP envelope (no `tool_result` key)\n");

for (const c of CASES) {
  const { fired, context, stderr } = runCase(c);
  const ok = fired === c.expectFires;
  if (!ok) failures += 1;
  console.log(
    `[${ok ? "PASS" : "FAIL"}] ${c.name}\n        expected fires=${c.expectFires}, got fires=${fired}`
  );
  if (fired) {
    console.log(`        first line: ${context.split("\n")[0]}`);
  }
  if (stderr.trim().length > 0) {
    console.log(`        stderr: ${stderr.trim()}`);
  }
}

console.log(`\nTotal: ${CASES.length}  Passed: ${CASES.length - failures}  Failed: ${failures}`);
if (failures > 0) {
  console.log("FAIL — at least one case did not behave as expected.");
  process.exit(1);
}
console.log("PASS — the shipped hook entrypoint behaves correctly on production-shaped payloads.");
