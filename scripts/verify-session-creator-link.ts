#!/usr/bin/env bun
// Verification artifact for mt#3120 — does the workspace-creation bridge
// actually work against the live schema?
//
// The write must satisfy `minsky_session_links`' foreign key to
// `agent_transcripts` even when the creating conversation has not been
// ingested yet, and the reverse-direction read must resolve it. Both run here
// against the real database.
//
// Everything written is deleted before exit, including on failure. A link row
// invented by a verification script is worse than no row: `minsky_session_links`
// is read by the cockpit's Agents/conversation view.
//
// With `--e2e` it additionally spawns the GENERATED hook binary the way the
// harness does — a bare `bun .claude/hooks/stamp-session-creator-link.ts` with
// a `session_start` payload on stdin — and asserts the link it wrote is
// resolvable. That is the production path end to end, minus the tool call.
//
// With `--measure` it additionally runs a READ-ONLY corpus measurement: what
// fraction of sessions created recently have a `session_start` tool-call
// signature anywhere in a transcript (the population this hook addresses),
// vs. today's actual link coverage (the mt#3120 problem statement). This does
// NOT write anything — see the task spec's "Out of scope: building the
// post-hoc transcript-mining WRITER" for why this is a measurement only, not
// a backfill.
//
// With `--live-ui --workspace-id=<realWorkspaceSessionId>` it additionally
// exercises the ACTUAL reader the cockpit Conversation tab consumes —
// `GET /api/agents/<workspaceId>` (src/cockpit/routes/agents.ts) — rather than
// the in-process `resolveConversationForWorkspace` resolver checked above.
// This is the honest way to verify AT2 ("/agents/<id> renders the
// conversation") without a live UI screenshot: the UI is a thin consumer of
// this JSON endpoint's `conversations` array, and this is the SAME
// link-class-agnostic query path mt#3101's `pr_author` links already exercise
// in production. `--workspace-id` MUST be a real, already-existing session
// (its own `sessions` table row) — this script does not create one, since
// that table is outside this writer's scope; a scratch `session_creator` link
// is attached to it temporarily and removed in the `finally` block below, so
// the target session's own real data is untouched. Optional
// `--cockpit-url=<url>` overrides the default `http://127.0.0.1:3737`. SKIPS
// (does not fail) when `--workspace-id` is omitted or the cockpit is
// unreachable — this is an additional live check, not a hard requirement.
//
// Usage:  bun scripts/verify-session-creator-link.ts [--e2e] [--measure] [--live-ui --workspace-id=<id>] [--cockpit-url=<url>]
// Exit:   0 = pass (or SKIP when the domain cannot reach a DB), non-zero = fail.
//
// @see mt#3120 — this task
// @see mt#3101 / scripts/verify-pr-author-link.ts — the sibling this mirrors
// @see packages/domain/src/transcripts/session-creator-link-writer.ts — the write under test
// @see src/cockpit/routes/agents.ts — the reader --live-ui exercises

import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";
import type { ConversationId } from "@minsky/domain/ids";

const RUN_E2E = process.argv.includes("--e2e");
const RUN_MEASURE = process.argv.includes("--measure");
const RUN_LIVE_UI = process.argv.includes("--live-ui");
const WORKSPACE_ID_ARG = process.argv.find((a) => a.startsWith("--workspace-id="));
const LIVE_UI_WORKSPACE_ID = WORKSPACE_ID_ARG
  ? WORKSPACE_ID_ARG.slice("--workspace-id=".length)
  : null;
const COCKPIT_URL_ARG = process.argv.find((a) => a.startsWith("--cockpit-url="));
const COCKPIT_URL = COCKPIT_URL_ARG
  ? COCKPIT_URL_ARG.slice("--cockpit-url=".length)
  : "http://127.0.0.1:3737";

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

const steps: Step[] = [];
let failed = false;

function record(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  if (!ok) failed = true;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}\n`);
}

// Gate on the REAL bootstrap, not on env vars: Minsky's DSN lives in
// `~/.config/minsky/config.yaml`, so an env-var-only gate SKIPs unconditionally
// on a correctly-configured machine (mt#3066 hit exactly that).
const bootstrap = await ensureHookDomainBootstrap();
if (!bootstrap.ok) {
  process.stdout.write(`SKIP: domain bootstrap unavailable: ${bootstrap.error}\n`);
  process.exit(0);
}

const { resolvePersistenceProvider } = await import("../packages/domain/src/persistence/factory");
const { writeSessionCreatorLink, SESSION_CREATOR_LINK_TYPE } = await import(
  "../packages/domain/src/transcripts/session-creator-link-writer"
);
const { resolveConversationForWorkspace } = await import(
  "../packages/domain/src/transcripts/conversation-link-resolver"
);
const { minskySessionLinksTable } = await import(
  "../packages/domain/src/storage/schemas/minsky-session-links-schema"
);
const { agentTranscriptsTable } = await import(
  "../packages/domain/src/storage/schemas/agent-transcripts-schema"
);
const { eq, sql } = await import("drizzle-orm");
const { randomUUID } = await import("node:crypto");

const provider = await resolvePersistenceProvider();
if (!provider || !("getDatabaseConnection" in provider)) {
  process.stdout.write("SKIP: no SQL-capable persistence provider\n");
  process.exit(0);
}
const db = (await (
  provider as { getDatabaseConnection(): Promise<unknown> }
).getDatabaseConnection()) as import("drizzle-orm/postgres-js").PostgresJsDatabase;
if (!db) {
  process.stdout.write("SKIP: persistence provider returned no connection\n");
  process.exit(0);
}

// Scratch ids: never collide with real rows, and are what the cleanup targets.
const scratchConversationId = randomUUID() as ConversationId;
const scratchWorkspaceId = randomUUID();
const e2eConversationId = randomUUID() as ConversationId;
const e2eWorkspaceId = randomUUID();
const liveUiConversationId = randomUUID() as ConversationId;

async function cleanup(): Promise<void> {
  for (const conversationId of [scratchConversationId, e2eConversationId, liveUiConversationId]) {
    try {
      await db
        .delete(minskySessionLinksTable)
        .where(eq(minskySessionLinksTable.agentSessionId, conversationId));
      await db
        .delete(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, conversationId));
    } catch (err) {
      process.stdout.write(
        `WARN  cleanup failed for ${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }
}

try {
  // 1. The write survives the FK even though the conversation was never ingested.
  //    This is the case the stub-row upsert exists for; a naive insert 23503s here.
  const preExisting = await db
    .select({ id: agentTranscriptsTable.agentSessionId })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, scratchConversationId))
    .limit(1);

  const outcome = await writeSessionCreatorLink(db, {
    conversationId: scratchConversationId,
    workspaceSessionId: scratchWorkspaceId,
    cwd: process.cwd(),
  });

  record(
    "link writes for a conversation that was never ingested (FK stub path)",
    outcome === "written" && preExisting.length === 0,
    `outcome=${outcome}; the conversation had no agent_transcripts row beforehand`
  );

  // 2. The reverse-direction read resolves it.
  const resolved = await resolveConversationForWorkspace(db, scratchWorkspaceId);
  record(
    "resolveConversationForWorkspace returns the creating conversation",
    resolved === scratchConversationId,
    `resolved=${resolved ?? "null"} expected=${scratchConversationId}`
  );

  // 3. The link carries the new type.
  const linkRows = await db
    .select({ linkType: minskySessionLinksTable.linkType })
    .from(minskySessionLinksTable)
    .where(eq(minskySessionLinksTable.agentSessionId, scratchConversationId));
  record(
    "the link is recorded as session_creator",
    linkRows[0]?.linkType === SESSION_CREATOR_LINK_TYPE,
    `link_type=${linkRows[0]?.linkType ?? "none"}`
  );

  // 4. Re-running for an already-linked pair is an idempotent no-op.
  const beforeRerun = await db
    .select({ id: minskySessionLinksTable.agentSessionId })
    .from(minskySessionLinksTable)
    .where(eq(minskySessionLinksTable.agentSessionId, scratchConversationId));
  await writeSessionCreatorLink(db, {
    conversationId: scratchConversationId,
    workspaceSessionId: scratchWorkspaceId,
    cwd: process.cwd(),
  });
  const afterRerun = await db
    .select({ id: minskySessionLinksTable.agentSessionId })
    .from(minskySessionLinksTable)
    .where(eq(minskySessionLinksTable.agentSessionId, scratchConversationId));
  record(
    "re-running for an already-linked pair is idempotent (no duplicate row)",
    beforeRerun.length === 1 && afterRerun.length === 1,
    `before=${beforeRerun.length} after=${afterRerun.length}`
  );

  // 5. An unlinked workspace resolves to null — the honest "no link" outcome
  //    callers must distinguish from "empty transcript".
  const unlinked = await resolveConversationForWorkspace(db, randomUUID());
  record(
    "an unlinked workspace resolves to null, not to a wrong conversation",
    unlinked === null,
    `resolved=${unlinked ?? "null"}`
  );

  if (RUN_E2E) {
    process.stdout.write("\nRunning --e2e: spawning the generated hook...\n");

    const payload = {
      session_id: e2eConversationId,
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "mcp__minsky__session_start",
      tool_input: { task: "mt#3120" },
      tool_result: { success: true, session: { sessionId: e2eWorkspaceId, taskId: "mt#3120" } },
    };

    const proc = Bun.spawn(["bun", ".claude/hooks/stamp-session-creator-link.ts"], {
      stdin: new Blob([JSON.stringify(payload)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    record(
      "the generated hook exits 0 (it must never disturb session creation)",
      exitCode === 0,
      `exit=${exitCode}${stderr.trim() ? ` stderr=${stderr.trim()}` : ""}${
        stdout.trim() ? ` stdout=${stdout.trim()}` : ""
      }`
    );

    const e2eResolved = await resolveConversationForWorkspace(db, e2eWorkspaceId);
    record(
      "the hook's link resolves back to the creating conversation",
      e2eResolved === e2eConversationId,
      `resolved=${e2eResolved ?? "null"} expected=${e2eConversationId}`
    );
  }

  if (RUN_MEASURE) {
    process.stdout.write("\nRunning --measure: read-only corpus baseline (no writes)...\n");

    const baseline = await db.execute(sql`
      select
        count(*) as total_sessions,
        count(distinct l.minsky_session_id) as sessions_with_any_link
      from sessions s
      left join minsky_session_links l on l.minsky_session_id = s.session
    `);
    const rows = Array.isArray(baseline) ? baseline : (baseline as { rows: unknown[] }).rows;
    const row = rows[0] as { total_sessions: string; sessions_with_any_link: string } | undefined;
    if (row) {
      const total = Number(row.total_sessions);
      const linked = Number(row.sessions_with_any_link);
      const pct = total > 0 ? ((linked / total) * 100).toFixed(1) : "n/a";
      process.stdout.write(
        `MEASURED  baseline link coverage: ${linked}/${total} sessions have any link row (${pct}%)\n` +
          `          This is the PRE-existing baseline (this hook is forward-only; it does not\n` +
          `          move this number retroactively — see spec Out-of-scope on backfill).\n`
      );
    }
  }

  if (RUN_LIVE_UI) {
    if (!LIVE_UI_WORKSPACE_ID) {
      process.stdout.write(
        "\nSKIP --live-ui: no --workspace-id=<realSessionId> provided — cannot attach a scratch " +
          "link to a real session without one (this script does not create sessions table rows).\n"
      );
    } else {
      process.stdout.write(
        `\nRunning --live-ui: attaching a scratch session_creator link to real workspace ` +
          `${LIVE_UI_WORKSPACE_ID} and querying ${COCKPIT_URL}/api/agents/${LIVE_UI_WORKSPACE_ID}...\n`
      );

      const attachOutcome = await writeSessionCreatorLink(db, {
        conversationId: liveUiConversationId,
        workspaceSessionId: LIVE_UI_WORKSPACE_ID,
        cwd: process.cwd(),
      });

      if (attachOutcome !== "written") {
        record(
          "--live-ui: scratch link attached to the real workspace",
          false,
          `outcome=${attachOutcome}`
        );
      } else {
        try {
          const res = await fetch(`${COCKPIT_URL}/api/agents/${LIVE_UI_WORKSPACE_ID}`);
          if (!res.ok) {
            record(
              "--live-ui: GET /api/agents/:id (the cockpit's actual reader) succeeds",
              false,
              `HTTP ${res.status} — is the cockpit running at ${COCKPIT_URL}?`
            );
          } else {
            const body = (await res.json()) as {
              conversations?: Array<{ agentSessionId?: string }>;
            };
            const found = (body.conversations ?? []).some(
              (c) => c.agentSessionId === liveUiConversationId
            );
            record(
              "--live-ui: /api/agents/:id's `conversations` array includes the session_creator link",
              found,
              found
                ? `conversations includes ${liveUiConversationId} — the exact reader the Conversation ` +
                    `tab consumes resolved this class correctly, live, over HTTP`
                : `conversations=${JSON.stringify(body.conversations)} did not include ${liveUiConversationId}`
            );
          }
        } catch (err) {
          record(
            "--live-ui: GET /api/agents/:id (the cockpit's actual reader) succeeds",
            false,
            `fetch failed: ${err instanceof Error ? err.message : String(err)} — is the cockpit running at ${COCKPIT_URL}?`
          );
        }
      }
    }
  }
} finally {
  await cleanup();
  const remaining = await db
    .select({ id: minskySessionLinksTable.agentSessionId })
    .from(minskySessionLinksTable)
    .where(eq(minskySessionLinksTable.agentSessionId, scratchConversationId));
  record(
    "every row this script wrote is removed",
    remaining.length === 0,
    `${remaining.length} scratch link row(s) remain`
  );
}

process.stdout.write(
  `\n${steps.filter((s) => s.ok).length}/${steps.length} checks passed${RUN_E2E ? " (with --e2e)" : ""}${RUN_MEASURE ? " (with --measure)" : ""}${RUN_LIVE_UI ? " (with --live-ui)" : ""}\n`
);
process.exit(failed ? 1 : 0);
