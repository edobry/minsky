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
    // Detector, not a blocking guard: in its default `log-only` mode an
    // uncovered action emits additionalContext rather than a denial, so the
    // additionalContext-shaped `warn` expectation is the right one.
    //
    // mt#3393 added this. Until then `policy-coverage` had NEITHER half of the
    // two-part coverage story — no canary (synthetic) and, because its records
    // were landing outside the repo, no live receipt either. So when the
    // coverage-receipt check flagged it, nothing could distinguish a broken
    // detector from a dormant one, and the investigation started from the
    // wrong hypothesis.
    guardName: "policy-coverage",
    effects: [advisoryEffect(), recorderEffect()],
    expects: "warn",
    // mt#3502: the join key the coverage-receipt check uses to find this
    // guard's invocations in the fire log. Without it the check has no
    // liveness evidence for the detector and can only ever flag it.
    calibrationLog: "policy-coverage",
    check: async () => {
      const { applyActionFilter } = await import(
        "../../packages/domain/src/detectors/policy-coverage/action-filter"
      );
      const { decideCoverage } = await import(
        "../../packages/domain/src/detectors/policy-coverage/coverage"
      );

      // Half 1: the action filter recognizes a preference-encoding write.
      // The path below is a synthetic STRING, never read from disk — the
      // filter only inspects the path's shape (extension) and the content
      // string. It intentionally names no real file, so it cannot go stale if
      // the tree is reorganized.
      const filtered = applyActionFilter({
        toolName: "Write",
        filePath: "packages/domain/src/canary-sample.ts",
        content: 'export const message = "Hello there, this is a user facing message string";',
      });
      if (!filtered.fires || !filtered.reason) return false;

      const action = {
        reason: filtered.reason,
        detail: filtered.detail ?? "",
        filePath: "packages/domain/src/canary-sample.ts",
      };

      // Half 2: the coverage decision separates a corpus that speaks to the
      // action from one that does not. Both directions are asserted — a
      // decision function stuck at one answer passes a one-sided check.
      const covering = decideCoverage(action, {
        entries: [
          {
            source: "canary-policy.mdc",
            ref: "canary-policy.mdc",
            content: "Every new exported function must carry a doc comment.",
            category: "project-rule",
          },
        ],
        loadedCount: 1,
        unavailableCount: 0,
      });
      const silent = decideCoverage(action, {
        entries: [
          {
            source: "canary-policy.mdc",
            ref: "canary-policy.mdc",
            content: "Session workspaces are cloned per task.",
            category: "project-rule",
          },
        ],
        loadedCount: 1,
        unavailableCount: 0,
      });

      return covering.covered && !silent.covered;
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
    ],
    expects: "deny",
    // TWO logs from one guard: the gate writes `execution-evidence-at-coverage`
    // itself and `execution-evidence-test-first` through `test-first-evidence.ts`,
    // which it calls in-process. The list form exists for this (mt#3519).
    calibrationLog: ["execution-evidence-at-coverage", "execution-evidence-test-first"],
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
    // outcome-shaped expectation, as with `policy-coverage` above.
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
];
