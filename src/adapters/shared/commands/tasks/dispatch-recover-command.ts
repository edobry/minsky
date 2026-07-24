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
 * When the tracker itself is unavailable (mt#3017) — no persistence
 * configured, or the DB connection did not resolve within
 * `registry-setup.ts`'s bounded init timeout — this command does NOT return
 * a bare error. It degrades to `status: "tracker-unavailable"` plus a
 * `manualFallback` block naming the concrete git/gh commands an operator can
 * run by hand to reach the SAME classification the automated path would
 * have computed (see `buildTrackerUnavailableResponse`).
 *
 * ### Covers
 * - API drops mid-dispatch (the dispatch goes silent with no further commits
 *   AND no session-scoped MCP tool-call activity — see mt#3086 below).
 * - Watchdog stalls (>= the stale window with no commit or tool-call activity).
 * - mt#3086: a genuinely alive-but-quiet dispatch (working locally — reading
 *   code, running tests, no commit yet) is NOT misclassified as dead, because
 *   the staleness check also consults `presence_claims` session-grain
 *   activity (refreshed by every MCP tool call the subagent makes that
 *   touches its own session — see `computeDispatchStaleness`'s docstring
 *   for the full mechanism and why this stands in for the harness
 *   transcript JSONL mtime, which is unreachable here).
 * - mt#3149: a dispatch with an open PR or commits ahead of base is NEVER
 *   classified `crashed-no-output`, including at the 2-attempt-bound
 *   escalate path — the probe (git status, commits-ahead, PR state) is now
 *   built and consulted BEFORE that check, not only on the "recover" branch,
 *   so an escalation can no longer echo a stale/pessimistic-default DB
 *   `outcome` value for a row that was never actually re-classified against
 *   live state (see `classifyDispatchRecoveryState`'s docstring and the
 *   escalate branch below for the full incident and fix).
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
 * - A dispatch that makes literally ZERO Minsky-MCP-routed tool calls for an
 *   entire stale window (e.g. stuck inside one very long non-MCP subprocess
 *   call) — this remains invisible to every signal here, commit or
 *   presence-based (mt#3086's documented residual blind spot).
 * - A `SendMessage`-resumed continuation of an ALREADY-CLOSED invocation row
 *   (`endedAt` set before the resume) — this command returns `not-in-flight`
 *   before ever reaching the staleness check for that case (see
 *   `computeDispatchStaleness`'s docstring for the SendMessage-resume
 *   confound in full, including the case where it DOES stay visible).
 * - The full periodic sweep the dispatch-watchdog producer performs
 *   (`src/cockpit/dispatch-watchdog.ts`), including its `system_events`
 *   activity signal — this command's on-demand staleness check uses
 *   dispatch-start-time, last-commit-time, and (mt#3086) presence-claim
 *   activity, but not `system_events` (see `computeDispatchStaleness`'s
 *   docstring for the documented tradeoff).
 *
 * @see mt#2831 — this task
 * @see mt#3086 — false-positive staleness fix + double-dispatch race documentation
 * @see mt#3149 — false-positive crashed-no-output fix (PR/commit liveness at escalate time)
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
import type { PromptType } from "@minsky/domain/session/prompt-generation";

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

// ---------------------------------------------------------------------------
// Activity-signal seam (mt#3086) — injectable so unit tests never spawn real
// Postgres. Real vs. injected access to the tool-call-activity liveness
// signal `computeDispatchStaleness` now consults alongside commit activity.
// ---------------------------------------------------------------------------

/**
 * Real vs. injected access to the presence-claim-derived tool-call-activity
 * signal (mt#3086). See `computeDispatchStaleness`'s docstring
 * (`@minsky/domain/session/dispatch-recovery-classifier`) for why this
 * signal — not the harness transcript JSONL mtime — is what the staleness
 * check consults, and for the documented residual blind spot.
 */
export interface DispatchRecoveryActivityOps {
  /**
   * Ms epoch of the most recent `presence_claims` refresh for the given
   * Minsky session (subject_kind = "session"), or null when unavailable
   * (no persistence provider, no DB connection, no claim ever written for
   * this session — e.g. every tool call so far omitted `task`/`sessionId`,
   * or the dispatch is brand new).
   */
  lastPresenceActivityAtMs(subagentSessionId: string): Promise<number | null>;
}

/**
 * Real implementation: reads the session-grain `presence_claims` row(s) for
 * `subagentSessionId` and returns the freshest `lastRefreshedAt` across all
 * actors that have touched this session (an MCP tool call from EITHER the
 * subagent itself or, in principle, another actor sharing the workspace —
 * in practice a session workspace has exactly one active occupant, so this
 * is effectively "did the subagent make any Minsky-routed tool call
 * recently"). Fail-open: any resolution error (no persistence provider, no
 * DB, a query failure) returns null rather than throwing — this signal is
 * best-effort, matching the rest of the presence-claims write/read path's
 * posture (`src/mcp/server.ts`'s `writeSessionAttachment`,
 * `tasks.claims.list`).
 */
export function createRealDispatchRecoveryActivityOps(
  getPersistenceProvider: () => unknown
): DispatchRecoveryActivityOps {
  return {
    async lastPresenceActivityAtMs(subagentSessionId) {
      try {
        const provider = getPersistenceProvider() as
          | { getDatabaseConnection?: () => Promise<unknown> }
          | undefined;
        if (!provider?.getDatabaseConnection) {
          // R1 (mt#3086): log every structurally-unavailable branch, not just the
          // catch-block failure path below — a silent null here degrades the
          // staleness check back to its pre-mt#3086 commit-only behavior with no
          // diagnostic trail, reintroducing the original false-positive risk
          // invisibly. debug (not warn): a persistence-less CLI/test context is a
          // routine, expected shape, not an operational anomaly.
          log.debug(
            "[tasks.dispatch-recover] lastPresenceActivityAtMs: no persistence provider / getDatabaseConnection — presence signal unavailable",
            { subagentSessionId }
          );
          return null;
        }
        const db = await provider.getDatabaseConnection();
        if (!db) {
          log.debug(
            "[tasks.dispatch-recover] lastPresenceActivityAtMs: getDatabaseConnection() resolved no connection — presence signal unavailable",
            { subagentSessionId }
          );
          return null;
        }
        const { buildPresenceClaimRepository } = await import("@minsky/domain/presence/index");
        const repo = buildPresenceClaimRepository(db);
        if (!repo) {
          log.debug(
            "[tasks.dispatch-recover] lastPresenceActivityAtMs: buildPresenceClaimRepository returned null — presence signal unavailable",
            { subagentSessionId }
          );
          return null;
        }
        // Threshold is irrelevant here — we only read the raw timestamp and let
        // computeDispatchStaleness's OWN staleMs decide freshness, not presence's
        // separate 15-min TTL annotation. listClaims orders desc by
        // lastRefreshedAt, so the first row is already the freshest.
        const claims = await repo.listClaims("session", subagentSessionId, Number.MAX_SAFE_INTEGER);
        const freshest = claims[0]?.lastRefreshedAt;
        if (!freshest) return null;
        const ms = Date.parse(freshest);
        return Number.isFinite(ms) ? ms : null;
      } catch (err) {
        // R1 (mt#3086): warn (not debug) — unlike the "no persistence configured"
        // branches above (a routine, expected shape in CLI/test contexts), reaching
        // this catch means resolution STARTED (a provider/db/repo existed) and then
        // threw — a DI-wiring break, an unexpected dynamic-import shape, or a real
        // query failure. That is an operational anomaly worth surfacing, not a
        // silent degrade.
        log.warn(
          "[tasks.dispatch-recover] lastPresenceActivityAtMs resolution failed unexpectedly (degrading to no presence signal)",
          { subagentSessionId, error: err instanceof Error ? err.message : String(err) }
        );
        return null;
      }
    },
  };
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

/**
 * Whether a PR `state` (as recorded on the session record / probe) represents
 * a still-open (or draft) PR — i.e. one whose existence is direct, positive
 * evidence the dispatch pushed something (mt#3149 SC1/SC2). A draft PR still
 * required a push to create, so it counts. `null`/`undefined`/`"closed"`/
 * `"merged"` are not live — no PR, or a PR that no longer represents
 * in-flight work.
 */
export function isLivePrState(state: string | null | undefined): boolean {
  return state === "open" || state === "draft";
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

/**
 * Map the ORIGINAL dispatch's stored `agentType` (e.g. "implementer",
 * "refactorer") to the `PromptType` used to re-generate a guard-valid
 * continuation prompt via `generateSubagentPrompt` (mt#2947).
 *
 * The recovery narrative built by `buildDispatchRecoveryContinuationPrompt`
 * is always write/commit-oriented (see its per-classification instructions —
 * "commit them", "create the PR", "drive it to convergence"). The
 * "review"/"audit" `PromptType` shapes force a READ-ONLY operating envelope
 * and OMIT commit/PR instructions entirely (`generateSinglePrompt`'s
 * `type === "review" | "audit"` branches) — using either here would ship a
 * prompt that both tells the agent to commit AND tells it commits are
 * structurally denied. So only the write-capable prompt types
 * ("implementation" / "refactor" / "cleanup") are honored; anything else
 * (an unmapped/legacy agent type, or one that maps to "review"/"audit")
 * falls back to "implementation" — the common shape for git-diff-tracked
 * session work, which is exactly what this recovery classifier is scoped to
 * (see the module header's "Covers" list).
 */
export function promptTypeForRecovery(
  agentType: string,
  agentTypeToPromptType: Record<string, PromptType>
): PromptType {
  const mapped = agentTypeToPromptType[agentType];
  return mapped === "refactor" || mapped === "cleanup" ? mapped : "implementation";
}

/**
 * Structured guidance for the manual state-capture an operator/orchestrator
 * can run when the tracker is unavailable and automated classification
 * cannot proceed (mt#3017 SC3). Mirrors the exact commands
 * `createRealDispatchRecoveryGitOps` runs and the exact decision table
 * `classifyDispatchRecoveryState` (`packages/domain/src/session/
 * dispatch-recovery-classifier.ts`) applies, so a human following these
 * steps arrives at the SAME classification the automated path would have
 * computed.
 */
export interface DispatchRecoveryManualFallback {
  message: string;
  steps: string[];
  classificationGuide: string;
  retryGuidance: string;
}

/**
 * The SC3 degraded-response shape for a genuinely-unavailable tracker
 * (mt#3017). Exported as a named type — rather than left inline on
 * `buildTrackerUnavailableResponse`'s return signature — so a caller that
 * parses `tasks.dispatch-recover` results can narrow on the
 * `status: "tracker-unavailable"` discriminant against a stable contract
 * (mt#3017 R1 NON-BLOCKING #2). Not (yet) folded into a full discriminated
 * union across every `status` value this command can return
 * (`healthy` / `recover` / `escalate` / `not-in-flight` / `no-dispatch` /
 * `tracker-unavailable`) — that broader typing pass is out of scope for
 * this fix, which only introduces the new shape.
 */
export interface DispatchRecoveryTrackerUnavailableResult {
  success: false;
  status: "tracker-unavailable";
  error: string;
  taskId: string;
  sessionId: string | null;
  sessionDir: string | null;
  manualFallback: DispatchRecoveryManualFallback;
}

/**
 * Build the SC3 degraded response for a genuinely-unavailable tracker
 * (mt#3017). Distinct from a bare `{ success: false, error }` — names
 * concrete manual fallback steps so an operator isn't stuck when the
 * automated recovery path can't run.
 *
 * Best-effort resolves the session workspace via the SESSION provider (an
 * independent lookup path from the tracker — `getSessionByTaskId`), so the
 * guidance can point at a concrete session/workspace when available instead
 * of only generic instructions.
 */
export async function buildTrackerUnavailableResponse(
  taskId: string,
  getSessionProvider: () => Promise<SessionProviderInterface>
): Promise<DispatchRecoveryTrackerUnavailableResult> {
  let fallbackSessionId: string | null = null;
  let fallbackSessionDir: string | null = null;
  try {
    const sessionProvider = await getSessionProvider();
    const sessionRecord = await sessionProvider.getSessionByTaskId(taskId);
    if (sessionRecord) {
      fallbackSessionId = sessionRecord.sessionId;
      fallbackSessionDir = await resolveSessionDirectory(sessionRecord.sessionId, sessionProvider);
    }
  } catch {
    // Best-effort — the session provider is a separate dependency from the
    // tracker; a failure here just means the guidance falls back to fully
    // generic instructions below rather than naming a concrete workspace.
  }

  const workspaceHint = fallbackSessionDir
    ? `the session workspace at ${fallbackSessionDir}`
    : `the session workspace (resolve it via session_get(task: "${taskId}") or session_list first)`;

  return {
    success: false,
    status: "tracker-unavailable" as const,
    error: "Subagent dispatch tracker unavailable — cannot look up invocation history.",
    taskId,
    sessionId: fallbackSessionId,
    sessionDir: fallbackSessionDir,
    manualFallback: {
      message:
        `Automatic recovery cannot run: the subagent dispatch tracker could not be reached ` +
        `(no persistence configured, or the server's tracker-initialization timeout was hit). ` +
        `To manually assess ${taskId}'s dispatch, inspect ${workspaceHint} and run:`,
      steps: [
        "git status --porcelain=v1  (any staged/unstaged/untracked entries = a dirty tree)",
        "git log -1 --format=%ct  (timestamp of the last commit; compare to now for staleness)",
        ".minsky/sessions/<sessionId>/handoff.md  (does a handoff note already exist?)",
        "git rev-list --count origin/<base-branch>..HEAD  (commits ahead of base = unmerged work landed)",
        "gh pr view  (if a PR was opened: is it still open, and what's the latest review state?)",
      ],
      classificationGuide:
        "dirty tree + handoff.md present -> partial-committed-handoff-written; " +
        "dirty tree, no handoff.md -> partial-uncommitted-no-handoff (the class most likely to " +
        "need attention — stranded work with no note); " +
        "clean tree, commits ahead of base -> committed-no-pr (drive an already-open PR to " +
        "convergence, or create one if none exists); " +
        "clean tree, no commits ahead -> crashed-no-output (nothing was produced; redispatch fresh).",
      retryGuidance:
        "Retry tasks.dispatch-recover shortly — the tracker retries its DB connection on every " +
        "call and typically becomes available within seconds of a server restart.",
    },
  };
}

export function createTasksDispatchRecoverCommand(
  getSessionProvider: () => Promise<SessionProviderInterface>,
  getTaskService: () => TaskServiceInterface,
  /**
   * Async (mt#3017) — `registry-setup.ts`'s `getTracker` AWAITS an in-flight
   * DB-connection resolution (bounded by a timeout) rather than returning
   * null immediately on every call that races the async init. This closes
   * the root-cause race that produced "Subagent dispatch tracker
   * unavailable" on the very first call after a process restart even though
   * the DB was healthy. A `null` return here now means the tracker is
   * GENUINELY unavailable (no persistence configured, or the DB connection
   * did not resolve within the timeout) — see the `tracker-unavailable`
   * degraded-response branch below for what the caller gets in that case.
   */
  getTracker: () => Promise<SubagentDispatchTracker | null>,
  /**
   * Optional (mt#3086) — used to build the real `DispatchRecoveryActivityOps`
   * (presence-claim liveness signal) when `deps.activityOps` is not injected.
   * Best-effort: when omitted or when it throws/returns an unusable provider,
   * `createRealDispatchRecoveryActivityOps`'s own try/catch degrades to
   * `lastPresenceActivityAtMs` always resolving null — the staleness check
   * simply falls back to its pre-mt#3086 behavior (commit + dispatch-start
   * only), never a hard failure.
   */
  getPersistenceProvider: () => unknown = () => undefined,
  deps: {
    gitOps?: DispatchRecoveryGitOps;
    activityOps?: DispatchRecoveryActivityOps;
    now?: () => Date;
    staleMs?: number;
  } = {}
) {
  const gitOps = deps.gitOps ?? createRealDispatchRecoveryGitOps();
  const activityOps =
    deps.activityOps ?? createRealDispatchRecoveryActivityOps(getPersistenceProvider);
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
      '(returns status: "healthy") — as of mt#3086 this check ALSO consults recent ' +
      "presence-claim (session-scoped MCP tool-call) activity, not just commits, so a " +
      "dispatch that is quietly working (reading code, running tests, no commit yet) is " +
      "no longer misclassified as dead; see the activitySource field on a healthy result " +
      '("commit" | "presence" | "dispatch-start") for which signal decided it. Refuses a ' +
      '3rd attempt for the same dispatch chain (returns status: "escalate"). If the ' +
      "dispatch tracker itself is unavailable, degrades to actionable manual-recovery " +
      'guidance instead of a bare error (returns status: "tracker-unavailable"). ' +
      "DOUBLE-DISPATCH RACE WINDOW (mt#3086): calling this on a dispatch that is actually " +
      "still alive and then redispatching attempt N+1 anyway (e.g. after a false-positive " +
      "or a hasty manual override) puts TWO agents in the SAME Minsky session workspace " +
      "at once. Observed symptoms from the originating incident: uncommitted work " +
      "appearing that the new attempt didn't write, a merge conflict resolving and " +
      "committing out from under the new attempt between two of its own status checks, a " +
      '`git push` rejected as "remote already at a newer commit," and a PR already ' +
      "existing with the same diagnosis the new attempt was about to produce. Both " +
      "attempts CAN converge on a correct end state (idempotent work + luck), but this is " +
      "not guaranteed — treat any of these symptoms as a signal to stop and check whether " +
      "another attempt is genuinely still running before continuing.",
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

      const tracker = await getTracker();
      if (!tracker) {
        // Internal wiring detail (which factory, which timeout) belongs in the
        // DEBUG log, not the operator-facing manualFallback text (mt#3017 R1
        // NON-BLOCKING #1) — see registry-setup.ts's getTracker for the
        // memoized-promise + bounded-timeout implementation this traces to.
        log.debug(
          "[tasks.dispatch-recover] getTracker() returned null — degrading to manual fallback",
          {
            taskId,
          }
        );
        return await buildTrackerUnavailableResponse(taskId, getSessionProvider);
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
      // mt#3086: consults presence-claim activity ALONGSIDE commit activity — a
      // dispatch that is genuinely alive but quiet (reading code, running tests,
      // making session-scoped MCP tool calls with no commit yet) is no longer
      // misclassified as dead. See computeDispatchStaleness's docstring for the
      // full signal rationale and the documented residual blind spot.
      const lastCommitAtMs = await gitOps.lastCommitAtMs(sessionDir);
      const lastPresenceActivityAtMs =
        await activityOps.lastPresenceActivityAtMs(subagentSessionId);
      const startedAtMs = latest.startedAt.getTime();
      const staleness = computeDispatchStaleness(
        startedAtMs,
        lastCommitAtMs,
        now().getTime(),
        staleMs,
        lastPresenceActivityAtMs
      );

      if (!staleness.stale) {
        const activityDescription =
          staleness.activitySource === "presence"
            ? "recent tool-call activity (no commit yet)"
            : staleness.activitySource === "commit"
              ? "a recent commit"
              : "no activity beyond dispatch start (still within the stale window)";
        return {
          success: true,
          status: "healthy" as const,
          taskId,
          sessionId: subagentSessionId,
          staleForMs: staleness.staleForMs,
          activitySource: staleness.activitySource,
          message:
            `Dispatch for ${taskId} has ${activityDescription} (last activity ` +
            `${staleness.staleForMs}ms ago, below the ${staleMs}ms stale window) — treated as ` +
            `healthy, no action taken.`,
        };
      }

      // ── Build the probe (git-diff presence, commits-ahead, handoff.md, PR). ─────────
      // mt#3149: this block was MOVED ABOVE the 2-attempt-bound check below (it used
      // to run only on the "recover" path, AFTER that check). That ordering was the
      // actual root cause of the mt#3149 incident: once a dispatch reached its 2nd
      // stale classification, the code took the escalate branch and returned WITHOUT
      // EVER calling `gitOps.commitsAheadOfBase` or looking at `sessionRecord.pullRequest`
      // — it just echoed whatever `outcome` was already stored on the DB row, which for
      // a row created by a prior recovery attempt is a hardcoded PESSIMISTIC DEFAULT
      // (`"crashed-no-output"`, see `recordDispatchRecoveryAttempt` below), never a real,
      // live-probed classification. This was NOT a "wrong ref/worktree" bug in the git
      // probe itself (the probe code was correct) — the probe was simply never reached
      // for the escalate case. Computing it here, unconditionally, before either branch
      // is decided, closes that gap for both paths.
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

      // mt#3149 SC1/SC2: an open (or draft) PR is direct, positive evidence of prior
      // output, consulted INDEPENDENTLY of `commitsAheadOfBase` — see
      // `classifyDispatchRecoveryState`'s docstring for the full rationale.
      const hasOpenPr = isLivePrState(probe.pr.state);
      const hasLivenessEvidence = hasOpenPr || (probe.commitsAheadOfBase ?? 0) > 0;

      const classification = classifyDispatchRecoveryState({
        dirtyFileCount: probe.dirtyFileCount,
        commitsAheadOfBase: probe.commitsAheadOfBase,
        handoffExists: probe.handoff.exists,
        hasOpenPr,
      });

      // ── 2-attempt bound: refuse a 3rd attempt, return an escalation package. ─────────
      const attemptNumber = latest.attemptNumber ?? 1;
      if (attemptNumber >= 2) {
        const chain = await tracker.getInvocationChainForTask(taskId);
        const rows = chain.length > 0 ? chain : [latest];
        // mt#3149 SC1/SC2: the LATEST row is still open (`endedAt` unset) — its stored
        // `outcome` was never produced by a live classification (see the probe-ordering
        // comment above), so substitute the classification just computed from THIS
        // call's live probe. Every OTHER (already-closed) row in the chain keeps its
        // stored outcome, since those genuinely were classified — with a live probe —
        // at closure time.
        const attempts: DispatchRecoveryEscalationAttempt[] = rows.map((row) => ({
          invocationId: row.id,
          attemptNumber: row.attemptNumber ?? 1,
          startedAt: row.startedAt.toISOString(),
          outcome: row.id === latest.id ? classification : (row.outcome ?? null),
        }));

        // mt#3149 SC4: distinguish "we observed it die" (this command never has a
        // process-level signal — only workspace/PR proxies, so that phrase is never
        // accurate) from "we saw no activity in the window," and do not recommend
        // redispatch-into-the-same-session on the weaker signal — especially not when
        // there IS positive evidence (an open PR, or commits ahead) that the dispatch
        // produced real output and may simply be between tool calls or wrapping up.
        const message = hasLivenessEvidence
          ? `Dispatch for ${taskId} went quiet again after a prior auto-resume ` +
            `(attempt ${attemptNumber}) — no activity was observed in the stale window. ` +
            `This is NOT confirmed death: the dispatch has ${
              hasOpenPr && probe.pr.number
                ? `an open PR (#${probe.pr.number})`
                : `${probe.commitsAheadOfBase ?? 0} commit(s) ahead of base`
            }, positive evidence it produced real output. Do NOT redispatch the ` +
            `continuation prompt into this session on the strength of this escalation alone — ` +
            `doing so risks running two agents against the same workspace/branch at once. ` +
            `Verify independently (check for further pushes, PR/review activity, or ask the ` +
            `operator) before taking any action.`
          : `Dispatch for ${taskId} has gone silent again after a prior auto-resume ` +
            `(attempt ${attemptNumber}) — no activity, no PR, and no commits were observed in ` +
            `the stale window. This reflects an absence of observed output, not a confirmed ` +
            `process crash. The 2-attempt bound is reached — no further auto-resume will be ` +
            `attempted. An operator/orchestrator decision is needed: diagnose why this ` +
            `dispatch keeps stalling (repeated infra failure? a task that genuinely exceeds a ` +
            `single dispatch's capacity? rate-limiting — check ` +
            `SubagentDispatchTracker.getEscalation() before assuming death) before retrying ` +
            `manually.`;

        return {
          success: true,
          status: "escalate" as const,
          taskId,
          sessionId: subagentSessionId,
          escalation: {
            taskId,
            attempts,
            hasLivenessEvidence,
            message,
          },
        };
      }

      const recoveryInstructions = buildDispatchRecoveryContinuationPrompt({
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

      // mt#2947: wrap the recovery narrative through the SAME generator
      // `session.generate_prompt` uses (`generateSubagentPrompt`), so the
      // returned continuationPrompt carries the `<!-- minsky:prompt:v1 -->`
      // watermark the PreToolUse dispatch guard
      // (`.minsky/hooks/check-prompt-watermark.ts`) requires before it will
      // allow an Agent-tool dispatch that references a session directory or
      // a session write tool. Without this, the documented "redispatch the
      // continuationPrompt VERBATIM via the Agent tool" protocol
      // (`/orchestrate`'s "Dispatch watchdog and resume protocol" section,
      // `.minsky/hooks/inject-dispatch-watchdog.ts`) is unexecutable — the
      // guard denies it outright (mt#2947's originating incident).
      //
      // `workspacePath` is passed explicitly as `sessionDir` (PR #2119 R1
      // BLOCKING #1): on the "standalone" harness path, `generateSubagentPrompt`
      // reads `.claude/agents/<type>.md` / `.claude/skills/<name>/SKILL.md`
      // from `workspacePath`, which defaults to the CALLING PROCESS's
      // `process.cwd()` when omitted. This command runs server-side inside
      // the MCP server process — its cwd has no necessary relationship to
      // the SESSION workspace the resumed agent will actually operate in
      // (`sessionDir`, resolved above). Omitting `workspacePath` would read
      // skill/agent definitions from wherever the server happens to be
      // running, not from the session branch's own checkout — a correctness
      // risk (stale/divergent skill content) this recovery path should not
      // carry, even though the sibling `session.generate_prompt` command
      // (`prompt-command.ts`) currently has the same omission on its own
      // callsite (a pre-existing gap out of scope for this fix, since that
      // command is invoked BY the same session's own agent, not server-side
      // on its behalf).
      const { generateSubagentPrompt, PROMPT_TYPE_TO_AGENT_TYPE } = await import(
        "@minsky/domain/session/prompt-generation"
      );
      const agentTypeToPromptType = Object.fromEntries(
        Object.entries(PROMPT_TYPE_TO_AGENT_TYPE).map(([promptType, agent]) => [agent, promptType])
      ) as Record<string, PromptType>;
      const continuationPrompt = generateSubagentPrompt({
        sessionDir,
        sessionId: subagentSessionId,
        taskId,
        type: promptTypeForRecovery(latest.agentType, agentTypeToPromptType),
        instructions: recoveryInstructions,
        workspacePath: sessionDir,
      }).prompt;

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
        // not the just-closed original. Best-effort; a write failure here must
        // NOT abort the recover command — the marker is a deterministic-
        // attribution OPTIMIZATION (the tracker's heuristic open-row-first
        // fallback exists for exactly the case where no marker is available),
        // not a correctness requirement for returning the continuation prompt.
        // mt#2831 R3 BLOCKING #2: `writeCurrentInvocationMarker` itself already
        // swallows write errors internally (returns `false`), but the dynamic
        // `import(...)` above it is NOT inside that try/catch — a module
        // resolution failure there would throw and abort this whole command.
        // Wrap the entire block so ANY failure here (import or write) degrades
        // to a logged warning, never a thrown error.
        try {
          const { writeCurrentInvocationMarker } = await import(
            "@minsky/domain/session/current-invocation-marker"
          );
          const wrote = await writeCurrentInvocationMarker(
            sessionDir,
            subagentSessionId,
            newInvocationId
          );
          if (!wrote) {
            log.warn("[tasks.dispatch-recover] Failed to write current-invocation marker", {
              taskId,
              sessionDir,
            });
          }
        } catch (err) {
          log.warn("[tasks.dispatch-recover] current-invocation marker write threw unexpectedly", {
            taskId,
            sessionDir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
