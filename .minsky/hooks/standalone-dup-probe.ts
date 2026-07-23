// In-process standalone-duplicate probe (mt#2958).
//
// Replaces the `minsky tasks search <q> --json --all --limit N` CLI shell-out
// the standalone-duplicate matcher used through mt#2813. The CLI path paid a
// FULL second boot per probe — hook process boots, then spawns a stateless
// minsky CLI that re-loads the 36MB bundle (~0.9s), re-establishes the remote
// Postgres connection, and re-inits DI — against an 8s spawn-kill whose
// failure signature was an opaque empty-stdout "unparseable output". Calling
// the domain search path in-process drops the second boot and the entire
// spawn/PATH exposure, and turns every failure into a caught Error whose
// message goes straight into the guard-health event (mt#2958 SC2).
//
// ## Parity contract (do not drift)
//
// This module deliberately MIRRORS the CLI path it replaces, piece by piece:
//   - Service assembly mirrors `createTaskSimilarityService`
//     (src/adapters/shared/commands/tasks/similarity-commands.ts) — same
//     config-derived model/dimension, same embedding service, same vector
//     capability check, same task-service-backed find/search/spec functions.
//   - Project scoping mirrors `resolveTaskSimilarityProjectScope` (same file;
//     ADR-021 / mt#2939) — identity from cwd, live scope resolution via the
//     SQL-capable provider, ALL_PROJECTS on any failure (fail-open). Skipping
//     this would silently re-open the cross-project-duplicate-warning leak
//     mt#2939 closed.
//   - Query semantics mirror the guard's CLI flags: `--all` = NO status
//     filter (the caller applies its own TERMINAL_TASK_STATUSES discipline);
//     result rows are hydrated to {id, score, title, status} exactly as the
//     CLI's enhanceSearchResults did.
//   - A `degraded: true` search response (lexical fallback) is returned as-is
//     — the caller treats it as a calibrated skip because
//     STANDALONE_DUP_MAX_DISTANCE is calibrated for embedding distances only.
//
// ## Failure and timeout posture
//
// Everything degrades to a structured `ProbeFailure` ({ failed: <actual
// error message>, causeClass: "infra" | "logic" } — the caller's "probe
// unavailable, skip" signal, whose message it threads into the guard-health
// check-skip event per mt#2958 SC2), with the same message on a loud GUARD
// DEGRADED stderr line. The overall deadline replaces the old spawn-kill: the
// probe races STANDALONE_DUP_PROBE_TIMEOUT_MS and returns a ProbeFailure on
// expiry (any in-flight DB/embedding work is abandoned; the hook process
// exits right after the decision, which is exactly what the spawn-kill used
// to guarantee). The
// mt#2982 fail-fast Postgres connect timeout is applied programmatically
// (env default before first config/provider resolution, operator-set value
// wins) so a hanging-DB window fails the connect in ~2s, well inside the
// deadline.
//
// `causeClass` (mt#3072 SC2 — "distinguish infra-unavailable from
// probe-logic failure in the health accounting") tags every ProbeFailure so
// a sustained streak of check-skips is diagnosable at a glance: every NAMED
// degradation (bootstrap/persistence/vector-storage unavailable, lexical
// fallback, deadline expiry) is "infra" by construction; anything reaching
// the catch-all or the rejection sink is classified by `classifyCause`
// (TypeError/ReferenceError -> "logic", everything else -> "infra"). See
// `ProbeFailure`'s own doc comment for the full rationale.
//
// @see mt#2958 — the in-process conversion (this file's original shape)
// @see mt#3072 — causeClass classification + the incident this closes
// @see mt#2982 — the fail-fast connect timeout this probe inherits
// @see parallel-work-guard-standalone.ts — the caller + decision logic
// @see docs/architecture/hooks/parallel-work-guard.md — mechanism writeup

// Domain bootstrap for a hook entry point: installs the tsyringe reflect
// polyfill (TaskSimilarityService is @injectable(); the CLI entry point loads
// it for the whole process, but a hook is its own entry point and must load it
// before any decorated domain class is imported) and exposes the config
// bootstrap used below. Extracted from this file into a shared module by
// mt#3019, which found record-subagent-invocation.ts missing BOTH halves.
import { ensureHookDomainBootstrap } from "./domain-bootstrap";

import type { TaskSearchResult } from "./parallel-work-guard-standalone";
import type {
  PersistenceProvider,
  VectorCapablePersistenceProvider,
  SqlCapablePersistenceProvider,
} from "../../packages/domain/src/persistence/types";
import type { ProjectScope } from "../../packages/domain/src/project/scope";

/**
 * Overall in-process probe deadline. Successor to the CLI-era
 * STANDALONE_DUP_CLI_TIMEOUT_MS (same 8s value, same "degrade cleanly before
 * the 15s Claude Code host cap kills the hook" rationale) — now enforced as a
 * Promise race instead of a spawn-kill. Healthy-path cost is ~2.5s (config +
 * DB connect + embedding call); a hanging-DB connect fails at ~2s via the
 * mt#2982 injected connect timeout, so this deadline is a backstop for the
 * slow-but-not-hanging tail, not the primary bound.
 */
export const STANDALONE_DUP_PROBE_TIMEOUT_MS = 8_000;

const TIMED_OUT = Symbol("standalone-dup-probe-timeout");

/**
 * Structured probe failure — carries the ACTUAL error message so the caller
 * can put it in the guard-health check-skip event (mt#2958 SC2; PR #2152 R1),
 * not just on stderr.
 *
 * `causeClass` (mt#3072 SC2) distinguishes two accounting buckets so a
 * sustained streak of check-skips is diagnosable at a glance instead of a
 * flat "check-skip x14":
 *   - `"infra"` — a NAMED, anticipated degradation: the domain bootstrap, the
 *     persistence provider, or the vector-storage capability was unavailable,
 *     the search degraded to the lexical fallback, or the probe's own
 *     deadline expired (a slow/hanging external dependency). None of these
 *     indicate a defect in this probe's code — they mean an external
 *     dependency the probe depends on wasn't there or wasn't fast enough.
 *   - `"logic"` — an UNANTICIPATED failure reached the probe's catch-all or
 *     its rejection sink. `classifyCause` narrows this further: a
 *     `TypeError`/`ReferenceError` is the closest runtime signature of an
 *     actual code defect (calling a method on `undefined`, an unbound
 *     reference) as opposed to an external-system error (connection refused,
 *     timeout, HTTP failure), which classifies as `"infra"` even when it
 *     surfaces through the catch-all rather than a named branch.
 */
export interface ProbeFailure {
  failed: string;
  causeClass: "infra" | "logic";
}

/**
 * Heuristic classification for an error that reached a catch-all (the final
 * `runProbe` catch, or the rejection-sink `.catch` below) rather than one of
 * the NAMED degradation branches, which are hardcoded `"infra"` at their call
 * site. `TypeError`/`ReferenceError` are the runtime signatures most
 * associated with an actual programming defect (a bad property access, an
 * unbound reference) — everything else (network errors, timeouts, DB driver
 * errors, HTTP failures) is far more often an external-dependency condition,
 * so it classifies as `"infra"`. Deliberately a coarse MVP, not a full error
 * taxonomy (out of scope per the mt#3072 spec's "redesigning the guard-health
 * tracker generally" exclusion) — good enough to stop an infra outage and a
 * real probe bug from reading identically in the health accounting.
 */
export function classifyCause(err: unknown): "infra" | "logic" {
  return err instanceof TypeError || err instanceof ReferenceError ? "logic" : "infra";
}

/**
 * Run the duplicate-candidate search in-process. On ANY failure or deadline
 * expiry returns a `ProbeFailure` carrying the actual error message (also
 * written to stderr here); the caller treats it as "search unavailable, skip
 * the probe for this create" and records the message to guard-health.
 */
export async function fetchSimilarActiveTasksInProcess(
  query: string,
  limit = 10
): Promise<{ results: TaskSearchResult[]; degraded: boolean } | ProbeFailure> {
  // mt#2982 fail-fast connect is applied inside `ensureHookDomainBootstrap`
  // (called by runProbe below), still BEFORE the first configuration /
  // persistence-provider resolution caches its view of the env. An
  // operator-set value in the hook's own env wins.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), STANDALONE_DUP_PROBE_TIMEOUT_MS);
  });
  // Rejection sink (PR #2152 R1): runProbe converts every failure to a value
  // by construction, but if it ever DID reject after the deadline won the
  // race, the orphaned promise would surface as an unhandledrejection —
  // the .catch guarantees the abandoned branch is always observed.
  const probe = runProbe(query, limit).catch(
    (err): ProbeFailure => ({
      failed: `probe rejected: ${err instanceof Error ? err.message : String(err)}`,
      causeClass: classifyCause(err),
    })
  );
  try {
    const outcome = await Promise.race([probe, deadline]);
    if (outcome === TIMED_OUT) {
      // A deadline expiry is an "infra" cause (mt#3072 SC2) — the deadline
      // exists specifically to bound a slow/hanging EXTERNAL dependency
      // (DB connect, embedding call), not to catch a code defect.
      const failed = `in-process probe exceeded the ${STANDALONE_DUP_PROBE_TIMEOUT_MS}ms deadline`;
      process.stderr.write(`[parallel-work-guard] GUARD DEGRADED: ${failed}\n`);
      return { failed, causeClass: "infra" };
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/** The un-raced probe body. Never rejects — converts every failure to a value. */
async function runProbe(
  query: string,
  limit: number
): Promise<{ results: TaskSearchResult[]; degraded: boolean } | ProbeFailure> {
  try {
    // Config bootstrap — a hook is its own entry point: the domain config
    // system is process-global and uninitialized here (the CLI's boot does
    // this in cli.ts; nothing does it for a hook process). Everything below
    // (persistence factory, embedding factory, getConfiguration) throws
    // "Configuration not initialized" without it. Idempotent via the guard.
    // Shared with record-subagent-invocation.ts since mt#3019; the mt#2982
    // fail-fast connect default moved into the helper alongside it.
    const bootstrap = await ensureHookDomainBootstrap();
    if (!bootstrap.ok) {
      return degraded(`domain bootstrap failed: ${bootstrap.error}`);
    }

    const { resolvePersistenceProvider } = await import(
      "../../packages/domain/src/persistence/factory"
    );
    const provider = await resolvePersistenceProvider();
    if (!provider) {
      return degraded("persistence provider unavailable (see mt#3019 for the config-init class)");
    }

    const { createConfiguredTaskService } = await import(
      "../../packages/domain/src/tasks/taskService"
    );
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });

    // Mirror createTaskSimilarityService (similarity-commands.ts) — config,
    // embedding service, vector capability, task-backed service functions.
    const { getConfiguration } = await import("../../packages/domain/src/configuration/index");
    const { createEmbeddingServiceFromConfig } = await import(
      "../../packages/domain/src/ai/embedding-service-factory"
    );
    const { getEmbeddingDimension } = await import("../../packages/domain/src/ai/embedding-models");
    const { TaskSimilarityService } = await import(
      "../../packages/domain/src/tasks/task-similarity-service"
    );

    const cfg = await getConfiguration();
    const model = cfg.embeddings?.model || "text-embedding-3-small";
    const dimension = getEmbeddingDimension(model, 1536);
    const embedding = await createEmbeddingServiceFromConfig();

    // Mirrors createTaskSimilarityService's vector-capability check: the
    // capability flag plus a related-type cast (VectorCapablePersistenceProvider
    // extends the base provider), keeping both the hooks tsconfig (no
    // unrelated-type casts) and custom/no-excessive-as-unknown satisfied.
    const vectorCapable = provider as VectorCapablePersistenceProvider;
    if (
      !provider.capabilities.vectorStorage ||
      typeof vectorCapable.getVectorStorageForDomain !== "function"
    ) {
      return degraded(`persistence provider ${provider.constructor.name} lacks vector storage`);
    }
    const vectorStorage = vectorCapable.getVectorStorageForDomain("tasks", dimension);

    const service = new TaskSimilarityService(
      embedding,
      vectorStorage,
      async (id: string) => taskService.getTask(id),
      async (opts: { text?: string; projectScope?: ProjectScope }) =>
        taskService.listTasks({ projectScope: opts?.projectScope }),
      async (id: string) => taskService.getTaskSpecContent(id),
      { vectorLimit: 10, model, dimension }
    );

    const scope = await resolveProbeProjectScope(provider);
    // `--all` parity: no status/backend/kind filters — the caller applies the
    // TERMINAL_TASK_STATUSES exclusion itself, exactly as it did on CLI rows.
    const response = await service.searchByText(query, limit, undefined, {}, scope);

    if (response.degraded) {
      // Lexical-fallback scores are on a different scale than the calibrated
      // embedding-distance threshold — surface as degraded, skip hydration.
      return { results: [], degraded: true };
    }

    // Hydrate {title, status} for the ≤`limit` hits — the in-process
    // equivalent of the CLI's enhanceSearchResults.
    const results: TaskSearchResult[] = await Promise.all(
      response.results.map(async (r) => {
        const task = await taskService.getTask(r.id).catch(() => null);
        return {
          id: r.id,
          score: r.score,
          title: task?.title,
          status: task?.status,
        };
      })
    );
    return { results, degraded: false };
  } catch (err) {
    // Catch-all: nothing upstream anticipated this failure shape, so classify
    // it rather than hardcoding "infra" (mt#3072 SC2) — see `classifyCause`'s
    // doc comment for the TypeError/ReferenceError -> "logic" heuristic.
    return degraded(err instanceof Error ? err.message : String(err), classifyCause(err));
  }
}

/**
 * Mirror of resolveTaskSimilarityProjectScope (similarity-commands.ts,
 * ADR-021 / mt#2939): resolve the cwd's project identity to a live scope via
 * the SQL-capable provider; ALL_PROJECTS on any failure (fail-open, never
 * throws).
 */
async function resolveProbeProjectScope(provider: PersistenceProvider): Promise<ProjectScope> {
  const { ALL_PROJECTS } = await import("../../packages/domain/src/project/scope");
  try {
    const { resolveProjectIdentity } = await import("../../packages/domain/src/project/identity");
    const { resolveProjectScope } = await import(
      "../../packages/domain/src/project/scope-resolver"
    );
    const identity = resolveProjectIdentity({ repoPath: process.cwd() });
    if (identity.kind !== "resolved") return ALL_PROJECTS;
    if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
      return ALL_PROJECTS;
    }
    const db = (await (
      provider as SqlCapablePersistenceProvider
    ).getDatabaseConnection()) as Parameters<typeof resolveProjectScope>[1];
    if (!db) return ALL_PROJECTS;
    return await resolveProjectScope(identity, db);
  } catch {
    return ALL_PROJECTS;
  }
}

/**
 * Write the GUARD DEGRADED stderr line and build the structured failure.
 * `causeClass` defaults to `"infra"` — every call site EXCEPT the final
 * catch-all is a NAMED, anticipated degradation (bootstrap/persistence/
 * vector-storage unavailable); the catch-all passes `classifyCause(err)`
 * explicitly instead of relying on this default.
 */
function degraded(reason: string, causeClass: "infra" | "logic" = "infra"): ProbeFailure {
  process.stderr.write(
    `[parallel-work-guard] GUARD DEGRADED: in-process standalone-duplicate probe failed: ${reason}\n`
  );
  return { failed: reason, causeClass };
}
