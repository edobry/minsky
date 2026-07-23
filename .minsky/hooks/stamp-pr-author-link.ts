#!/usr/bin/env bun
// PostToolUse hook — record which CONVERSATION authored a session PR (mt#3101).
//
// The provenance row for a PR is written inside the MCP SERVER process, which
// only ever holds a Minsky WORKSPACE session id. Every transcript lookup keys
// on the harness CONVERSATION id, so `provenance.session_id` has never
// resolved: measured 2026-07-23, 0 of 1,305 rows, and merge-time AI
// authorship-tier judging has therefore run exactly once.
//
// This hook supplies the missing half. It is the only place that sees both
// ids at once: the harness hands it the conversation id as `input.session_id`,
// and the `session_pr_create` payload carries the workspace id.
//
// Fires at PR-CREATE time, not merge time, because the authorship-relevant
// conversation is the one that WROTE the code. For dispatched work an
// implementer subagent creates the PR and the main agent merges it.
//
// Best-effort and silent on success: it must never disturb PR creation. Every
// failure path writes a DISTINGUISHABLE reason to stderr rather than exiting
// quietly — an unresolvable link and a dead hook must not look alike, which is
// the whole defect class this task belongs to
// (`work-completion.mdc §Invocation path`).
//
// @see mt#3101 — this hook
// @see mt#3066 — the sibling instance; same "only a hook has the conversation id" fact
// @see packages/domain/src/transcripts/pr-author-link-writer.ts — the write it performs

import { readInput } from "./types";
import type { ToolHookInput } from "./types";
// mt#3046: STATIC — installs the tsyringe reflect polyfill before any domain
// module loads. The dynamic persistence import below needs it, and a dynamic
// import cannot install it retroactively.
import { ensureHookDomainBootstrap } from "./domain-bootstrap";

const COVERED_TOOL_NAME = "mcp__minsky__session_pr_create";
const LOG_PREFIX = "[stamp-pr-author-link]";

/**
 * Overall budget for the DB work, well inside the hook's 20s registration.
 *
 * `ensureHookDomainBootstrap` already caps the CONNECT phase at 2s
 * (`HOOK_POSTGRES_CONNECT_TIMEOUT_SECONDS`, mt#2982), but nothing bounds the
 * two inserts afterwards. This deadline covers the whole path so a hung query
 * cannot hold PostToolUse open — the same cooperative-deadline shape mt#3019
 * added to `record-subagent-invocation`. PR #2232 R1.
 */
const DB_DEADLINE_MS = 8000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Pull the Minsky workspace session id out of the `session_pr_create` payload.
 *
 * The tool accepts either `sessionId` or `task`, and its response carries the
 * session record. Mirrors `resolveSessionContext` in
 * `post-merge-unasked-direction-scan.ts` — same payload family, same shapes.
 *
 * WHY `task` IS NOT RESOLVED DIRECTLY (PR #2232 R1). A `task` value is a task
 * id, not a workspace id; mapping one to the other needs a database lookup the
 * hook would have to perform before it can do anything useful. It does not
 * need to: on success `session_pr_create` returns the session record, so the
 * `tool_result.session.sessionId` branch below already covers the task-only
 * input shape. This PR is itself the proof — it was created with
 * `task: "mt#3101"` and no `sessionId`, and the result carried
 * `session.sessionId`. A task-only call that FAILS has no PR to attribute
 * anyway. Covered by a regression test.
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

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  if (input.tool_name !== COVERED_TOOL_NAME) {
    process.exit(0);
  }

  const conversationId = resolveConversationId(input);
  const workspaceSessionId = resolveWorkspaceSessionId(input);

  if (!conversationId || !workspaceSessionId) {
    process.stderr.write(
      `${LOG_PREFIX} skipped: ${
        !conversationId
          ? "hook input carried no session_id (harness conversation id)"
          : "could not resolve a workspace session id from the session_pr_create payload"
      } — no link recorded\n`
    );
    process.exit(0);
  }

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
    const { writePrAuthorLink } = await import(
      "../../packages/domain/src/transcripts/pr-author-link-writer"
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

    const outcome = await Promise.race([
      writePrAuthorLink(db as import("drizzle-orm/postgres-js").PostgresJsDatabase, {
        conversationId: conversationId as import("../../packages/domain/src/ids").ConversationId,
        workspaceSessionId,
        cwd: input.cwd,
      }),
      new Promise<"deadline">((resolve) => {
        setTimeout(() => resolve("deadline"), DB_DEADLINE_MS).unref?.();
      }),
    ]);

    if (outcome === "deadline") {
      process.stderr.write(
        `${LOG_PREFIX} warn: link write exceeded ${DB_DEADLINE_MS}ms for conversation ${conversationId} / workspace ${workspaceSessionId} — abandoning so PR creation is not held up\n`
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
