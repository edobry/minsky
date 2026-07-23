// Standalone-creation duplicate probe (mt#2813).
//
// Split out of parallel-work-guard.ts (which was pushing past the
// custom/max-lines 1500-line hard error) — this module is imported by, and
// wired into, that file's `tasks_create` PreToolUse entrypoint.
//
// The duplicate-CHILD matcher in parallel-work-guard.ts (mt#1435/mt#2683)
// only fires when `parent`/`parentTaskId` is set — a standalone (parentless)
// `tasks_create` has no sibling pool to compare against. Evidence this leaves
// a real gap: mt#2734 was filed standalone on 2026-07-10 and turned out to be
// a full duplicate of mt#2351+mt#2407 — caught only by a manual /plan-task
// gate-(g) pass three days later. Fresh evidence (2026-07-16): mt#2887 and
// mt#2888 were filed 4 minutes apart by two independent agents describing the
// SAME incident (a `gh api` 503 breaking session_pr_merge's check-runs query)
// with completely different titles/framing — zero cross-detection until a
// human closed mt#2887 as subsumed.
//
// Mechanism: run the tasks similarity search IN-PROCESS (mt#2958 — see
// ./standalone-dup-probe.ts; through mt#2813 this shelled out a stateless
// `minsky tasks search` CLI, paying a full second boot per probe) with a
// query built from the new task's title + spec — the SAME
// `title + "\n\n" + spec` content shape `TaskSimilarityService.
// extractTaskContent` uses to build the embedding index
// (packages/domain/src/tasks/task-similarity-service.ts), so the query
// embedding lands in the same representation space as the indexed corpus —
// against ALL tasks (no status filter), then apply the SAME terminal-status
// exclusion discipline as the sibling matcher before thresholding.
//
// Calibration (mt#2813 PR body has the full replay-corpus table): `score` is
// an embedding DISTANCE (lower = more similar — the tasks.search CLI's own
// `--threshold` flag is documented "lower is closer"). Live-probed against
// the two evidence pairs plus 20 recent legitimately-distinct standalone
// creations:
//   - mt#2734 (title+spec) -> mt#2351 at distance 0.478
//   - mt#2887 (title+spec, at-creation content) -> mt#2892 at 0.579, mt#2888
//     at 0.632 (both ACTIVE at replay time)
//   - 20-task false-positive corpus: 17/20 landed > 0.65; the 3 that landed
//     under 0.65 (mt#2764/mt#2729 "flaky CI test" pair at 0.396, mt#2777/
//     mt#1815 "reviewer-service reliability churn" pair at 0.497, mt#2776/
//     mt#2421 "execution-evidence gate" pair at 0.631) are all genuinely
//     topically-adjacent sibling work, not spurious noise — a reasonable
//     advisory-warn outcome even though it lands slightly above the spec's
//     "~1 false warn" target. See STANDALONE_DUP_MAX_DISTANCE's own doc
//     comment for the threshold rationale.
//
// A title-ONLY query (no `spec` supplied — rare in practice since
// /create-task always generates a full spec before calling tasks_create) is
// structurally at a scale disadvantage under this same threshold: title-only
// distances run systematically higher (farther) for ANY match, so a
// title-only create will rarely trigger a warn. This is an accepted
// degraded-but-safe posture (permit, not a false block) — there just isn't
// enough signal in a bare title to compare reliably, and the guard is
// advisory-only so under-warning on thin input is the safe failure
// direction.
//
// @see mt#2813 — this task
// @see parallel-work-guard.ts — the duplicate-CHILD matcher (mt#1435/mt#2683)
//      this module's design mirrors, and the caller of runStandaloneDuplicateGuard
// @see docs/architecture/hooks/parallel-work-guard.md — full mechanism + calibration writeup

import { writeOutput, TERMINAL_TASK_STATUSES } from "./types";
import type { ToolHookInput } from "./types";
import { recordGuardError, recordGuardCheckSkip } from "./guard-health";
import { safeTruncate } from "../../src/utils/safe-truncate";
import { fetchSimilarActiveTasksInProcess, type ProbeFailure } from "./standalone-dup-probe";

// TERMINAL_TASK_STATUSES (mt#2683 discipline — a DONE/CLOSED/COMPLETED task
// cannot represent live duplicate work) is imported from ./types, shared
// with parallel-work-guard.ts's sibling duplicate-CHILD matcher (mt#2813 R1:
// this used to be a locally-duplicated copy, flagged as a drift risk by
// review — hoisted to one shared definition instead).

/** One `minsky tasks search --json` result row. */
export interface TaskSearchResult {
  id: string;
  score?: number;
  title?: string;
  status?: string;
}

/** A high-similarity candidate surfaced by the standalone-duplicate probe. */
export interface StandaloneDuplicateCandidate {
  id: string;
  title: string;
  status: string;
  /** Embedding distance to the new task's title+spec query — lower is closer. */
  score: number;
}

/**
 * Distance threshold below which a `tasks.search` hit is treated as a
 * high-similarity candidate (mt#2813 calibration — see the module doc
 * comment above for the full replay-corpus numbers). Chosen as the tightest
 * round cutoff that still catches BOTH required true-positive pairs
 * (mt#2734->mt#2351 at 0.478; mt#2887->mt#2888 at 0.632) while excluding
 * 17/20 of the false-positive calibration corpus — the 3 remaining hits are
 * genuinely topically-adjacent sibling tasks, not noise, and this guard is
 * advisory (WARN), never blocking, so the cost of an occasional such warn is
 * low relative to the cost of missing the "same incident, different
 * mechanism" duplicate class this task exists to catch.
 */
export const STANDALONE_DUP_MAX_DISTANCE = 0.65;

/** Max candidates surfaced in one warning (advisory — several may be relevant). */
export const STANDALONE_DUP_CANDIDATE_CAP = 5;

/** `tasks.search --limit` — wide enough that the cap above is the real limit. */
export const STANDALONE_DUP_SEARCH_LIMIT = 10;

/**
 * Defensive cap on how much of `spec` is folded into the search query. Bounds
 * embedding cost/latency on a pathologically large spec; 6000 chars is well
 * above every spec observed during mt#2813 calibration (the largest,
 * mt#2887's at-creation content, was 3862 chars).
 */
export const STANDALONE_DUP_SPEC_MAX_CHARS = 6_000;

/** This guard's name in the hook-health tracker (mt#2812). */
export const STANDALONE_DUPLICATE_GUARD_NAME = "standalone-duplicate-matcher";

/**
 * Build the similarity-search query from a `tasks_create` call's `title` +
 * (optional) `spec`. Mirrors `TaskSimilarityService.extractTaskContent`'s
 * `title + "\n\n" + specContent` join exactly, so the query embedding lands
 * in the same representation space the index was built with. Falls back to
 * title-only when no spec was supplied (see the module doc comment above for
 * why that path under-warns rather than false-blocks). Truncation uses
 * `safeTruncate` (surrogate-pair-safe) rather than a raw `.slice(0, N)`.
 */
export function buildStandaloneDuplicateQuery(title: string, spec?: string): string {
  if (!spec) return title;
  const truncated =
    spec.length > STANDALONE_DUP_SPEC_MAX_CHARS
      ? safeTruncate(spec, STANDALONE_DUP_SPEC_MAX_CHARS, "head")
      : spec;
  return `${title}\n\n${truncated}`;
}

/**
 * Filter + rank `tasks.search` results into high-similarity candidates:
 * excludes TERMINAL-status matches (mt#2683 discipline — a DONE/CLOSED/
 * COMPLETED task cannot represent live duplicate work), keeps only hits at
 * or under STANDALONE_DUP_MAX_DISTANCE, sorted closest-first, capped at
 * STANDALONE_DUP_CANDIDATE_CAP. Pure.
 */
export function detectStandaloneDuplicates(
  results: readonly TaskSearchResult[]
): StandaloneDuplicateCandidate[] {
  const candidates: StandaloneDuplicateCandidate[] = [];
  for (const r of results) {
    if (typeof r.id !== "string" || typeof r.score !== "number") continue;
    if (r.status && TERMINAL_TASK_STATUSES.has(r.status)) continue;
    if (r.score > STANDALONE_DUP_MAX_DISTANCE) continue;
    candidates.push({
      id: r.id,
      title: r.title ?? "(untitled)",
      status: r.status ?? "UNKNOWN",
      score: r.score,
    });
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates.slice(0, STANDALONE_DUP_CANDIDATE_CAP);
}

/** Non-blocking advisory naming the candidate(s) found. */
export function formatStandaloneDuplicateWarning(
  title: string,
  candidates: readonly StandaloneDuplicateCandidate[]
): string {
  const lines: string[] = [];
  const plural = candidates.length !== 1;
  lines.push(
    `[parallel-work-guard] NOTE: this new standalone task ("${title}") looks similar to ` +
      `${candidates.length} existing ACTIVE task${plural ? "s" : ""}:`
  );
  for (const c of candidates) {
    lines.push(`  ${c.id} [${c.status}] (distance=${c.score.toFixed(3)}) — "${c.title}"`);
  }
  lines.push(
    "This is ADVISORY, not blocking. Before filing, confirm this work isn't already covered — " +
      "run `minsky tasks get <id>` on the candidate(s) above, or extend the existing task instead " +
      "of creating a near-duplicate. See /plan-task gate (g)(3) for the deeper duplicate-work check."
  );
  return lines.join("\n");
}

/** The decision a standalone (parentless) tasks_create call resolves to. */
export type StandaloneDuplicateGuardDecision =
  | {
      action: "skip";
      reason: string;
      degraded?: boolean;
      /**
       * mt#3072 SC2 — threaded from the probe's `ProbeFailure.causeClass`
       * when available (the "failed" branch below); the legacy null/
       * degraded-lexical-fallback branches classify as "infra" directly
       * since neither indicates a probe-code defect.
       */
      causeClass?: "infra" | "logic";
    }
  | { action: "permit" }
  | { action: "warn"; message: string; candidates: StandaloneDuplicateCandidate[] };

/**
 * Pure decision for the standalone-duplicate probe. `deps.fetchSimilar` is
 * injected so this is hermetically testable without the in-process search
 * stack (accepts a sync or async implementation).
 * NEVER returns a "block" action — this guard is advisory-only per the
 * mt#2813 spec ("base rates differ from the sibling case").
 */
export async function decideStandaloneDuplicateGuard(
  toolInput: Record<string, unknown>,
  deps: {
    fetchSimilar: (
      query: string
    ) =>
      | Promise<{ results: TaskSearchResult[]; degraded: boolean } | ProbeFailure | null>
      | { results: TaskSearchResult[]; degraded: boolean }
      | ProbeFailure
      | null;
  }
): Promise<StandaloneDuplicateGuardDecision> {
  const title = typeof toolInput["title"] === "string" ? (toolInput["title"] as string) : "";
  if (!title) {
    return { action: "skip", reason: "tasks_create has no title" };
  }

  const spec = typeof toolInput["spec"] === "string" ? (toolInput["spec"] as string) : undefined;
  const query = buildStandaloneDuplicateQuery(title, spec);

  const searchResult = await deps.fetchSimilar(query);
  if (searchResult === null) {
    // Legacy null-return seam (pre-mt#2958 test fixtures / any future
    // deps.fetchSimilar that chooses to return null) — an unavailable
    // backend is an infra-class condition (mt#3072 SC2).
    return {
      action: "skip",
      reason:
        "in-process tasks search failed or timed out — the standalone-duplicate probe is " +
        "SKIPPED for this create (see stderr for the probe failure detail)",
      degraded: true,
      causeClass: "infra",
    };
  }
  if ("failed" in searchResult) {
    // Carry the ACTUAL error message AND its causeClass into the
    // guard-health event (mt#2958 SC2 for the message; mt#3072 SC2 for the
    // classification) — not just a generic pointer at stderr.
    return {
      action: "skip",
      reason: `in-process tasks search failed — probe SKIPPED for this create: ${searchResult.failed}`,
      degraded: true,
      causeClass: searchResult.causeClass,
    };
  }
  if (searchResult.degraded) {
    // Lexical-fallback degradation means the EMBEDDINGS backend is
    // unavailable — an infra condition, not a probe-logic defect.
    return {
      action: "skip",
      reason:
        "tasks_search degraded to lexical fallback (embeddings backend unavailable) — the " +
        "standalone-duplicate probe is SKIPPED (its threshold is calibrated for embeddings " +
        "distances only)",
      degraded: true,
      causeClass: "infra",
    };
  }

  const candidates = detectStandaloneDuplicates(searchResult.results);
  if (candidates.length === 0) {
    return { action: "permit" };
  }
  return {
    action: "warn",
    message: formatStandaloneDuplicateWarning(title, candidates),
    candidates,
  };
}

/**
 * Entrypoint wrapper: resolve the standalone-duplicate decision and map it to
 * hook output. Called from parallel-work-guard.ts's `runTasksCreateGuardInner`
 * when a `tasks_create`/new-task-mode `tasks_dispatch` call has no
 * `parent`/`parentTaskId`.
 */
export async function runStandaloneDuplicateGuard(input: ToolHookInput): Promise<void> {
  // Observability parity with the sibling matcher's runTasksCreateGuard: any
  // unexpected throw is surfaced on stderr, recorded to the hook-health
  // tracker (mt#2812), and then fails OPEN (permit) — a silent crash here
  // must never block task creation.
  try {
    await runStandaloneDuplicateGuardInner(input, {
      fetchSimilar: (query) => fetchSimilarActiveTasksInProcess(query, STANDALONE_DUP_SEARCH_LIMIT),
    });
  } catch (err) {
    process.stderr.write(
      `[parallel-work-guard] standalone-duplicate probe errored — failing open (permit): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    recordGuardError({
      guardName: STANDALONE_DUPLICATE_GUARD_NAME,
      event: "PreToolUse",
      error: err,
      toolName: input.tool_name,
      sessionId: input.session_id,
    });
  }
}

/**
 * `deps` is injectable (mt#3072) so a test can simulate the probe-failure
 * mode end-to-end — through to the ACTUAL `recordGuardCheckSkip` call and a
 * real (temp) guard-health log — without touching the real search stack.
 * Exported for exactly that; production always goes through
 * `runStandaloneDuplicateGuard` above, which supplies the real probe.
 */
export async function runStandaloneDuplicateGuardInner(
  input: ToolHookInput,
  deps: {
    fetchSimilar: Parameters<typeof decideStandaloneDuplicateGuard>[1]["fetchSimilar"];
  }
): Promise<void> {
  const decision = await decideStandaloneDuplicateGuard(input.tool_input, deps);

  switch (decision.action) {
    case "skip":
      if (decision.degraded) {
        process.stderr.write(
          `[parallel-work-guard] GUARD DEGRADED (standalone-duplicate probe skipped): ${
            decision.reason
          }\n`
        );
        recordGuardCheckSkip({
          guardName: STANDALONE_DUPLICATE_GUARD_NAME,
          event: "PreToolUse",
          reason: decision.reason,
          toolName: input.tool_name,
          sessionId: input.session_id,
          causeClass: decision.causeClass,
        });
      } else {
        process.stdout.write(
          `[parallel-work-guard] standalone-duplicate probe skipped — ${decision.reason}\n`
        );
      }
      return;
    case "warn":
      process.stdout.write(`${decision.message}\n`);
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: decision.message,
        },
      });
      return;
    case "permit":
      return;
  }
}
