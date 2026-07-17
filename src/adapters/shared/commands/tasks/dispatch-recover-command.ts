/**
 * Task Dispatch Recover Command (mt#2831)
 *
 * Server-side detect/classify/prepare half of the subagent dispatch
 * auto-recovery protocol. Server-side code cannot spawn harness subagents
 * (the Agent tool only exists in the main agent's context — see the mt#2831
 * spec's "Plan decision"), so this command does NOT dispatch anything. Given
 * a task whose most recent subagent dispatch has gone silent, it:
 *
 *   1. Captures session state — git-diff presence (dirty file count, commits
 *      ahead of base), and `.minsky/sessions/<id>/handoff.md` presence, via
 *      the same DISPATCH_RECOVERY_PROBE shape mt#2646's `session.status
 *      probe:true` uses.
 *   2. Classifies the dispatch per the subagent-outcome taxonomy
 *      (`packages/domain/src/session/dispatch-recovery-classifier.ts`):
 *      committed-no-pr / partial-committed-handoff-written /
 *      partial-uncommitted-no-handoff / crashed-no-output.
 *   3. Returns a ready-to-dispatch, session-bound continuation prompt plus a
 *      structured state summary — the ORCHESTRATING AGENT is responsible for
 *      redispatching that prompt verbatim (see the /orchestrate skill's
 *      "Dispatch watchdog and resume protocol" section and
 *      `.minsky/hooks/inject-dispatch-watchdog.ts`).
 *
 * All actions are recorded in `subagent_invocations` via
 * `SubagentDispatchTracker.recordDispatchRecoveryAttempt`, with retry
 * linkage (`resumedFromInvocationId` / `attemptNumber`) so a resumed
 * dispatch's history stays attached to the original.
 *
 * The 2-attempt bound is enforced HERE, server-side, by reading the latest
 * invocation's `attemptNumber` — a third recover call for the same original
 * dispatch chain is refused and an escalation package is returned instead of
 * a continuation prompt. This is deliberate: the bound must not depend on an
 * agent remembering to stop retrying.
 *
 * A healthy (not-yet-stale) in-flight dispatch is left untouched — see
 * `status: "healthy"` below (the false-positive-kill acceptance test).
 *
 * ### Covers
 * - API drops mid-dispatch (the dispatch goes silent with no further commits).
 * - Watchdog stalls (>= the stale window with no commit activity).
 *
 * ### Does NOT cover
 * - Semantically-wrong-but-alive work — a subagent that is actively
 *   producing commits but going in the wrong direction. That is the
 *   reviewer's job (`minsky-reviewer[bot]`), not this command's.
 * - Rate-limit storms — repeated `rate-limited` outcomes are the
 *   `SubagentDispatchTracker.getEscalation()` "daily" tier's job (see
 *   `subagent-dispatch-cadence.mdc`); this command's staleness check does
 *   not distinguish "silently dead" from "silently rate-limited" — an
 *   orchestrator who suspects rate-limiting should check the cadence
 *   escalation tier before treating a stale read as a kill signal (per
 *   memory `5f2154cd`, "long-paused subagent != dead subagent").
 * - The full periodic sweep the dispatch-watchdog producer performs
 *   (`src/cockpit/dispatch-watchdog.ts`), including its `system_events`
 *   activity signal — this command's on-demand staleness check uses only
 *   dispatch-start-time and last-commit-time (see
 *   `computeDispatchStaleness`'s docstring for the documented tradeoff).
 *
 * @see mt#2831 — this task
 * @see mt#2646 — dispatch-watchdog detection + `dispatch-recovery-probe.ts`
 * @see mt#2512 — kill+redispatch doctrine (no mid-flight correction)
 *
 * ## CLI shell-completion note (mt#2831 R1 NB #2)
 *
 * `taskId` does NOT appear in `src/generated/completion-manifest.json`'s
 * `dispatch-recover` entry. This is NOT a gap specific to this command — it is
 * the completion-manifest generator's pre-existing, uniform "positionals are
 * invisible" limitation (confirmed via `walkCommand` in
 * `scripts/build-completion-manifest.ts`, which reads only `cmd.options`,
 * never Commander's `cmd.registeredArguments`). This command has exactly one
 * required param and no `tasks-customizations.ts` entry, so the CLI bridge's
 * DEFAULT (`useFirstRequiredParamAsArgument: true`,
 * `src/adapters/shared/bridges/cli/command-customization-manager.ts`)
 * promotes `taskId` to a Commander positional argument, not a `--task-id`
 * flag. The same gap is visible today for `tasks.deps.list` /
 * `tasks.deps.tree` (their manifest entries show `--task` — the legacy alias
 * OPTION — and `--verbose`/`--max-depth`, but never their canonical
 * `<task-id>` positional). `minsky tasks dispatch-recover <taskId>` works
 * correctly from the shell; only its TAB-completion is affected, identically
 * to every other uncustomized single-required-param command.
 */
import { z } from "zod";
import type { CommandParameterMap, InferParams } from "../../command-registry";
import { log } from "@minsky/shared/logger";
import type { SubagentDispatchTracker } from "../../../../mcp/subagent-dispatch-tracker";
import type { SessionProviderInterface, SessionRecord } from "@minsky/domain/session/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import { resolveSessionDirectory } from "@minsky/domain/session/resolve-session-directory";
import {
  buildDispatchRecoveryProbe,
  parseCommitsAheadOutput,
  parseDefaultBranchRef,
  DISPATCH_RECOVERY_PROBE_HANDOFF_MAX_LINES,
  type DispatchRecoveryProbeResult,
} from "@minsky/domain/session/dispatch-recovery-probe";
import {
  computeDispatchStaleness,
  classifyDispatchRecoveryState,
  buildDispatchRecoveryContinuationPrompt,
  DISPATCH_RECOVERY_STALE_MS,
} from "@minsky/domain/session/dispatch-recovery-classifier";

// ---------------------------------------------------------------------------
// Git-ops seam (mt#2831) — injectable so unit tests never spawn real git.
// ---------------------------------------------------------------------------

export interface DispatchRecoveryGitStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/** Real vs. injected process/filesystem access the command needs. Default impl uses Bun.spawn + Bun.file. */
export interface DispatchRecoveryGitOps {
  status(sessionDir: string): Promise<DispatchRecoveryGitStatus>;
  lastCommitAtMs(sessionDir: string): Promise<number | null>;
  detectDefaultBranch(sessionDir: string): Promise<string | null>;
  commitsAheadOfBase(sessionDir: string, baseBranch: string): Promise<number | null>;
  readHandoff(sessionDir: string, sessionId: string): Promise<string | null>;
}

async function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { code: proc.exitCode ?? 1, stdout };
}

/** Real git-ops implementation (Bun.spawn + Bun.file). Mirrors `src/adapters/mcp/session-workspace.ts`'s probe wiring (mt#2646). */
export function createRealDispatchRecoveryGitOps(): DispatchRecoveryGitOps {
  return {
    async status(sessionDir) {
      const { code, stdout } = await runGit(["status", "--porcelain=v1"], sessionDir);
      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];
      if (code !== 0) return { staged, unstaged, untracked };
      const lines = stdout.trim() ? stdout.trim().split("\n") : [];
      for (const line of lines) {
        if (line.length < 3) continue;
        const x = line[0];
        const y = line[1];
        const filePath = line.slice(3);
        if (x === "?" && y === "?") {
          untracked.push(filePath);
        } else {
          if (x && x !== " " && x !== "?") staged.push(filePath);
          if (y && y !== " " && y !== "?") unstaged.push(filePath);
        }
      }
      return { staged, unstaged, untracked };
    },
    async lastCommitAtMs(sessionDir) {
      try {
        const { code, stdout } = await runGit(["log", "-1", "--format=%ct"], sessionDir);
        if (code !== 0) return null;
        const epochSeconds = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(epochSeconds) ? epochSeconds * 1000 : null;
      } catch {
        return null;
      }
    },
    async detectDefaultBranch(sessionDir) {
      try {
        const { code, stdout } = await runGit(
          ["symbolic-ref", "refs/remotes/origin/HEAD"],
          sessionDir
        );
        if (code !== 0) return null;
        return parseDefaultBranchRef(stdout);
      } catch {
        return null;
      }
    },
    async commitsAheadOfBase(sessionDir, baseBranch) {
      try {
        const { code, stdout } = await runGit(
          ["rev-list", "--count", `origin/${baseBranch}..HEAD`],
          sessionDir
        );
        return code === 0 ? parseCommitsAheadOutput(stdout) : null;
      } catch {
        return null;
      }
    },
    async readHandoff(sessionDir, sessionId) {
      try {
        const handoffPath = `${sessionDir}/.minsky/sessions/${sessionId}/handoff.md`;
        const file = Bun.file(handoffPath);
        return (await file.exists()) ? await file.text() : null;
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const tasksDispatchRecoverParams = {
  taskId: {
    schema: z.string(),
    description:
      'Task ID whose most recent subagent dispatch should be probed for recovery (e.g. "mt#2831").',
    required: true,
  },
} satisfies CommandParameterMap;

export interface DispatchRecoveryEscalationAttempt {
  invocationId: string;
  attemptNumber: number;
  startedAt: string;
  outcome: string | null;
}

export function createTasksDispatchRecoverCommand(
  getSessionProvider: () => Promise<SessionProviderInterface>,
  getTaskService: () => TaskServiceInterface,
  getTracker: () => SubagentDispatchTracker | null,
  deps: {
    gitOps?: DispatchRecoveryGitOps;
    now?: () => Date;
    staleMs?: number;
  } = {}
) {
  const gitOps = deps.gitOps ?? createRealDispatchRecoveryGitOps();
  const now = deps.now ?? (() => new Date());
  const staleMs = deps.staleMs ?? DISPATCH_RECOVERY_STALE_MS;

  return {
    id: "tasks.dispatch-recover",
    name: "dispatch-recover",
    description:
      "Server-side detect/classify/prepare for a died/stalled subagent dispatch (mt#2831): " +
      "captures session state, classifies the outcome, and returns a ready-to-dispatch " +
      "continuation prompt. Does NOT dispatch anything — the caller must redispatch the " +
      "returned prompt via the Agent tool. A healthy in-flight dispatch is left untouched " +
      '(returns status: "healthy"). Refuses a 3rd attempt for the same dispatch chain ' +
      '(returns status: "escalate").',
    parameters: tasksDispatchRecoverParams,
    execute: async (params: InferParams<typeof tasksDispatchRecoverParams>) => {
      const { normalizeTaskIdInput } = await import("@minsky/domain/tasks/commands/shared-helpers");
      const taskId = normalizeTaskIdInput(params.taskId);

      // Scope to the SAME task-status window the dispatch-watchdog producer flags
      // (`computeDispatchWatchdogFlags`, src/cockpit/dispatch-watchdog.ts): only
      // IN-PROGRESS/IN-REVIEW tasks have a dispatch worth recovering. A stale
      // subagent_invocations row for a task that has since gone DONE/CLOSED/BLOCKED
      // (or was never advanced past TODO/PLANNING) is not a live recovery target —
      // refuse before touching the tracker, rather than probing/classifying state
      // for a task no dispatch is actually running against.
      let taskStatus: string | undefined;
      try {
        taskStatus = await getTaskService().getTaskStatus(taskId);
      } catch {
        taskStatus = undefined; // fail-open: an unresolvable status does not block recovery
      }
      if (taskStatus && taskStatus !== "IN-PROGRESS" && taskStatus !== "IN-REVIEW") {
        return {
          success: true,
          status: "not-in-flight" as const,
          taskId,
          message:
            `Task ${taskId} is in status ${taskStatus}, not IN-PROGRESS/IN-REVIEW — no dispatch ` +
            `is currently expected to be running against it. Nothing to recover.`,
        };
      }

      const tracker = getTracker();
      if (!tracker) {
        return {
          success: false,
          error: "Subagent dispatch tracker unavailable — cannot look up invocation history.",
          taskId,
        };
      }

      const latest = await tracker.getLatestInvocationForTask(taskId);
      if (!latest) {
        return {
          success: true,
          status: "no-dispatch" as const,
          taskId,
          message: `No subagent_invocations row found for ${taskId} — nothing to recover.`,
        };
      }

      if (latest.endedAt) {
        return {
          success: true,
          status: "not-in-flight" as const,
          taskId,
          outcome: latest.outcome,
          message:
            `The most recent dispatch for ${taskId} already has an endedAt timestamp — it was ` +
            `already classified (outcome: ${latest.outcome}), not silently stuck. Nothing to recover.`,
        };
      }

      const subagentSessionId = latest.subagentSessionId;
      if (!subagentSessionId) {
        return {
          success: false,
          error: `Latest invocation for ${taskId} has no subagentSessionId — cannot resolve a session workspace to probe.`,
          taskId,
        };
      }

      const sessionProvider = await getSessionProvider();
      let sessionDir: string;
      let sessionRecord: SessionRecord | null;
      try {
        sessionRecord = await sessionProvider.getSession(subagentSessionId);
        sessionDir = await resolveSessionDirectory(subagentSessionId, sessionProvider);
      } catch (err) {
        return {
          success: false,
          error: `Could not resolve session workspace for ${subagentSessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          taskId,
        };
      }

      // ── Staleness gate: a healthy in-flight dispatch is left untouched. ──────────────
      const lastCommitAtMs = await gitOps.lastCommitAtMs(sessionDir);
      const startedAtMs = latest.startedAt.getTime();
      const staleness = computeDispatchStaleness(
        startedAtMs,
        lastCommitAtMs,
        now().getTime(),
        staleMs
      );

      if (!staleness.stale) {
        return {
          success: true,
          status: "healthy" as const,
          taskId,
          sessionId: subagentSessionId,
          staleForMs: staleness.staleForMs,
          message:
            `Dispatch for ${taskId} has recent activity (last activity ${staleness.staleForMs}ms ` +
            `ago, below the ${staleMs}ms stale window) — treated as healthy, no action taken.`,
        };
      }

      // ── 2-attempt bound: refuse a 3rd attempt, return an escalation package. ─────────
      const attemptNumber = latest.attemptNumber ?? 1;
      if (attemptNumber >= 2) {
        const chain = await tracker.getInvocationChainForTask(taskId);
        const attempts: DispatchRecoveryEscalationAttempt[] = (
          chain.length > 0 ? chain : [latest]
        ).map((row) => ({
          invocationId: row.id,
          attemptNumber: row.attemptNumber ?? 1,
          startedAt: row.startedAt.toISOString(),
          outcome: row.outcome ?? null,
        }));
        return {
          success: true,
          status: "escalate" as const,
          taskId,
          sessionId: subagentSessionId,
          escalation: {
            taskId,
            attempts,
            message:
              `Dispatch for ${taskId} has gone silent again after a prior auto-resume ` +
              `(attempt ${attemptNumber}). The 2-attempt bound is reached — no further ` +
              `auto-resume will be attempted. An operator/orchestrator decision is needed: ` +
              `diagnose why this dispatch keeps stalling (repeated infra failure? a task ` +
              `that genuinely exceeds a single dispatch's capacity? rate-limiting — check ` +
              `SubagentDispatchTracker.getEscalation() before assuming death) before retrying ` +
              `manually.`,
          },
        };
      }

      // ── Build the probe (git-diff presence, commits-ahead, handoff.md). ─────────────
      const gitStatus = await gitOps.status(sessionDir);
      const baseBranch =
        sessionRecord?.pullRequest?.baseBranch ?? (await gitOps.detectDefaultBranch(sessionDir));
      const commitsAheadOfBase = baseBranch
        ? await gitOps.commitsAheadOfBase(sessionDir, baseBranch)
        : null;
      const handoffFileContent = await gitOps.readHandoff(sessionDir, subagentSessionId);

      const probe: DispatchRecoveryProbeResult = buildDispatchRecoveryProbe({
        session: subagentSessionId,
        gitStatus,
        commitsAheadOfBase,
        baseBranch,
        pr: {
          number: sessionRecord?.pullRequest?.number ?? null,
          url: sessionRecord?.pullRequest?.url ?? null,
          state: sessionRecord?.pullRequest?.state ?? null,
          // Live review-thread fetch is intentionally out of scope for this on-demand
          // command (see module header "Does NOT cover") — the continuation prompt
          // instructs the resumed agent to check review state itself once redispatched.
          latestReview: null,
          reviewFetchError: null,
        },
        handoffFileContent,
        handoffMaxLines: DISPATCH_RECOVERY_PROBE_HANDOFF_MAX_LINES,
      });

      const classification = classifyDispatchRecoveryState({
        dirtyFileCount: probe.dirtyFileCount,
        commitsAheadOfBase: probe.commitsAheadOfBase,
        handoffExists: probe.handoff.exists,
      });

      const continuationPrompt = buildDispatchRecoveryContinuationPrompt({
        taskId,
        sessionId: subagentSessionId,
        sessionDir,
        agentType: latest.agentType,
        classification,
        dirtyFileCount: probe.dirtyFileCount,
        commitsAheadOfBase: probe.commitsAheadOfBase,
        handoffExists: probe.handoff.exists,
        handoffFirstLines: probe.handoff.firstLines,
        prNumber: probe.pr.number,
        prUrl: probe.pr.url,
        latestReviewState: probe.pr.latestReview?.state ?? null,
        attemptNumber: attemptNumber + 1,
        originalStartedAt: latest.startedAt.toISOString(),
      });

      // Close out the ORIGINAL row: it has now been classified as died/stalled. The
      // classification describes the ORIGINAL attempt's final state, not the new
      // (about-to-be-redispatched) attempt's — record it there, and mark the row
      // ended (mt#2831 R1 BLOCKING #1). This is also what makes the tracker's
      // heuristic upsert path's "prefer the OPEN row" selection meaningful: once
      // this UPDATE lands, at most one row per subagentSessionId is open at a time
      // in the common (non-racing) case.
      await tracker.recordSubagentInvocation({
        id: latest.id,
        taskId,
        subagentSessionId,
        agentType: latest.agentType,
        suggestedModel: latest.suggestedModel,
        startedAt: latest.startedAt,
        endedAt: now(),
        outcome: classification,
        summary: `Classified as ${classification} by tasks.dispatch-recover; superseded by attempt ${attemptNumber + 1}.`,
      });

      // Insert the NEW (resumed) row. Pessimistic default outcome + no endedAt —
      // mirrors the dispatch-time convention in tasks.dispatch Step 5: this row
      // describes the worst-case observed state until the eventual SubagentStop
      // classifies it for real. It must NOT carry `classification`, which describes
      // the ORIGINAL attempt (recorded above), not this brand-new one.
      const newInvocationId = await tracker.recordDispatchRecoveryAttempt({
        taskId,
        subagentSessionId,
        agentType: latest.agentType,
        suggestedModel: latest.suggestedModel,
        startedAt: now(),
        outcome: "crashed-no-output",
        resumedFromInvocationId: latest.id,
        attemptNumber: attemptNumber + 1,
        summary: `Auto-resumed via tasks.dispatch-recover from invocation ${latest.id} (attempt ${attemptNumber}, classified ${classification}).`,
      });

      if (!newInvocationId) {
        log.warn("[tasks.dispatch-recover] Failed to record recovery attempt row", { taskId });
      } else {
        // mt#2831 R1 BLOCKING #1: overwrite the current-invocation marker so the
        // NEXT SubagentStop event for this session binds to THIS (resumed) row —
        // not the just-closed original. Best-effort; a write failure here just
        // means the eventual Stop event falls back to the heuristic upsert path.
        const { writeCurrentInvocationMarker } = await import(
          "@minsky/domain/session/current-invocation-marker"
        );
        await writeCurrentInvocationMarker(sessionDir, subagentSessionId, newInvocationId);
      }

      return {
        success: true,
        status: "recover" as const,
        taskId,
        sessionId: subagentSessionId,
        sessionDir,
        agentType: latest.agentType,
        suggestedModel: latest.suggestedModel,
        classification,
        attemptNumber: attemptNumber + 1,
        resumedFromInvocationId: latest.id,
        newInvocationId,
        stateSummary: probe,
        continuationPrompt,
      };
    },
  };
}
