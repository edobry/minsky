#!/usr/bin/env bun
// PostToolUse hook — record which CONVERSATION created a workspace session (mt#3120).
//
// `minsky_session_links` had writers for the daemon-launched case (`driven_spawn`,
// mt#2752) and the PR-authoring case (`pr_author`, mt#3101), but none for the
// ordinary `session_start` case — the dominant creation path by far. Measured
// 2026-07-23: 2 of 230 workspace sessions have ANY link row.
//
// This hook supplies the missing writer. It is the only place that sees both ids
// at once: the harness hands it the conversation id as `input.session_id`, and
// the workspace id is recovered from the `session_start` call (see below).
//
// Fires at SESSION-START time, immediately, with no dependency on transcript
// ingest cadence — the link exists before the creating conversation's own
// transcript is next ingested.
//
// ## Why the workspace id is NOT read from `tool_result` alone (mt#3182)
//
// As originally shipped this hook resolved the workspace id ONLY from the tool
// payload, preferring `tool_result.session.sessionId` for the common case where
// the caller supplies no explicit `sessionId`. It wrote ZERO rows in
// production — 0 against 235 sessions — because the harness's PostToolUse
// payload for `mcp__minsky__session_start` does not carry `tool_result` in that
// parsed shape. The hook took its silent early-exit path on every invocation.
//
// The failure was invisible for two compounding reasons: the only signal was a
// line on stderr that nothing reads, and the unit tests hand-BUILT a
// `tool_result` and so exercised a payload production never produces.
// `stamp-pr-author-link.ts` — which this file otherwise mirrors — is unaffected
// only because `session_pr_create` callers pass `sessionId` as a PARAMETER, so
// it resolves from `tool_input` and never depends on the result. Mirroring its
// resolution order was therefore the defect, not the safeguard.
//
// So resolution is now two-tier: the payload if it happens to carry the id
// (cheap, no IO), otherwise a DB lookup keyed on `tool_input.task`, which the
// harness DOES reliably supply. `session_start` refuses to create a second
// session for a task that already has one, so "newest session for this task"
// unambiguously identifies the session this very call just minted.
//
// @see mt#3120 — this hook
// @see mt#3182 — the never-wrote defect and this fix
// @see mt#3101 — stamp-pr-author-link.ts, whose resolution order does NOT transfer here
// @see packages/domain/src/transcripts/session-creator-link-writer.ts — the write it performs

import { readInput } from "./types";
import type { ToolHookInput } from "./types";
// mt#3046: STATIC — installs the tsyringe reflect polyfill before any domain
// module loads. The dynamic persistence import below needs it, and a dynamic
// import cannot install it retroactively.
import { ensureHookDomainBootstrap } from "./domain-bootstrap";

const COVERED_TOOL_NAME = "mcp__minsky__session_start";
const LOG_PREFIX = "[stamp-session-creator-link]";

/**
 * Overall budget for the DB work, well inside the hook's own timeout.
 *
 * Mirrors `stamp-pr-author-link.ts`'s deadline: `ensureHookDomainBootstrap`
 * caps the CONNECT phase at 2s (mt#2982), but nothing bounds the queries
 * afterwards. This deadline covers the whole path so a hung query cannot hold
 * PostToolUse open.
 */
const DB_DEADLINE_MS = 8000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Pull the minted Minsky workspace session id out of the `session_start`
 * payload, when the payload happens to carry it.
 *
 * Returns null far more often than it looks like it should — in production it
 * returns null on essentially every real invocation, because the harness does
 * not supply `tool_result` in the shape the last two branches read (mt#3182).
 * That is expected, not exceptional: the caller falls back to
 * `lookupWorkspaceSessionIdByTask`. Kept as a fast path for the case where a
 * caller DID pass an explicit id, which needs no IO to honor.
 *
 * Exported for tests.
 */
export function resolveWorkspaceSessionId(input: ToolHookInput): string | null {
  const params = input.tool_input ?? {};
  const result = input.tool_result ?? {};

  if (typeof params["sessionId"] === "string" && params["sessionId"]) {
    return params["sessionId"];
  }
  if (typeof params["session"] === "string" && params["session"]) {
    return params["session"];
  }
  if (isObject(result["session"]) && typeof result["session"]["sessionId"] === "string") {
    return result["session"]["sessionId"] || null;
  }
  if (typeof result["sessionId"] === "string" && result["sessionId"]) {
    return result["sessionId"];
  }
  return null;
}

/**
 * The task id the `session_start` call was made for.
 *
 * This is the fallback resolution key, and unlike `tool_result` it is part of
 * the call's own INPUT — the harness supplies it for every task-bound
 * `session_start`. Accepts both the canonical `taskId` and the `task` alias the
 * tool actually declares (see `no-entity-id-param-drift`, mt#2780).
 *
 * Exported for tests.
 */
export function resolveTaskId(input: ToolHookInput): string | null {
  const params = input.tool_input ?? {};
  for (const key of ["taskId", "task"]) {
    const v = params[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * The harness conversation id — the id the transcript is stored under.
 *
 * Exported for tests. The `as ConversationId` at the call site is a brand mint
 * at the harness boundary (the documented `ids.ts` "re-mint on inbound parse"
 * case), not a cross-space cast.
 */
export function resolveConversationId(input: ToolHookInput): string | null {
  const raw = input.session_id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Newest workspace session recorded for `taskId`, or null.
 *
 * Correct because `session_start` refuses to create a second session for a task
 * that already has one: at PostToolUse time the newest row for this task IS the
 * session this call just minted. Ordered by `createdAt` descending rather than
 * asserting a single row, so a task whose earlier session was deleted and
 * recreated still resolves to the live one.
 *
 * Takes the table as a parameter so the query shape is unit-testable against a
 * stub `db` without importing the schema (and thus the whole domain) into tests.
 *
 * Exported for tests.
 */
export async function lookupWorkspaceSessionIdByTask(
  db: {
    select: (fields: unknown) => {
      from: (table: unknown) => {
        where: (cond: unknown) => {
          orderBy: (order: unknown) => { limit: (n: number) => Promise<unknown[]> };
        };
      };
    };
  },
  table: { sessionId: unknown; taskId: unknown; createdAt: unknown },
  ops: { eq: (a: unknown, b: unknown) => unknown; desc: (a: unknown) => unknown },
  taskId: string
): Promise<string | null> {
  const rows = await db
    .select({ sessionId: table.sessionId })
    .from(table)
    .where(ops.eq(table.taskId, taskId))
    .orderBy(ops.desc(table.createdAt))
    .limit(1);

  const first = rows[0];
  if (isObject(first) && typeof first["sessionId"] === "string" && first["sessionId"]) {
    return first["sessionId"];
  }
  return null;
}

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  if (input.tool_name !== COVERED_TOOL_NAME) {
    process.exit(0);
  }

  const conversationId = resolveConversationId(input);
  const payloadWorkspaceSessionId = resolveWorkspaceSessionId(input);
  const taskId = resolveTaskId(input);

  if (!conversationId) {
    process.stderr.write(
      `${LOG_PREFIX} skipped: hook input carried no session_id (harness conversation id) — no link recorded\n`
    );
    process.exit(0);
  }

  // Neither resolution route is available: the payload has no id AND there is
  // no task to look one up by. Nothing recoverable — a taskless session_start.
  if (!payloadWorkspaceSessionId && !taskId) {
    process.stderr.write(
      `${LOG_PREFIX} skipped: no workspace session id in the payload and no task id to resolve one by — no link recorded\n`
    );
    process.exit(0);
  }

  let workspaceSessionId: string | null = payloadWorkspaceSessionId;

  try {
    const bootstrap = await ensureHookDomainBootstrap();
    if (!bootstrap.ok) {
      process.stderr.write(
        `${LOG_PREFIX} warn: domain bootstrap failed: ${bootstrap.error} — no link recorded\n`
      );
      process.exit(0);
    }

    const { resolvePersistenceProvider } = await import(
      "../../packages/domain/src/persistence/factory"
    );
    const { writeSessionCreatorLink } = await import(
      "../../packages/domain/src/transcripts/session-creator-link-writer"
    );

    const provider = await resolvePersistenceProvider();
    if (!provider || !("getDatabaseConnection" in provider)) {
      process.stderr.write(`${LOG_PREFIX} warn: no SQL-capable persistence provider\n`);
      process.exit(0);
    }

    const db = await (
      provider as { getDatabaseConnection(): Promise<unknown> }
    ).getDatabaseConnection();
    if (!db) {
      process.stderr.write(`${LOG_PREFIX} warn: persistence provider returned no connection\n`);
      process.exit(0);
    }

    // mt#3182: the normal production path — the payload did not carry the id,
    // so recover it from the task the call was made for.
    if (!workspaceSessionId && taskId) {
      const { postgresSessions } = await import(
        "../../packages/domain/src/storage/schemas/session-schema"
      );
      const { eq, desc } = await import("drizzle-orm");
      workspaceSessionId = await lookupWorkspaceSessionIdByTask(
        db as Parameters<typeof lookupWorkspaceSessionIdByTask>[0],
        postgresSessions,
        { eq, desc },
        taskId
      );

      if (!workspaceSessionId) {
        process.stderr.write(
          `${LOG_PREFIX} warn: no session row found for task ${taskId} — no link recorded\n`
        );
        process.exit(0);
      }
    }

    const outcome = await Promise.race([
      writeSessionCreatorLink(db as import("drizzle-orm/postgres-js").PostgresJsDatabase, {
        conversationId: conversationId as import("../../packages/domain/src/ids").ConversationId,
        workspaceSessionId: workspaceSessionId as string,
        cwd: input.cwd,
      }),
      new Promise<"deadline">((resolve) => {
        setTimeout(() => resolve("deadline"), DB_DEADLINE_MS).unref?.();
      }),
    ]);

    if (outcome === "deadline") {
      process.stderr.write(
        `${LOG_PREFIX} warn: link write exceeded ${DB_DEADLINE_MS}ms for conversation ${conversationId} / workspace ${workspaceSessionId} — abandoning so session creation is not held up\n`
      );
    } else if (outcome === "error") {
      process.stderr.write(
        `${LOG_PREFIX} warn: link write failed for conversation ${conversationId} / workspace ${workspaceSessionId}\n`
      );
    }
  } catch (err) {
    // Surfaced, not swallowed: a bare `catch {}` here is the mechanism that hid
    // mt#3046's defect for the life of that hook.
    process.stderr.write(
      `${LOG_PREFIX} warn: link stamping failed for workspace ${workspaceSessionId}: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }

  process.exit(0);
}
