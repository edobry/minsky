/**
 * Canary declarations for STANDALONE (non-GUARD_REGISTRY) guards — mt#2889
 * (evaluation-loop Phase 1 completion).
 *
 * Every standalone guard's `if (import.meta.main) { ... }` entrypoint is
 * plumbing: read stdin -> call the guard's own exported PURE decision
 * function -> write output. That exported pure function IS the guard's real
 * decision logic, so calling it directly (no subprocess spawn) exercises
 * the exact production code path — mirroring the precedent every
 * standalone guard's own `.test.ts` file already establishes (e.g.
 * `block-git-gh-cli.test.ts` imports `checkDenial` directly).
 *
 * `scripts/` already has precedent for importing directly from
 * `.minsky/hooks/` (see `scripts/grant-guard-override.ts`,
 * `scripts/grant-subagent-merge.ts`).
 *
 * @see mt#2889 — this task
 * @see .minsky/hooks/canary-runner.ts — StandaloneGuardCanary, runAllStandaloneCanaries
 * @see scripts/run-guard-canaries.ts — the CLI entrypoint consuming this array
 */

import type { StandaloneGuardCanary } from "../../.minsky/hooks/canary-runner";
import { enforcementEffect, advisoryEffect, recorderEffect } from "../../.minsky/hooks/registry";

export const STANDALONE_GUARD_CANARIES: StandaloneGuardCanary[] = [
  {
    guardName: "block-git-gh-cli",
    effects: [enforcementEffect()],
    expects: "deny",
    check: async () => {
      const { checkDenial, parseCommands } = await import("../../.minsky/hooks/block-git-gh-cli");
      const parsed = parseCommands("git push origin main")[0];
      if (!parsed) return false;
      const reason = checkDenial(parsed, "bash");
      return reason !== null;
    },
  },
  {
    guardName: "require-session-for-main-workspace-edits",
    effects: [enforcementEffect()],
    expects: "deny",
    check: async () => {
      const { checkFilePathDenial, MAIN_WORKSPACE } = await import(
        "../../.minsky/hooks/require-session-for-main-workspace-edits"
      );
      // A file under MAIN_WORKSPACE that does not exist on disk -> the
      // conflict-marker carve-out's readFile throws -> hasMarkers=false ->
      // denied. No real file access needed (readFileSync throws ENOENT for a
      // nonexistent path), so this is safe against the real repo checkout.
      const decision = checkFilePathDenial(
        "Edit",
        `${MAIN_WORKSPACE}/mt2889-canary-nonexistent-file.ts`
      );
      return decision.denied;
    },
  },
  {
    guardName: "tasks-status-set-guard",
    effects: [enforcementEffect()],
    expects: "deny",
    check: async () => {
      const { checkTransition } = await import("../../.minsky/hooks/tasks-status-set-guard");
      // TODO -> DONE is not a valid transition in the canonical state machine.
      const result = checkTransition(
        "mcp__minsky__tasks_status_set",
        { taskId: "mt#0000", status: "DONE" },
        { readCurrentTask: () => ({ status: "TODO", kind: null }) }
      );
      return result.decision === "deny";
    },
  },
  {
    guardName: "validate-task-spec",
    effects: [enforcementEffect()],
    expects: "deny",
    check: async () => {
      const { validateSpecContent } = await import("../../.minsky/hooks/validate-task-spec");
      // Over MIN_SPEC_LENGTH_FOR_VALIDATION (100 chars), missing both
      // required headings.
      const specContent = `A canary task spec body long enough to cross the validation length threshold. ${"padding ".repeat(5)}`;
      const result = validateSpecContent(specContent);
      return !result.valid;
    },
  },
  {
    guardName: "check-generated-file-edit",
    effects: [enforcementEffect()],
    expects: "deny",
    check: async () => {
      const { scanFileForBanner } = await import("../../.minsky/hooks/check-generated-file-edit");
      const { GENERATED_BANNER } = await import(
        "../../packages/domain/src/rules/compile/banner-constants"
      );
      const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "mt2889-generated-file-canary-"));
      const filePath = join(dir, "canary-generated-output.md");
      writeFileSync(filePath, `${GENERATED_BANNER}\n\nsome generated content\n`);
      try {
        const result = await scanFileForBanner(filePath, 5);
        return result.found;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    guardName: "check-task-spec-read",
    effects: [enforcementEffect()],
    expects: "deny",
    check: async () => {
      const { resolveTargetTaskId, specWasSurfacedInAnyTranscript } = await import(
        "../../.minsky/hooks/check-task-spec-read"
      );
      const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "mt2889-spec-read-canary-"));
      const transcriptPath = join(dir, "transcript.jsonl");
      // A transcript with real activity but NO tasks_spec_get / tasks_get
      // includeSpec / spec-authoring call for the target task.
      const lines = [
        { type: "user", message: { role: "user", content: "let's start on something" } },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Sure, one moment." }] },
        },
      ];
      writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"));
      try {
        const targetId = resolveTargetTaskId("mcp__minsky__session_start", {
          task: "mt#9999",
        });
        if (!targetId) return false;
        const surfaced = specWasSurfacedInAnyTranscript(transcriptPath, undefined, targetId);
        return !surfaced; // NOT surfaced -> the real guard would deny
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    // Injection observer, not a blocking guard: `expects: "warn"` is the
    // additionalContext-shaped expectation (canary-runner's
    // evaluateCanaryOutcome maps "warn" to a non-empty additionalContext).
    guardName: "drive-ready-to-implementation",
    effects: [advisoryEffect()],
    expects: "warn",
    check: async () => {
      const { decideReminder } = await import("../../.minsky/hooks/drive-ready-to-implementation");
      const reminder = decideReminder(
        {
          session_id: "canary",
          cwd: "/",
          hook_event_name: "PostToolUse",
          tool_name: "mcp__minsky__tasks_status_set",
          tool_input: { taskId: "mt#0000", status: "READY" },
          tool_result: {
            success: true,
            taskId: "mt#0000",
            previousStatus: "PLANNING",
            newStatus: "READY",
            changed: true,
          },
        },
        // Injected so the canary never shells out to the CLI (mt#0000 does not exist).
        { readTaskKind: () => "implementation" }
      );
      return typeof reminder === "string" && reminder.length > 0;
    },
  },
  {
    // mt#3519. This gate had fire-log invocations (488 of them) but no canary,
    // and the canary declaration is the ONLY place a standalone guard can
    // declare its calibration log — so its two logs read as `Unmapped` while
    // the evidence they needed was already in the fire log.
    guardName: "require-execution-evidence-before-merge",
    effects: [
      enforcementEffect(),
      recorderEffect("execution-evidence-at-coverage"),
      recorderEffect("execution-evidence-test-first"),
      recorderEffect("execution-evidence-render-path"),
      recorderEffect("execution-evidence-sc-coverage"),
    ],
    expects: "deny",
    // FOUR logs from one guard, every one written in-process off this same merge-gate
    // entry point: `execution-evidence-at-coverage` by the gate itself, and the other
    // three through modules it calls — `test-first-evidence.ts`,
    // `render-path-evidence.ts`, `success-criteria-coverage.ts`. The list form exists
    // for this (mt#3519).
    //
    // mt#4064: this declared two of the four, and the two shapes the omission takes are
    // different. `-render-path` was ON DISK, so it read as `Unmapped` — with no
    // declaration there is no invocation evidence to join, which is exactly the
    // dormant-vs-dead distinction mt#3502 built the three-state model for, and
    // `check-calibration-sweep-coverage.ts` FAILED outright because no sweep visited it.
    // `-sc-coverage` has never been written, so it was invisible to both checks and
    // would have surfaced the same way on its first fire. Adding a calibration surface
    // to this guard means adding it here in the same change.
    calibrationLog: [
      "execution-evidence-at-coverage",
      "execution-evidence-test-first",
      "execution-evidence-render-path",
      "execution-evidence-sc-coverage",
    ],
    check: async () => {
      const { checkExecutionEvidence } = await import(
        "../../.minsky/hooks/require-execution-evidence-before-merge"
      );
      const newTestFile = [{ filename: "src/canary-sample.test.ts", status: "added" as const }];

      // A PR adding a test file with NO execution evidence in the body blocks...
      const blocked = checkExecutionEvidence(newTestFile, "feat: canary sample", "## Summary\nno.");
      // ...and the same PR WITH the evidence heading does not. Both directions
      // are asserted: a check stuck at one answer passes a one-sided probe.
      const allowed = checkExecutionEvidence(
        newTestFile,
        "feat: canary sample",
        "## Testing\n\nExecution evidence:\n\n```\n5 pass 0 fail\n```"
      );
      return blocked.blocked && !allowed.blocked;
    },
  },
  {
    // mt#3519: paired with the `recordFireLogEntry` wiring added to this guard
    // in the same task — the declaration is useless without invocation
    // evidence to join to, and the evidence is unreachable without the
    // declaration. It had neither.
    guardName: "bare-prohibition",
    effects: [advisoryEffect(), recorderEffect()],
    // Calibration-mode detector (mt#3167 tracks graduation): a detected bare
    // prohibition records and warns rather than denying, so `warn` is the
    // outcome-shaped expectation.
    expects: "warn",
    calibrationLog: "bare-prohibition",
    check: async () => {
      const { decideBareProhibitionGate } = await import(
        "../../.minsky/hooks/warn-bare-prohibition-dispatch"
      );
      const dispatchWith = (prompt: string) =>
        decideBareProhibitionGate(
          { tool_name: "Agent", tool_input: { prompt } } as never,
          // Empty env so a real override in the ambient environment cannot make
          // this canary pass by suppressing the detector.
          {},
          false
        );

      // A prohibition with no basis is the class this guard exists for — since
      // mt#3167 that is the ONLY firing category, the licence-to-falsify one
      // having been retired at 8/8 measured false positives...
      const bare = dispatchWith(
        "Do not attempt to use the Railway CLI — it is blocked in this environment."
      );
      // ...and the same instruction WITH its basis is not.
      const grounded = dispatchWith(
        "Do not attempt to use the Railway CLI: `which railway` returns nothing on this host. " +
          "If that basis does not hold, say so and proceed."
      );
      return (bare.report?.bare.length ?? 0) > 0 && (grounded.report?.bare.length ?? 0) === 0;
    },
  },
  {
    // mt#4390. This guard is wired STRAIGHT from `.claude/settings.json` (two
    // entries, on `session.pr.merge` and on the gh-api bypass surface) rather
    // than through the dispatcher, so it is absent from `GUARD_REGISTRY` — and
    // it had no canary either. That left it declared on NEITHER of the two
    // surfaces `buildCalibrationLogToGuards` reads, which is the only reason
    // its log was invisible: it writes 2,666 fire-log rows under this exact
    // name, so the invocation evidence was there the whole time with no join
    // key to reach it. The coverage receipt reported `[FLAGGED] … no live fires
    // and no invocation evidence` while the log was being appended to in real
    // time, and named it on the `Unmapped` line in the same run.
    guardName: "gate-walk-provenance",
    // Record-only by design: it never denies and never warns. `fireLogDecisionFor`
    // returns "allow" unconditionally, so `calibration` is the outcome-shaped
    // expectation — the record IS the effect.
    effects: [recorderEffect()],
    expects: "calibration",
    calibrationLog: "gate-walk-provenance",
    check: async () => {
      const { classifyGateWalk } = await import("../../.minsky/hooks/gate-walk-provenance");

      // A DISCRIMINATING pair, not a single sample: the guard's whole job is to
      // tell "was this task ever gated?" apart from "we cannot tell", so a
      // canary that only exercised one branch would pass against a classifier
      // stuck on that answer.
      const gated = classifyGateWalk({
        readyEventAt: "2026-08-01T00:00:00.000Z",
        horizonAt: "2026-07-01T00:00:00.000Z",
        taskCreatedAt: "2026-07-15T00:00:00.000Z",
      });
      const ungated = classifyGateWalk({
        readyEventAt: null,
        horizonAt: "2026-07-01T00:00:00.000Z",
        taskCreatedAt: "2026-07-15T00:00:00.000Z",
      });
      // The third outcome, kept in the canary because conflating it with
      // `ungated` is the specific error this guard's own docblock warns about:
      // a task predating the horizon is unanswerable, not un-gated.
      const skipped = classifyGateWalk({
        readyEventAt: null,
        horizonAt: "2026-07-01T00:00:00.000Z",
        taskCreatedAt: "2026-06-01T00:00:00.000Z",
      });

      return (
        gated.outcome === "gated" && ungated.outcome === "ungated" && skipped.outcome === "skipped"
      );
    },
  },
];
