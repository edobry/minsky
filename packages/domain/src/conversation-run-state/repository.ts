/**
 * Conversation run-state persistence (mt#3161, mt#3130 Phase 1).
 *
 * One upsert per observed harness event. Refresh-not-duplicate: the
 * conversation id is the primary key, so a conversation accumulates exactly one
 * row no matter how many events it emits — the same semantics `presence_claims`
 * gets from its unique index.
 *
 * @see ./event-mapping.ts — the pure event -> column-patch function this applies
 * @see packages/domain/src/storage/schemas/conversation-run-state-schema.ts
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { conversationRunStateTable } from "../storage/schemas/conversation-run-state-schema";
import { resolveProjectIdentity } from "../project/identity";
import { resolveProjectScope } from "../project/scope-resolver";
import { isAllProjects } from "../project/scope";
import { mapHookEventToRunState, type HookPayload } from "./event-mapping";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";

/** One observed harness event, as forwarded by the writer hook. */
export interface RunStateEvent {
  /** Harness `session_id` — the conversation id. */
  conversationId: string;
  /** Harness `hook_event_name`. */
  eventName: string;
  /** When the hook observed the event. */
  observedAt: Date;
  /** Harness `cwd`, when present. */
  cwd?: string | null;
  /** The raw hook payload; individual mappers read only the fields they need. */
  payload?: HookPayload;
}

/** Outcome of a single ingest, for the route's response and for tests. */
export type RunStateIngestResult = { applied: true } | { applied: false; reason: "unmapped-event" };

/**
 * Resolve a project uuid from `cwd` using the same resolver the transcript
 * ingest path uses (ADR-021, mt#2416). Stamped ON WRITE rather than resolved at
 * read time — the mt#2563 lesson. Returns null (never throws) when `cwd` is
 * absent, the identity can't be resolved, or no matching `projects` row exists:
 * run-state ingest must never block on project resolution.
 */
async function resolveRunStateProjectId(
  cwd: string | null | undefined,
  db: PostgresJsDatabase
): Promise<string | null> {
  if (!cwd) return null;
  try {
    const identity = resolveProjectIdentity({ repoPath: cwd });
    if (identity.kind !== "resolved") return null;
    const scope = await resolveProjectScope(identity, db);
    return isAllProjects(scope) ? null : scope;
  } catch (err) {
    log.debug("[run-state] project id resolution failed; leaving unscoped", {
      cwd,
      error: getLoggableErrorSummary(err),
    });
    return null;
  }
}

/**
 * Apply one observed event to the conversation's run-state row.
 *
 * An event with no mapping is a no-op, NOT an error — see
 * {@link mapHookEventToRunState}. This keeps a `settings.json` registration
 * that runs ahead of its mapping (or a harness version emitting a new event)
 * from turning into 500s on the ingest path.
 */
export async function recordRunStateEvent(
  db: PostgresJsDatabase,
  event: RunStateEvent
): Promise<RunStateIngestResult> {
  const patch = mapHookEventToRunState(event.eventName, event.payload ?? {}, event.observedAt);
  if (!patch) return { applied: false, reason: "unmapped-event" };

  const projectId = await resolveRunStateProjectId(event.cwd, db);

  // Columns every event refreshes. `lastEventAt` is the heartbeat the
  // absence-detection sweep (mt#3130 Phase 2) reads.
  const base = {
    lastEventName: event.eventName,
    lastEventAt: event.observedAt,
    cwd: event.cwd ?? null,
    updatedAt: event.observedAt,
  };

  // `projectId` is only ever written when it RESOLVED. A failed resolution
  // must not blank a previously-stamped value: an unresolvable cwd (detached
  // worktree, missing git remote) is absence of evidence, not evidence the
  // conversation left its project.
  const projectPatch = projectId === null ? {} : { projectId };

  await db
    .insert(conversationRunStateTable)
    .values({
      conversationId: event.conversationId,
      ...base,
      ...projectPatch,
      ...patch,
    })
    .onConflictDoUpdate({
      target: conversationRunStateTable.conversationId,
      set: { ...base, ...projectPatch, ...patch },
    });

  return { applied: true };
}
