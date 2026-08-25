/**
 * Production wiring for the unattended task supervisor (mt#4571).
 *
 * The decision-making lives in `@minsky/domain/supervision/supervision-tick`;
 * this module binds it to the three real actuators the daemon already owns and
 * nothing more:
 *
 *  1. `resolveTaskWorkspace` — bind-or-create the child's workspace (mt#2752)
 *  2. `startDrivenSession` — spawn a genuine `claude` child (mt#2750)
 *  3. `sendDrivenSessionInput` — hand that child its generated prompt
 *
 * **Why not `tasks_dispatch`.** It does not spawn anything. It creates or walks
 * the task, starts a session, and ends at Step 4 — generating a prompt for a
 * HARNESS to hand to its Agent tool, gated on `hasNativeSubagentSupport()`. A
 * sweeper has no harness, so calling it and assuming an agent appears is exactly
 * the premise mt#4571's planning pass falsified. What this module reuses from
 * that path is the PROMPT (`generateSubagentPrompt`), which is the part that
 * carries the operating envelope, the skills and the scope bounds.
 *
 * Kept out of `sweepers.ts` (which is already 2,800+ lines) in the same split
 * every recent sweep uses — `dispatch-watchdog.ts`, `deploy-smoke-sweep.ts`,
 * `conversation-presence-sweep.ts` — with only the thin `start*Sweeper`
 * registration living there.
 *
 * @see packages/domain/src/supervision/supervision-tick.ts — the tick this feeds
 * @see ./driven-session-launch.ts — `resolveTaskWorkspace`
 * @see ./driven-session-host.ts — `startDrivenSession` / `sendDrivenSessionInput`
 */
import { log } from "@minsky/shared/logger";
import { runSupervisionTick } from "@minsky/domain/supervision/supervision-tick";
import { DrizzleSupervisionStore } from "@minsky/domain/supervision/supervision-store";
import type {
  DispatchChildInput,
  DispatchChildResult,
  DrivenSessionLiveness,
  SupervisionTickDeps,
  SupervisionTickResult,
} from "@minsky/domain/supervision/types";
import { computeUmbrellaFrontier } from "@minsky/domain/tasks/umbrella-frontier";
import { createCachedSqlDbGetter, getServerTaskDetailDeps } from "./db-providers";
import { createUmbrellaFrontierDeps } from "../adapters/shared/commands/tasks/orchestrate-command";
import { resolveTaskWorkspace } from "./driven-session-launch";
import {
  drivenSessionRegistry,
  isTerminalStatus,
  sendDrivenSessionInput,
  startDrivenSession,
  type DrivenSessionRecord,
} from "./driven-session-host";
import { drivenSessionMcpServerNames } from "./driven-session-mcp-servers";
import {
  createDrivenInitObserver,
  createDrivenResultObserver,
  createDrivenSessionPersistObserver,
} from "./driven-session-launch";

/** Cached SQL handle, negative results retried on every call. */
const getSupervisionDb = createCachedSqlDbGetter({ cacheNegative: false });

/**
 * Map a driven-session record's status onto the liveness the tick reasons about.
 *
 * The mapping is deliberate at every value, because three of the five are not
 * obvious:
 *
 *  - `spawned` / `running` -> **live**. A real child is working.
 *  - `exited` -> **exited**. A CLEAN exit: `exitStatus` resolves `exited` only
 *    for `code === 0` or an explicit stop request. The tick treats this
 *    differently from a crash, because a clean exit with the task still open is
 *    a STRANDED child (mt#4571 SC10) rather than a failure.
 *  - `crashed` / `unrecoverable` -> **crashed**. Non-zero exit, a signal, or a
 *    workspace that is gone (`unrecoverableReason`). All are failures.
 *  - `reconnecting` -> **unknown**, which keeps the WIP slot. This is the one
 *    worth arguing: the session driver died and mt#3038 deliberately does NOT
 *    respawn it eagerly (lazy-resume-only), so the child is not working — but
 *    the CONVERSATION is durable and recoverable, and settling it would discard
 *    a resumable session and free a slot for a duplicate. A record stuck here
 *    forever is surfaced by the semantic-stall threshold, which is the right
 *    response: tell the operator, do not silently reclaim.
 *  - no record at all -> **unknown**. Load-bearing, not a fallback: a restarted
 *    daemon has no in-memory record of a child it started before the restart,
 *    and reporting that as an exit would strand every dispatch across every
 *    restart — the exact thing this feature has to survive.
 */
export function livenessFromRecord(record: DrivenSessionRecord | undefined): DrivenSessionLiveness {
  if (!record) return "unknown";
  if (record.status === "reconnecting") return "unknown";
  if (!isTerminalStatus(record.status)) return "live";
  return record.status === "exited" ? "exited" : "crashed";
}

/**
 * Build the instructions a supervised child receives.
 *
 * Deliberately short and deliberately BOUNDED: the child is a full agent with
 * the ordinary lifecycle skills, so its instructions do not need to restate the
 * lifecycle. What they must carry is the fact that nobody is watching, which
 * changes what the child should do when it hits a decision — escalate through
 * the asks surface rather than wait in chat for a reply that will not come.
 */
export function buildSupervisedChildInstructions(input: {
  taskId: string;
  umbrellaTaskId: string;
}): string {
  return [
    `Implement ${input.taskId}, a child of umbrella ${input.umbrellaTaskId}.`,
    "",
    "You were started by the unattended task supervisor (mt#4571), not by a person.",
    "The operator is away and is NOT reading this conversation. That changes two things:",
    "",
    "- Do not end a turn asking a question in chat — nobody will answer it. If you need a",
    "  principal-level decision, file an ask (`asks_create`); it reaches the operator's inbox",
    "  independently of this conversation.",
    "- Drive the task through its normal lifecycle to merge. Run `/implement-task` and follow it,",
    "  including driving the PR to convergence.",
    "",
    "The supervisor dispatches only. It will not merge for you, answer asks for you, or change",
    "this task's scope.",
  ].join("\n");
}

/**
 * Spawn a `claude` child on a task and hand it its prompt.
 *
 * The prompt is generated the same way `tasks_dispatch` generates it, so a
 * supervised child gets the same operating envelope, skills and bounds as one an
 * agent dispatches by hand.
 */
export async function dispatchSupervisedChild(
  input: DispatchChildInput
): Promise<DispatchChildResult> {
  const workspace = await resolveTaskWorkspace(input.taskId);

  const { generateSubagentPrompt } = await import("@minsky/domain/session/prompt-generation");
  const promptResult = generateSubagentPrompt({
    sessionDir: workspace.sessionDir,
    sessionId: workspace.minskySessionId,
    // `generateSubagentPrompt` expects the plain id, matching tasks_dispatch.
    taskId: input.taskId.replace(/^mt#/, "").replace(/^#/, ""),
    type: "implementation",
    instructions: buildSupervisedChildInstructions({
      taskId: input.taskId,
      umbrellaTaskId: input.umbrellaTaskId,
    }),
    ...(input.model ? { model: input.model } : {}),
  });

  const { record } = startDrivenSession({
    mcpServerNames: drivenSessionMcpServerNames(),
    cwd: workspace.sessionDir,
    taskId: input.taskId,
    minskySessionId: workspace.minskySessionId,
    ...(input.model ? { model: input.model } : {}),
    // The same three observers POST /api/driven-session wires for every driven
    // session — cost capture, durable persistence, and the spawn-time identity
    // link. A supervised session is an ordinary driven session in every respect
    // except who asked for it, so it must not be missing from those surfaces.
    onHarnessSessionLinked: createDrivenInitObserver({ adoptionReason: "initial" }),
    onResultSummary: createDrivenResultObserver(),
    onStateChange: createDrivenSessionPersistObserver(),
  });

  // `startDrivenSession` returns synchronously without waiting for the child's
  // `init` event; stdin is already open, so the prompt can be written now and
  // the child reads it when it is ready.
  const delivered = sendDrivenSessionInput(record, promptResult.prompt, { echo: true });
  if (!delivered) {
    throw new Error(
      `spawned driven session ${record.localId} for ${input.taskId} but its stdin rejected the prompt (status ${record.status})`
    );
  }

  return { drivenSessionLocalId: record.localId, minskySessionId: workspace.minskySessionId };
}

/**
 * Assemble the tick's dependencies against the real daemon services.
 *
 * Returns null when the database or the task services are unavailable — the
 * caller reports that as a FAILED tick rather than a quiet no-op, because
 * "cannot do the work" and "nothing to do" are different states and only the
 * second is healthy.
 */
export async function buildSupervisionTickDeps(): Promise<SupervisionTickDeps | null> {
  const db = await getSupervisionDb();
  if (!db) return null;

  const taskDeps = await getServerTaskDetailDeps();
  if (!taskDeps) return null;

  const frontierDeps = createUmbrellaFrontierDeps(taskDeps.taskGraphService, taskDeps.taskService);

  return {
    store: new DrizzleSupervisionStore(db),
    computeFrontier: (umbrellaTaskId, statusFilter) =>
      computeUmbrellaFrontier(umbrellaTaskId, statusFilter, frontierDeps),
    getTaskStatuses: async (taskIds) => {
      const tasks = await taskDeps.taskService.getTasks(taskIds);
      const out = new Map<string, string>();
      for (const task of tasks) if (task.status) out.set(task.id, task.status);
      return out;
    },
    drivenSessionLiveness: (localId) => livenessFromRecord(drivenSessionRegistry.get(localId)),
    // Read from `driven_sessions`, NOT `drivenSessionRegistry` (mt#4571 SC6).
    // The registry is this process's memory; the session the supervisor would
    // collide with is frequently one another process started — an operator
    // driving the same child by hand from a second daemon, or one this daemon
    // started before its last restart. An in-process check would miss both and
    // put two `claude` processes in one working tree, because
    // `resolveTaskWorkspace` reuses an existing workspace rather than making a
    // second one.
    hasLiveWriterForTask: async (taskId) => {
      const { listNonTerminalDrivenSessions } = await import(
        "@minsky/domain/transcripts/driven-session-registry-store"
      );
      const live = await listNonTerminalDrivenSessions(db);
      return live.some((row) => row.taskId === taskId);
    },
    dispatchChild: dispatchSupervisedChild,
    now: () => new Date(),
    logWarn: (message) => log.warn(message),
  };
}

/**
 * One supervision sweep tick. Exported so the sweeper registration in
 * `./sweepers.ts` stays a two-line binding and this module owns the behaviour.
 */
export async function runTaskSupervisionSweepTick(
  deps?: SupervisionTickDeps,
  signal?: AbortSignal
): Promise<{ ok: boolean; result: SupervisionTickResult | null }> {
  const resolved = deps ?? (await buildSupervisionTickDeps());
  if (!resolved) {
    log.debug("cockpit: task supervision sweep: services unavailable, skipping tick");
    return { ok: false, result: null };
  }

  // mt#4335's abandonment signal, threaded to the tick (PR #3356 R1). Honouring
  // it matters more for this sweep than for a read-only one: each remaining
  // iteration spawns a real `claude` process and binds a workspace, so an
  // abandoned tick that keeps going keeps ACTUATING, not merely reading.
  const result = await runSupervisionTick(resolved, signal);

  for (const advance of result.advances) {
    if (advance.dispatched.length > 0 || advance.settled.length > 0) {
      log.info(`cockpit: supervision advanced ${advance.umbrellaTaskId}`, {
        dispatched: advance.dispatched,
        settled: advance.settled,
        completed: advance.completed,
      });
    }
  }

  return { ok: result.ok, result };
}
