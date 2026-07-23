#!/usr/bin/env bun
// PostToolUse hook — Surface 4 of the System 3* detector (mt#1035 / mt#1543).
//
// Runs after a session PR merges. Resolves the merged session's transcript,
// asks the unasked-direction analyzer to surface preference-bound decisions,
// and writes the findings to `.minsky/state/unasked-directions/<sessionId>.json`.
//
// Findings are observational — they DO NOT block merge (the merge already
// happened). They feed the rule library that informs Surface 2 (deferred
// to v0.2). The operator triages weekly via the `unasked-direction` CLI.
//
// Modes via MINSKY_UNASKED_DIRECTION_DETECTOR env var:
//   - unset / "log-only" (DEFAULT): run analyzer, write findings.
//   - "disabled":                    skip entirely; no AI call.
//
// On any failure (missing transcript, AI error, file IO error), the hook
// logs and exits 0. The hook is best-effort; it must never break the merge
// flow.
//
// @see mt#1543 — this task (Surface 4 specifics)
// @see mt#1574 — shared Detector core (consumes signalToAskIntent)
// @see docs/research/mt1035-system3-detector.md §Surface 4
// @see .claude/hooks/post-merge-pull.ts — sibling hook on the same matcher
// @see mt#3046 — the missing domain bootstrap that made `loadTranscript` below
//      always return null (found by the lint rule this task ships)

import { readInput, findRepoRoot } from "./types";
import type { ToolHookInput } from "./types";
// mt#3046: STATIC — installs the tsyringe reflect polyfill before any domain
// module loads. `loadTranscript`'s dynamic persistence import needs it, and a
// dynamic import cannot install it retroactively.
import { ensureHookDomainBootstrap } from "./domain-bootstrap";

import { UnaskedDirectionAnalyzer } from "../../packages/domain/src/detectors/unasked-direction-analyzer";
import { writeFindings } from "../../packages/domain/src/detectors/unasked-direction-store";
import type { TranscriptMessage } from "../../packages/domain/src/provenance/transcript-service";
import type { ConversationId } from "../../packages/domain/src/ids";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mode env var. */
const MODE_ENV_VAR = "MINSKY_UNASKED_DIRECTION_DETECTOR";

type DetectorMode = "log-only" | "disabled";

/** Tool names the hook reacts to.
 *
 * mt#3127: `mcp__github__merge_pull_request` was REMOVED. Its schema takes
 * `owner` / `repo` / `pullNumber` and nothing else, and its result is a raw
 * GitHub merge response — there is no Minsky workspace session id anywhere in
 * the payload, so `resolveSessionContext` could never succeed for it and the
 * findings file (keyed by workspace session id) could never be written. Every
 * invocation of that tool since mt#1543 hit the could-not-resolve exit. A
 * permanently-dead branch that logs like a recoverable one is the exact defect
 * class this hook has now been fixed for three times; keeping it "just in
 * case" would preserve it. Re-adding it means first resolving a workspace from
 * the PR number (the `sessions` table carries `pullRequest.number`), which is a
 * real feature, not a coverage list entry.
 */
const COVERED_TOOL_NAMES = new Set(["mcp__minsky__session_pr_merge"]);

function readMode(): DetectorMode {
  const raw = process.env[MODE_ENV_VAR];
  if (raw === "disabled") return "disabled";
  return "log-only";
}

// ---------------------------------------------------------------------------
// Session / task / transcript resolution
// ---------------------------------------------------------------------------

/**
 * The payload locations a workspace session id has actually been observed in,
 * most-specific first. Each entry is named so an unresolvable payload can say
 * WHICH shapes were tried rather than just "could not resolve".
 *
 * mt#3127: the `tool_result.result.session` entry is the one that was missing,
 * and it is the one production uses. `session_pr_merge` returns
 * `{ success, result: { session: "<workspaceId>", taskId, mergeInfo, ... } }` —
 * the id is a STRING nested under `result`, not an object with a `sessionId`
 * field. The resolver only looked at `tool_result.session.sessionId`, so a
 * `task:`-invoked merge (the common form) matched nothing and the hook exited
 * before any of mt#3019's, mt#3046's or mt#3066's fixes were reached.
 *
 * These shapes are pinned by fixtures CAPTURED FROM REAL INVOCATIONS
 * (`fixtures/session-pr-merge-payloads.json`), not authored from expectation —
 * a hand-written fixture tests the reader against itself, which is how this
 * defect survived mt#3066's verification.
 */
const SESSION_ID_ACCESSORS: ReadonlyArray<{
  readonly where: string;
  readonly read: (params: Record<string, unknown>, result: Record<string, unknown>) => unknown;
}> = [
  { where: "tool_input.sessionId", read: (params) => params["sessionId"] },
  { where: "tool_input.session", read: (params) => params["session"] },
  {
    where: "tool_result.result.session",
    read: (_params, result) =>
      isObject(result["result"]) ? result["result"]["session"] : undefined,
  },
  {
    where: "tool_result.session.sessionId",
    read: (_params, result) =>
      isObject(result["session"]) ? result["session"]["sessionId"] : undefined,
  },
  { where: "tool_result.sessionId", read: (_params, result) => result["sessionId"] },
];

/** Task-id locations, mirroring the session-id list above. */
const TASK_ID_ACCESSORS: ReadonlyArray<
  (params: Record<string, unknown>, result: Record<string, unknown>) => unknown
> = [
  (params) => params["task"],
  (_params, result) => (isObject(result["result"]) ? result["result"]["taskId"] : undefined),
  (_params, result) => (isObject(result["session"]) ? result["session"]["taskId"] : undefined),
];

function firstString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Describe the shape of a payload that yielded no session id, so a future
 * envelope change is diagnosable from the log alone instead of requiring a
 * replay. Names the keys actually present rather than dumping values, which
 * may carry repo paths.
 *
 * Exported for tests.
 */
export function describeToolResultShape(input: ToolHookInput): string {
  const params = input.tool_input ?? {};
  const result = input.tool_result ?? {};
  const nested = isObject(result["result"]) ? Object.keys(result["result"]) : null;
  return (
    `tool_input keys=[${Object.keys(params).join(",")}] ` +
    `tool_result keys=[${Object.keys(result).join(",")}]${
      nested ? ` tool_result.result keys=[${nested.join(",")}]` : ""
    } (tried: ${SESSION_ID_ACCESSORS.map((a) => a.where).join(", ")})`
  );
}

/**
 * Pull the workspace session id + task id out of the tool input/response.
 *
 * `mcp__minsky__session_pr_merge` accepts either `sessionId` or `task`; on
 * success its response carries the session record. See
 * {@link SESSION_ID_ACCESSORS} for the observed locations and why the list
 * exists.
 *
 * Returns `null` if no location yields a session id — the caller logs
 * {@link describeToolResultShape} so the miss is diagnosable.
 */
export function resolveSessionContext(input: ToolHookInput): {
  sessionId: string;
  taskId?: string;
} | null {
  const params = input.tool_input ?? {};
  const result = input.tool_result ?? {};

  const sessionId = firstString(
    SESSION_ID_ACCESSORS.map((accessor) => accessor.read(params, result))
  );
  if (!sessionId) return null;

  const taskId = firstString(TASK_ID_ACCESSORS.map((read) => read(params, result)));

  return taskId ? { sessionId, taskId } : { sessionId };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Read the harness conversation id the transcript is stored under.
 *
 * `agent_transcripts.agent_session_id` is keyed by the harness conversation
 * UUID — the same value `transcript-ingest-on-session-end.ts` ingests under.
 * The harness hands that id to every hook invocation as `input.session_id`,
 * so this hook needs no workspace -> conversation resolution: the reader key
 * and the writer key are the same field.
 *
 * mt#3066: this hook previously passed `resolveSessionContext`'s WORKSPACE
 * session id (from the `session_pr_merge` payload) to `getTranscript`, which
 * matches against the conversation keyspace. It never matched, `null` was
 * treated as "this session had no transcript", and the scan silently no-opped
 * on every merge from the day it shipped.
 *
 * The `as ConversationId` below is a brand mint at the harness boundary — the
 * documented `ids.ts` "re-mint on inbound parse" case — not a cross-space
 * cast. `input.session_id` IS a conversation id by definition of the hook
 * contract.
 */
export function resolveConversationId(input: ToolHookInput): ConversationId | null {
  const raw = input.session_id;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw as ConversationId;
}

/**
 * Try to fetch the stored transcript for a harness conversation.
 *
 * Lazily imports the transcript service + persistence to avoid the cost
 * (and the Postgres connection setup) when the hook is in `disabled` mode.
 *
 * Returns `null` if the transcript can't be loaded for any reason — DB
 * unavailable, no row, parse failure. Hook treats `null` as a no-op.
 *
 * mt#3046: this returned null on EVERY invocation from the day it shipped
 * until that task. The dynamic import below throws `tsyringe requires a
 * reflect polyfill` in a bare hook process, the `catch` swallowed it, and the
 * no-op branch made a permanently-dead scan indistinguishable from "this
 * session had no transcript." Unlike mt#3019's instance there was no DB-row
 * evidence to notice, because the findings file was simply never written. The
 * bootstrap call below is what makes the rest of this function reachable.
 *
 * mt#3066: fixing the bootstrap was necessary but not sufficient — the caller
 * was ALSO passing the wrong id space. The parameter is now a `ConversationId`
 * so a workspace id cannot be passed here again without a compile error.
 *
 * Exported for verification (mt#3046) — the fix's whole claim is that THIS
 * function now returns a transcript, so the check has to call this function
 * rather than a re-implementation of its import sequence. Same convention as
 * `resolveMetricsTranscriptPath` in `record-subagent-invocation.ts`.
 */
export async function loadTranscript(
  conversationId: ConversationId
): Promise<TranscriptMessage[] | null> {
  try {
    const bootstrap = await ensureHookDomainBootstrap();
    if (!bootstrap.ok) {
      // Surfaced rather than swallowed: a bootstrap failure is a defect in
      // this hook's own setup, not a legitimately absent transcript.
      process.stderr.write(
        `[post-merge-unasked-direction-scan] warn: domain bootstrap failed: ${bootstrap.error}\n`
      );
      return null;
    }

    const { resolvePersistenceProvider } = await import(
      "../../packages/domain/src/persistence/factory"
    );
    const { AgentTranscriptService } = await import(
      "../../packages/domain/src/provenance/transcript-service"
    );

    const provider = await resolvePersistenceProvider();
    if (!provider || !("getDatabaseConnection" in provider)) return null;

    const db = await (
      provider as { getDatabaseConnection(): Promise<unknown> }
    ).getDatabaseConnection();
    if (!db) return null;

    const service = new AgentTranscriptService(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase
    );
    return await service.getTranscript(conversationId);
  } catch (err) {
    // PR #2184 R1 BLOCKING #1: the bare `catch { return null }` this replaces
    // is the exact mechanism that hid mt#3046's defect for the life of this
    // hook — a thrown bootstrap/import error became an indistinguishable
    // "this session had no transcript". Returning null is still correct (the
    // hook is best-effort and must never break the merge flow), but it is no
    // longer SILENT: the actual message goes to stderr so the next occurrence
    // is diagnosable instead of invisible.
    //
    // Covers the throwing paths the `{ ok: false }` branch above cannot:
    // `ensureHookDomainBootstrap` itself throwing, a module resolution
    // failure, a DB error inside `getTranscript`.
    process.stderr.write(
      `[post-merge-unasked-direction-scan] warn: transcript load failed for conversation ${conversationId}: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return null;
  }
}

/**
 * Build a completion service if AI providers are configured.
 *
 * Returns `null` if the resolver throws (no API key, missing provider config,
 * etc.). The hook treats `null` as "skip the analyzer, exit silently."
 */
async function buildCompletionService(): Promise<unknown | null> {
  try {
    const { createCompletionService } = await import(
      "../../packages/domain/src/ai/service-factory"
    );
    const { requireAIProviders } = await import("../../packages/domain/src/ai/provider-operations");
    const { getResolvedConfig } = await import(
      "../../src/adapters/shared/commands/ai/shared-helpers"
    );

    const resolvedConfig = getResolvedConfig();
    requireAIProviders(resolvedConfig);
    return createCompletionService(resolvedConfig);
  } catch (err) {
    // Same class as `loadTranscript`'s catch above (PR #2184 R1 BLOCKING #1,
    // patched together per the class-not-instance discipline). This one also
    // imports domain modules from a bare hook process, so it degrades for the
    // same reasons — and "no AI providers configured" is a legitimate, common
    // outcome here, which is exactly why an unreadable failure looked normal.
    // Still returns null; no longer silent.
    process.stderr.write(
      `[post-merge-unasked-direction-scan] warn: completion service unavailable: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();
  const mode = readMode();

  if (mode === "disabled") {
    process.exit(0);
  }

  if (!COVERED_TOOL_NAMES.has(input.tool_name)) {
    process.exit(0);
  }

  const ctx = resolveSessionContext(input);
  if (!ctx) {
    // mt#3127: name the shapes tried and the keys actually present. The bare
    // "could not resolve" this replaces hid a payload-envelope mismatch for the
    // entire life of the hook — the message looked like a legitimate skip.
    process.stderr.write(
      `[post-merge-unasked-direction-scan] Could not resolve a workspace sessionId — skipping. ` +
        `${describeToolResultShape(input)}\n`
    );
    process.exit(0);
  }

  // mt#3066: the transcript is keyed by the HARNESS CONVERSATION id, which the
  // harness supplies directly. `ctx.sessionId` is the Minsky WORKSPACE id and
  // stays the findings-file key / analyzer label — it is only wrong as a
  // transcript lookup key.
  const conversationId = resolveConversationId(input);
  if (!conversationId) {
    process.stderr.write(
      "[post-merge-unasked-direction-scan] Hook input carried no session_id (harness conversation id) — skipping\n"
    );
    process.exit(0);
  }

  // mt#2710: `input.cwd` is routinely a repo SUBDIRECTORY — writeFindings
  // joins `projectRoot` with `.minsky/state/unasked-directions/`, so a raw
  // subdirectory cwd would scatter findings into a stray `.minsky/` there
  // instead of the real repo root.
  const projectRoot = findRepoRoot(input.cwd);

  const transcript = await loadTranscript(conversationId);
  if (!transcript || transcript.length === 0) {
    process.stderr.write(
      `[post-merge-unasked-direction-scan] No transcript stored for conversation ${conversationId} ` +
        `(workspace session ${ctx.sessionId}) — skipping. If this repeats for every merge, the ` +
        "ingest path is behind, not the conversation empty.\n"
    );
    process.exit(0);
  }

  const completionService = await buildCompletionService();
  if (!completionService) {
    process.stderr.write(
      "[post-merge-unasked-direction-scan] No AI provider configured — skipping analyzer\n"
    );
    process.exit(0);
  }

  let output;
  try {
    const analyzer = new UnaskedDirectionAnalyzer(
      completionService as import("../../packages/domain/src/ai/completion-service").DefaultAICompletionService
    );
    output = await analyzer.analyzeTranscript(transcript, {
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[post-merge-unasked-direction-scan] Analyzer failed for ${ctx.sessionId}: ${message}\n`
    );
    process.exit(0);
  }

  const wrote = await writeFindings(projectRoot, ctx.sessionId, output, {
    taskId: ctx.taskId,
  });

  if (wrote) {
    const findingCount = output.findings.length;
    process.stdout.write(
      `[post-merge-unasked-direction-scan] Wrote ${findingCount} finding(s) for session ${ctx.sessionId}\n`
    );
  }

  process.exit(0);
}
