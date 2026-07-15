/**
 * Periodic sweeper for post-merge adoption verification.
 *
 * Cousin of merge-state-sweeper.ts. Picks up recently-DONE tasks, extracts
 * adoption signals from each task's spec via the fixed-schema signal-extraction
 * module, greps production callsites in the current codebase for those signals,
 * and files `mt#X-adoption` follow-up tasks for any gaps found.
 *
 * ## Why post-merge, not pre-merge
 *
 * Adoption verification cannot be done pre-merge (see task spec mt#1630 for
 * the full rationale). The sweeper runs on a daily cadence against tasks that
 * became DONE in the last 14 days, checking whether the codebase has actually
 * adopted the behaviors those tasks introduced.
 *
 * ## Signal extraction (v1: fixed schema, no LLM)
 *
 * v1 uses regex patterns over spec text. LLM-based extraction is deferred
 * until false-positive/false-negative rates have empirical data from v1.
 * See src/domain/adoption/signal-extraction.ts for pattern definitions.
 *
 * ## Cadence
 *
 * Default: 24 hours (86_400_000 ms). Configurable via
 * ADOPTION_SWEEPER_INTERVAL_MS. Disabled by default; set
 * ADOPTION_SWEEPER_ENABLED=true to activate. Env-var wiring is in place
 * (mt#1811); the sweeper only needs operator opt-in.
 *
 * ## Idempotent task creation
 *
 * Before filing an `mt#X-adoption` follow-up, the sweeper searches for an
 * existing task with that title. If one already exists, it is not duplicated.
 * This makes the sweeper safe to re-run without accumulating redundant tasks.
 *
 * ## TOCTOU analysis
 *
 * ### Window 1: Read atomicity
 * The sweeper reads task status (via tasks_search DONE), then fetches the spec
 * (tasks_spec_get), then greps source files. These are three separate reads.
 * Race: a task could be re-opened between the tasks_search and the spec fetch.
 * Accept-rationale: Idempotent — if a task is re-opened, the adoption follow-up
 * task still correctly names the gap; re-opening the parent does not invalidate
 * the follow-up. The follow-up can be closed manually if it becomes irrelevant.
 *
 * ### Window 2: Decision-action gap
 * Between detecting a missing callsite (decision) and filing the follow-up task
 * (action), the parent task could be re-opened or the callsite could be added by
 * another PR landing on main in the same window.
 * Accept-rationale: Idempotent + check-before-create. The sweeper searches for an
 * existing adoption task before creating. If a callsite was just added, the NEXT
 * sweep cycle will detect it and not re-file. The false-positive rate is bounded
 * by the sweep cadence (24h). This is the "Automatic recovery" accept class.
 *
 * ### Window 3: Stale-read
 * The sweeper reads the spec once per task per cycle, from the MCP server's live
 * DB. No in-process cache. The codebase grep reads the filesystem at call time.
 * If a task's spec was updated (e.g., criterion removed) between the tasks_search
 * and the spec fetch, the sweeper may use a spec that's slightly stale.
 * Accept-rationale: Idempotent — a stale-spec read produces at worst a spurious
 * adoption task that names a criterion the task owner can ignore. The next cycle
 * reads the fresh spec. Automatic recovery within 24h.
 *
 * ## Covers / Does NOT cover
 *
 * ### Covers
 * - Tasks DONE within the configurable window (default 14 days) whose spec
 *   contains adoption signals (function exports, class exports, hook registrations,
 *   MCP tool IDs, command IDs, lifecycle states) with zero callsites in the
 *   production codebase.
 * - Idempotent re-runs: does not duplicate adoption follow-up tasks.
 *
 * ### Does NOT cover
 * - Behavioral adoption (e.g., "is the function actually invoked in production
 *   at expected QPS?"). That is a runtime-observability concern. Owner: deferred.
 * - Tasks that became DONE before the configurable window (default: 14 days).
 *   Rationale: old tasks are unlikely to have fresh adoption gaps.
 * - False negatives from signal extraction: the fixed-schema patterns cover
 *   the common cases but miss signals that appear only in spec prose without
 *   code-pattern form. Owner: LLM-extraction follow-up task (file when v1
 *   false-negative rate has empirical data).
 * - Operator dashboard / cockpit surface. v1 emits structured log events;
 *   the cockpit feed widget is a separate concern owned by mt#1034 family.
 */

import type { ReviewerConfig } from "./config";
import { parsePositiveIntEnv } from "./config";
import { callMcp } from "./mcp-client";
import { log } from "./logger";
import {
  extractAdoptionSignals,
  buildGrepPattern,
} from "@minsky/shared/adoption/signal-extraction";
import type { AdoptionSignal } from "@minsky/shared/adoption/signal-extraction";

// ---------------------------------------------------------------------------
// Public configuration interface
// ---------------------------------------------------------------------------

export interface AdoptionSweeperConfig {
  /** Whether the sweeper is enabled. Default: false (operator opt-in). */
  enabled: boolean;
  /** Sweep interval in milliseconds. Default: 86_400_000 (24 hours). */
  intervalMs: number;
  /** Minsky MCP endpoint URL. */
  mcpUrl: string;
  /** Minsky MCP authentication token. */
  mcpToken: string;
  /**
   * How many days back to look for recently-DONE tasks.
   * Default: 14 days.
   */
  lookbackDays: number;
}

export function loadAdoptionSweeperConfig(): AdoptionSweeperConfig {
  return {
    enabled: (process.env["ADOPTION_SWEEPER_ENABLED"] ?? "false") === "true",
    // 24-hour default: daily cadence calibrated against Minsky's merge frequency.
    // See spec mt#1630 §Plan-time decisions for rationale.
    // Strict-positive parse (mt#1811 cascade-defense): malformed values would
    // feed NaN to setInterval. parsePositiveIntEnv throws at boot time.
    intervalMs: parsePositiveIntEnv("ADOPTION_SWEEPER_INTERVAL_MS", 86_400_000),
    mcpUrl: process.env["MINSKY_MCP_URL"] ?? "",
    mcpToken: process.env["MINSKY_MCP_AUTH_TOKEN"] ?? "",
    lookbackDays: parsePositiveIntEnv("ADOPTION_SWEEPER_LOOKBACK_DAYS", 14),
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Per-task adoption check outcome. */
export interface TaskAdoptionCheckResult {
  taskId: string;
  signalsFound: number;
  callsitesFound: number;
  gapsFiled: number;
  /** Names of adoption tasks filed (for logging). */
  followUpTaskIds: string[];
  /** Non-fatal errors encountered while processing this task. */
  errors: string[];
}

/** Result of a single sweep cycle. */
export interface AdoptionSweepResult {
  /** ISO 8601 timestamp when the sweep started. */
  startedAt: string;
  /** Number of DONE tasks examined. */
  tasksChecked: number;
  /** Number of tasks with at least one adoption signal. */
  tasksWithSignals: number;
  /** Total follow-up adoption tasks filed across all tasks. */
  totalGapsFiled: number;
  /** Errors encountered (non-fatal — sweep continues after each). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// MCP call helper (mirrors merge-state-sweeper.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Call a Minsky MCP tool via HTTP.
 *
 * Thin adapter over the shared {@link callMcp} helper (mt#1821) — preserves
 * the legacy `string | null` return shape so adoption-sweeper callsites
 * don't change. The shared helper performs the MCP initialize handshake
 * and caches the session id; without it the server rejects every
 * `tools/call` with `-32600 "first request must be initialize"`.
 *
 * Timeout: 15s, matching the prior in-file `AbortController` + `setTimeout`
 * implementation. Passed explicitly so any future change to the helper's
 * default does not silently regress sweep behavior.
 *
 * Observability: `callMcp` emits structured `log.warn` events with the
 * `adoption_sweeper.mcp` prefix; the legacy
 * `adoption_sweeper.mcp_{http_error,rpc_error,fetch_error}` events are
 * preserved at the same prefix.
 */
async function callMcpTool(
  mcpUrl: string,
  mcpToken: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string | null> {
  const result = await callMcp(
    toolName,
    args,
    { mcpUrl, mcpToken },
    { logPrefix: "adoption_sweeper.mcp", timeoutMs: 15_000 }
  );
  return result.ok ? result.contentText : null;
}

// ---------------------------------------------------------------------------
// Callsite detection (grep over spec signals)
// ---------------------------------------------------------------------------

/**
 * Count production callsites for a given adoption signal by grepping the
 * repo via the MCP `repo_search` tool. Falls back to 0 on error (non-fatal).
 *
 * `repo.search` runs `git grep -n` and returns `{ success, output }` where
 * `output` is the raw grep text — one `<path>:<line>:<content>` line per
 * match. (mt#2781: this function previously parsed imagined `matches` /
 * `results` keys the tool never returns, so the count was ALWAYS 0 and the
 * sweeper filed adoption follow-ups even for adopted signals. The test
 * fixture asserted the same imagined shape, masking the bug.)
 *
 * Counting semantics: one count per matching grep line in a production
 * TypeScript file (see {@link isProductionTsPath}). Lines without a
 * `<path>:` prefix — blanks, and `git grep`'s "Binary file X matches"
 * shape — carry no colon-terminated path and are dropped by the parse
 * guard below.
 */
async function countCallsites(
  mcpUrl: string,
  mcpToken: string,
  signal: AdoptionSignal
): Promise<number> {
  const pattern = buildGrepPattern(signal);

  const resultText = await callMcpTool(mcpUrl, mcpToken, "repo_search", {
    pattern,
  });

  if (!resultText) return 0;

  try {
    const parsed = JSON.parse(resultText) as {
      success?: boolean;
      output?: string;
    };
    if (parsed.success === false || typeof parsed.output !== "string") return 0;

    return parsed.output.split("\n").filter((line) => {
      const sep = line.indexOf(":");
      if (sep <= 0) return false; // blank, malformed, or "Binary file ... matches" line
      return isProductionTsPath(line.slice(0, sep));
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Test-infrastructure path segments excluded from the production-callsite
 * count (mt#2781, PR #1947 R1): suffix-based test files plus the repo's
 * test-infrastructure directory conventions.
 */
const TEST_PATH_SEGMENTS = [
  "/tests/",
  "/__tests__/",
  "/__fixtures__/",
  "/test-utils/",
  "/test-helpers/",
] as const;

/**
 * Path-based predicate: is this a production (non-test) TypeScript file?
 *
 * Production means any `.ts` file in the repo — `src/`, `packages/`,
 * `services/`, `scripts/`, hooks — that is not a test file (`.test.ts`,
 * `.spec.ts`) and does not live under a test-infrastructure directory.
 * Deliberately repo-wide (PR #1947 R1 BLOCKING): production source spans
 * multiple roots post-`packages/` extraction, so scoping the grep to `src/`
 * would undercount adopted signals and re-create the false-positive
 * follow-up bug this task fixes.
 */
function isProductionTsPath(filePath: string): boolean {
  if (!filePath.endsWith(".ts")) return false;
  if (filePath.endsWith(".test.ts") || filePath.endsWith(".spec.ts")) return false;
  const normalized = `/${filePath}`;
  return !TEST_PATH_SEGMENTS.some((segment) => normalized.includes(segment));
}

// ---------------------------------------------------------------------------
// Adoption follow-up task deduplication
// ---------------------------------------------------------------------------

/**
 * Check whether an adoption follow-up task for a given parent task already
 * exists. Returns the existing task ID if found, null otherwise.
 *
 * TOCTOU note: this check-before-create is the decision-action gap mitigation
 * documented in the module docstring. If two sweeper instances race (unlikely
 * for a daily single-process sweeper), idempotency at the search level means
 * at worst one spurious duplicate is created; the operator can close it.
 */
async function findExistingAdoptionTask(
  mcpUrl: string,
  mcpToken: string,
  parentTaskId: string,
  signalName: string
): Promise<string | null> {
  const searchText = await callMcpTool(mcpUrl, mcpToken, "tasks_search", {
    query: `${parentTaskId} adoption ${signalName}`,
    limit: 5,
  });

  if (!searchText) return null;

  try {
    const parsed = JSON.parse(searchText) as {
      success?: boolean;
      tasks?: Array<{ id?: string; title?: string }>;
      data?: Array<{ id?: string; title?: string }>;
    };
    const tasks = parsed.tasks ?? parsed.data ?? [];
    // Look for an exact title match of the form "mt#X adoption: <signalName>"
    const targetTitle = `${parentTaskId} adoption: ${signalName}`;
    const existing = tasks.find(
      (t) => typeof t.title === "string" && t.title.toLowerCase() === targetTitle.toLowerCase()
    );
    return existing?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core sweep logic (exported for tests)
// ---------------------------------------------------------------------------

/** Dependencies injected into runAdoptionSweep (for testability). */
export interface AdoptionSweepDeps {
  mcpUrl: string;
  mcpToken: string;
  lookbackDays: number;
}

/**
 * Narrow shape of a task from tasks_list response.
 *
 * `updatedAt` is included so we can post-filter by recency if the backend
 * doesn't honor the `since` parameter (PR #1034 R1 BLOCKING: backstop in
 * case `tasks_list` returns tasks outside the lookback window).
 */
interface TaskSearchItem {
  id?: string;
  taskId?: string;
  title?: string;
  status?: string;
  updatedAt?: string;
  closedAt?: string;
  completedAt?: string;
}

/**
 * Run a single adoption sweep cycle.
 *
 * 1. List tasks with status=DONE updated within the last lookbackDays.
 * 2. For each task, fetch the spec via tasks_spec_get.
 * 3. Extract adoption signals from the spec.
 * 4. For each signal, count production callsites via repo_search.
 * 5. If callsites=0 and no existing adoption task, file a follow-up task.
 *
 * PR #1034 R1 BLOCKING fix: uses `tasks_list` with `since` (and post-filter
 * fallback) instead of `tasks_search` so the configured lookback window is
 * actually applied.
 */
export async function runAdoptionSweep(deps: AdoptionSweepDeps): Promise<AdoptionSweepResult> {
  const startedAt = new Date().toISOString();
  const result: AdoptionSweepResult = {
    startedAt,
    tasksChecked: 0,
    tasksWithSignals: 0,
    totalGapsFiled: 0,
    errors: [],
  };

  log.info("adoption_sweeper.run_started", {
    event: "adoption_sweeper.run_started",
    timestamp: startedAt,
    lookbackDays: deps.lookbackDays,
  });

  // Step 1: List DONE tasks updated within the lookback window.
  // PR #1034 R1 BLOCKING fix: previously used `tasks_search` without a recency
  // filter, so `lookbackDays` was silently ignored. Now uses `tasks_list` with
  // `since` AND post-filters by timestamp as a backstop for backends that
  // don't honor `since`.
  const sinceMs = Date.now() - deps.lookbackDays * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();

  let tasks: TaskSearchItem[] = [];
  try {
    const listText = await callMcpTool(deps.mcpUrl, deps.mcpToken, "tasks_list", {
      status: "DONE",
      since: sinceIso,
      limit: 500,
    });

    if (!listText) {
      result.errors.push("tasks_list returned no content");
      log.warn("adoption_sweeper.list_failed", {
        event: "adoption_sweeper.list_failed",
        reason: "no_content",
      });
      return result;
    }

    const parsed = JSON.parse(listText) as {
      success?: boolean;
      tasks?: TaskSearchItem[];
      data?: TaskSearchItem[];
    };
    const raw = parsed.tasks ?? parsed.data ?? [];

    // Post-filter by timestamp as a backstop. Use whichever of
    // `updatedAt`/`closedAt`/`completedAt` is present; if none is present,
    // include the task (we'd rather over-include than miss recent work).
    tasks = raw.filter((t) => {
      const ts = t.updatedAt ?? t.closedAt ?? t.completedAt;
      if (!ts) return true;
      const parsedTs = Date.parse(ts);
      if (Number.isNaN(parsedTs)) return true;
      return parsedTs >= sinceMs;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to list DONE tasks: ${msg}`);
    log.error("adoption_sweeper.list_error", {
      event: "adoption_sweeper.list_error",
      error: msg,
    });
    return result;
  }

  result.tasksChecked = tasks.length;
  log.info("adoption_sweeper.tasks_found", {
    event: "adoption_sweeper.tasks_found",
    count: tasks.length,
  });

  // Step 2–5: Process each task.
  // Cap concurrency at 3 to avoid rate-limiting the MCP server.
  const CONCURRENCY = 3;
  const chunks: TaskSearchItem[][] = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    chunks.push(tasks.slice(i, i + CONCURRENCY));
  }

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (task) => {
        const taskId = task.id ?? task.taskId;
        if (!taskId) return;

        const checkResult = await checkTaskAdoption(deps, taskId);

        if (checkResult.errors.length > 0) {
          result.errors.push(...checkResult.errors);
        }

        if (checkResult.signalsFound > 0) {
          result.tasksWithSignals++;
        }

        result.totalGapsFiled += checkResult.gapsFiled;

        log.info("adoption_sweeper.task_checked", {
          event: "adoption_sweeper.task_checked",
          taskId,
          signalsFound: checkResult.signalsFound,
          callsitesFound: checkResult.callsitesFound,
          gapsFiled: checkResult.gapsFiled,
          followUpTaskIds: checkResult.followUpTaskIds,
        });
      })
    );
  }

  log.info("adoption_sweeper.run_completed", {
    event: "adoption_sweeper.run_completed",
    ...result,
  });

  return result;
}

/**
 * Check adoption signals for a single task. Returns a per-task result.
 * Non-fatal: errors are collected and returned rather than thrown.
 */
async function checkTaskAdoption(
  deps: AdoptionSweepDeps,
  taskId: string
): Promise<TaskAdoptionCheckResult> {
  const checkResult: TaskAdoptionCheckResult = {
    taskId,
    signalsFound: 0,
    callsitesFound: 0,
    gapsFiled: 0,
    followUpTaskIds: [],
    errors: [],
  };

  // Fetch spec.
  let specText = "";
  try {
    const specResult = await callMcpTool(deps.mcpUrl, deps.mcpToken, "tasks_spec_get", {
      taskId,
    });

    if (!specResult) {
      // No spec: skip silently (many tasks have no spec).
      return checkResult;
    }

    const parsed = JSON.parse(specResult) as {
      success?: boolean;
      content?: string;
      spec?: string;
    };
    specText = parsed.content ?? parsed.spec ?? "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checkResult.errors.push(`Failed to fetch spec for ${taskId}: ${msg}`);
    return checkResult;
  }

  if (!specText) return checkResult;

  // Extract signals.
  const signals = extractAdoptionSignals(specText);
  checkResult.signalsFound = signals.length;

  if (signals.length === 0) return checkResult;

  // For each signal, count callsites and file follow-up if needed.
  for (const signal of signals) {
    try {
      const callsiteCount = await countCallsites(deps.mcpUrl, deps.mcpToken, signal);
      checkResult.callsitesFound += callsiteCount;

      if (callsiteCount > 0) {
        // Signal is adopted — no follow-up needed.
        continue;
      }

      // Check for existing adoption task before filing.
      const existingId = await findExistingAdoptionTask(
        deps.mcpUrl,
        deps.mcpToken,
        taskId,
        signal.name
      );

      if (existingId) {
        // Already filed — idempotent skip.
        log.info("adoption_sweeper.gap_already_tracked", {
          event: "adoption_sweeper.gap_already_tracked",
          taskId,
          signalName: signal.name,
          existingFollowUpId: existingId,
        });
        continue;
      }

      // File a new adoption follow-up task.
      const followUpTitle = `${taskId} adoption: ${signal.name}`;
      const followUpSpec = buildFollowUpSpec(taskId, signal);

      try {
        const createResult = await callMcpTool(deps.mcpUrl, deps.mcpToken, "tasks_create", {
          title: followUpTitle,
          spec: followUpSpec,
          // mt#2778 caller audit: `status: "TODO"` removed — tasks.create does
          // not declare a status param (new tasks default to TODO), so the key
          // was silently dropped at the boundary; post-mt#2778 it would be
          // rejected. Behavior unchanged.
        });

        if (createResult) {
          const parsed = JSON.parse(createResult) as {
            success?: boolean;
            taskId?: string;
            task?: { id?: string };
          };
          const newId = parsed.taskId ?? parsed.task?.id ?? "unknown";
          checkResult.gapsFiled++;
          checkResult.followUpTaskIds.push(newId);

          log.info("adoption_sweeper.gap_filed", {
            event: "adoption_sweeper.gap_filed",
            parentTaskId: taskId,
            signalKind: signal.kind,
            signalName: signal.name,
            followUpTaskId: newId,
          });

          // Emit task.auto_created event via MCP (mt#2134).
          // Best-effort: failure is logged but never blocks the sweep.
          try {
            await callMcpTool(deps.mcpUrl, deps.mcpToken, "events_emit", {
              eventType: "task.auto_created",
              payload: {
                taskId: newId,
                title: followUpTitle,
                createdBy: "adoption-sweeper",
                sourceRule: signal.name,
              },
              actor: "adoption-sweeper",
              relatedTaskId: taskId,
            });
          } catch (emitErr: unknown) {
            log.warn("adoption_sweeper.event_emit_failed", {
              event: "adoption_sweeper.event_emit_failed",
              parentTaskId: taskId,
              followUpTaskId: newId,
              error: emitErr instanceof Error ? emitErr.message : String(emitErr),
            });
          }
        }
      } catch (createErr) {
        const msg = createErr instanceof Error ? createErr.message : String(createErr);
        checkResult.errors.push(
          `Failed to create adoption task for ${taskId}/${signal.name}: ${msg}`
        );
      }
    } catch (signalErr) {
      const msg = signalErr instanceof Error ? signalErr.message : String(signalErr);
      checkResult.errors.push(`Error processing signal ${signal.name} for ${taskId}: ${msg}`);
    }
  }

  return checkResult;
}

/**
 * Build the spec body for an adoption follow-up task.
 */
function buildFollowUpSpec(parentTaskId: string, signal: AdoptionSignal): string {
  return [
    `## Summary`,
    ``,
    `Adoption gap detected by post-merge adoption sweeper (mt#1630).`,
    ``,
    `Parent task **${parentTaskId}** introduced a \`${signal.kind}\` artifact named \`${signal.name}\``,
    `(spec line ${signal.sourceLine}), but no production callsites were found in the codebase.`,
    ``,
    `## What to do`,
    ``,
    `1. Confirm that \`${signal.name}\` is actually supposed to have production callers.`,
    `   (Some exports are library-only and adoption is external; those can be closed.)`,
    `2. If adoption is expected: find the callsites that should use \`${signal.name}\` and`,
    `   wire them in.`,
    `3. If the signal was extracted in error (spec prose, not a real export): close this task`,
    `   with a note explaining why.`,
    ``,
    `## Signal details`,
    ``,
    `- **Kind**: \`${signal.kind}\``,
    `- **Name**: \`${signal.name}\``,
    `- **Spec source line**: ${signal.sourceLine}`,
    `- **Parent task**: ${parentTaskId}`,
    `- **Detected by**: mt#1630 adoption sweeper`,
    ``,
    `## Cross-references`,
    ``,
    `- Parent task: ${parentTaskId}`,
    `- Sweeper task: mt#1630`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Scheduler (in-process setInterval)
// ---------------------------------------------------------------------------

/**
 * Start the adoption sweeper on an in-process interval.
 *
 * Same pattern as merge-state-sweeper.ts. Opt-in via
 * ADOPTION_SWEEPER_ENABLED=true (disabled by default; env-var wiring
 * is in place via mt#1811). Requires MINSKY_MCP_URL + MINSKY_MCP_AUTH_TOKEN.
 *
 * Returns an object with a `stop()` method to clean up the interval, or null
 * if the sweeper is disabled or credentials are missing.
 */
export function startAdoptionSweeper(
  _config: ReviewerConfig,
  sweeperConfig: AdoptionSweeperConfig
): { stop: () => void } | null {
  if (!sweeperConfig.enabled) {
    log.info("adoption_sweeper.disabled", {
      event: "adoption_sweeper.disabled",
      message:
        "Adoption sweeper is disabled (ADOPTION_SWEEPER_ENABLED=false). " +
        "Set ADOPTION_SWEEPER_ENABLED=true to activate.",
    });
    return null;
  }

  if (!sweeperConfig.mcpUrl || !sweeperConfig.mcpToken) {
    log.warn("adoption_sweeper.missing_credentials", {
      event: "adoption_sweeper.missing_credentials",
      message:
        "ADOPTION_SWEEPER_ENABLED=true but MINSKY_MCP_URL or MINSKY_MCP_AUTH_TOKEN is not set. " +
        "Adoption sweeper will not start.",
    });
    return null;
  }

  log.info("adoption_sweeper.enabled", {
    event: "adoption_sweeper.enabled",
    intervalMs: sweeperConfig.intervalMs,
    mcpUrl: sweeperConfig.mcpUrl,
    lookbackDays: sweeperConfig.lookbackDays,
  });

  let isRunning = false;

  const deps: AdoptionSweepDeps = {
    mcpUrl: sweeperConfig.mcpUrl,
    mcpToken: sweeperConfig.mcpToken,
    lookbackDays: sweeperConfig.lookbackDays,
  };

  const handle = setInterval(() => {
    if (isRunning) {
      log.warn("adoption_sweeper.skip_reentrant", {
        event: "adoption_sweeper.skip_reentrant",
        message: "Previous adoption sweep still in progress; skipping this interval tick.",
      });
      return;
    }
    isRunning = true;

    runAdoptionSweep(deps)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error("adoption_sweeper.cycle_error", {
          event: "adoption_sweeper.cycle_error",
          error: message,
        });
      })
      .finally(() => {
        isRunning = false;
      });
  }, sweeperConfig.intervalMs);

  return {
    stop: () => clearInterval(handle),
  };
}
