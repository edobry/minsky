#!/usr/bin/env bun
/**
 * Live verification artifact for the mt#2459 operator-deferral detector.
 *
 * Proves the FULL invocation path is alive — registry -> canary runner ->
 * module load -> run() -> detection -> outcome — for BOTH surfaces, with
 * positive controls (a real deferral fires) and negative controls (the same
 * prose WITH probe evidence does not; mt#2303's phrasings do not double-fire).
 * Per mem#534: a detector is not working because it shipped; it works when a
 * receipt proves it covered its space.
 *
 * Run: `bun scripts/verify-operator-deferral-detector.ts`
 * Exit 0 = every control behaved as specified; non-zero = a control failed.
 */

import { GUARD_REGISTRY } from "../.minsky/hooks/registry";
import { runGuardCanary, formatCanaryResult } from "../.minsky/hooks/canary-runner";
import { run, runAskSurface } from "../.minsky/hooks/operator-deferral-detector";
import type { ClaudeHookInput, ToolHookInput } from "../.minsky/hooks/types";
import type { DispatchContext } from "../.minsky/hooks/registry";
import type { TranscriptLine } from "../.minsky/hooks/transcript";

const GUARD_NAMES = ["operator-deferral-detector", "operator-deferral-ask-surface"];
const FIXTURE_PATH = "/tmp/verify-operator-deferral.jsonl";
const SESSION_ID = "verify-operator-deferral";
const DEFERRAL_PROSE = "Deferred to operator: requires Railway access.";
const R5_LABEL = "You recover the reviewer service";

const ctx = (transcriptLines: TranscriptLine[]): DispatchContext => ({
  event: "UserPromptSubmit",
  hostCapSec: 60,
  budgets: { overallBudgetMs: 60000, fetchTimeoutMs: 20000, gitTimeoutMs: 20000 },
  transcriptCandidates: [FIXTURE_PATH],
  transcriptLines,
});

const hookInput: ClaudeHookInput = {
  session_id: SESSION_ID,
  transcript_path: FIXTURE_PATH,
  cwd: process.cwd(),
  hook_event_name: "UserPromptSubmit",
};

const askInput = (tool_input: Record<string, unknown>): ToolHookInput => ({
  session_id: SESSION_ID,
  transcript_path: FIXTURE_PATH,
  cwd: process.cwd(),
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input,
});

const prompt = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
});
const say = (text: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const call = (name: string, input: Record<string, unknown>): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
});

const failures: string[] = [];
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}\n`);
  if (!ok) failures.push(label);
};

// --- 1. Registry canaries (both surfaces, through the real runner) ----------
process.stdout.write("\n== Registry canaries ==\n");
for (const name of GUARD_NAMES) {
  const registration = GUARD_REGISTRY.find((g) => g.name === name);
  if (!registration) {
    check(`${name} is registered`, false);
    continue;
  }
  const result = await runGuardCanary(registration);
  process.stdout.write(`${formatCanaryResult(result)}\n`);
  // `passed` is `boolean | undefined` — undefined means MISSING (no declared
  // canary), which is NOT a pass. Compare explicitly rather than relying on
  // truthiness so a guard that loses its canary declaration fails this check.
  check(`${name} canary passes`, result.passed === true);
}

// --- 2. Positive controls --------------------------------------------------
process.stdout.write("\n== Positive controls ==\n");

const proseOutcome = run(
  hookInput,
  ctx([
    prompt("drive the PR to convergence"),
    say(`The reviewer service is down. ${DEFERRAL_PROSE}`),
    call("mcp__minsky__session_pr_get", { task: "mt#2515" }),
    say("Standing by."),
    prompt("why can't you fix this yourself?"),
  ])
);
check(
  "prose surface fires on an unprobed capability deferral (phrase before tool calls)",
  proseOutcome?.calibration !== undefined
);
check(
  "record carries the coverage-receipt source field",
  proseOutcome?.calibration?.["source"] === "live"
);

const askOutcome = runAskSurface(
  askInput({
    questions: [
      {
        question: "The reviewer service is CRASHED and retrigger needs a token.",
        options: [
          { label: R5_LABEL, description: "Restart it on Railway" },
          { label: "Provide me the MCP auth token", description: "So I can retrigger" },
        ],
      },
    ],
  }),
  ctx([prompt("drive the PR to convergence")])
);
check("ask surface fires on the R5 option labels", askOutcome?.calibration !== undefined);

// --- 3. Negative controls --------------------------------------------------
process.stdout.write("\n== Negative controls ==\n");

const probedOutcome = run(
  hookInput,
  ctx([
    prompt("drive the PR to convergence"),
    call("Bash", { command: "which railway && railway whoami" }),
    say(DEFERRAL_PROSE),
    prompt("next"),
  ])
);
check("same prose WITH a probe in the turn does not fire", probedOutcome === null);

const mt2303Outcome = run(
  hookInput,
  ctx([
    prompt("merge it"),
    say("After your next `bun run cockpit:build` + hard-refresh, the card will read Embeddings."),
    prompt("next"),
  ])
);
check(
  "mt#2303's activation-instruction phrasing does not double-fire here",
  mt2303Outcome === null
);

const cleanOutcome = run(
  hookInput,
  ctx([prompt("merge it"), say("Merged and verified; deploy SUCCESS."), prompt("next")])
);
check("a clean turn does not fire", cleanOutcome === null);

// --- Summary ---------------------------------------------------------------
process.stdout.write(
  `\n${failures.length === 0 ? "ALL CONTROLS PASSED" : `FAILED (${failures.length}): ${failures.join("; ")}`}\n`
);
process.exit(failures.length === 0 ? 0 : 1);
