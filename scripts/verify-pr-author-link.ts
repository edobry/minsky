#!/usr/bin/env bun
// Verification artifact for mt#3101 — does the workspace -> conversation
// bridge actually work against the live schema?
//
// The repair has two halves that no unit test can cover together: a WRITE that
// must satisfy `minsky_session_links`' foreign key to `agent_transcripts` even
// when the authoring conversation has not been ingested yet, and a READ that
// must resolve the reverse direction (filtering on `minsky_session_id` alone,
// which the composite PK cannot serve). Both run here against the real
// database.
//
// Everything written is deleted before exit, including on failure. A link row
// invented by a verification script is worse than no row: `minsky_session_links`
// is read by the cockpit's conversation view and now by authorship judging.
//
// With `--e2e` it additionally spawns the GENERATED hook binary the way the
// harness does — a bare `bun .claude/hooks/stamp-pr-author-link.ts` with a
// `session_pr_create` payload on stdin — and asserts the link it wrote is
// resolvable. That is the production path end to end, minus the tool call.
//
// Usage:  bun scripts/verify-pr-author-link.ts [--e2e]
// Exit:   0 = pass (or SKIP when the domain cannot reach a DB), non-zero = fail.
//
// @see mt#3101 — this task
// @see mt#3066 — the sibling id-space fix and its verification discipline
// @see packages/domain/src/transcripts/pr-author-link-writer.ts — the write under test

import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";
import type { ConversationId } from "@minsky/domain/ids";

const RUN_E2E = process.argv.includes("--e2e");

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
const { writePrAuthorLink, PR_AUTHOR_LINK_TYPE } = await import(
  "../packages/domain/src/transcripts/pr-author-link-writer"
);
const { resolveConversationForWorkspace } = await import(
  "../packages/domain/src/transcripts/conversation-link-resolver"
);
const { isAuthorshipTierJudgingEnabled } = await import(
  "../packages/domain/src/provenance/authorship-judging-flag"
);
const { minskySessionLinksTable } = await import(
  "../packages/domain/src/storage/schemas/minsky-session-links-schema"
);
const { agentTranscriptsTable } = await import(
  "../packages/domain/src/storage/schemas/agent-transcripts-schema"
);
const { eq } = await import("drizzle-orm");
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
// Branded at the mint site — these ARE conversation ids by construction here,
// and the `agent_session_id` column is typed `ConversationId`.
const scratchConversationId = randomUUID() as ConversationId;
const scratchWorkspaceId = randomUUID();
const e2eConversationId = randomUUID() as ConversationId;
const e2eWorkspaceId = randomUUID();

async function cleanup(): Promise<void> {
  for (const conversationId of [scratchConversationId, e2eConversationId]) {
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
  // 1. The flag is off by default — the operator decision this repair ships with.
  record(
    "merge-time authorship judging is OFF by default",
    isAuthorshipTierJudgingEnabled() === false,
    "isAuthorshipTierJudgingEnabled() === false with MINSKY_AUTHORSHIP_TIER_JUDGING unset"
  );

  // 2. The write survives the FK even though the conversation was never ingested.
  //    This is the case the stub-row upsert exists for; a naive insert 23503s here.
  const preExisting = await db
    .select({ id: agentTranscriptsTable.agentSessionId })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, scratchConversationId))
    .limit(1);

  const outcome = await writePrAuthorLink(db, {
    conversationId: scratchConversationId,
    workspaceSessionId: scratchWorkspaceId,
    cwd: process.cwd(),
  });

  record(
    "link writes for a conversation that was never ingested (FK stub path)",
    outcome === "written" && preExisting.length === 0,
    `outcome=${outcome}; the conversation had no agent_transcripts row beforehand`
  );

  // 3. The reverse-direction read resolves it.
  const resolved = await resolveConversationForWorkspace(db, scratchWorkspaceId);
  record(
    "resolveConversationForWorkspace returns the authoring conversation",
    resolved === scratchConversationId,
    `resolved=${resolved ?? "null"} expected=${scratchConversationId}`
  );

  // 4. The link carries the new type.
  const linkRows = await db
    .select({ linkType: minskySessionLinksTable.linkType })
    .from(minskySessionLinksTable)
    .where(eq(minskySessionLinksTable.agentSessionId, scratchConversationId));
  record(
    "the link is recorded as pr_author",
    linkRows[0]?.linkType === PR_AUTHOR_LINK_TYPE,
    `link_type=${linkRows[0]?.linkType ?? "none"}`
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
      tool_name: "mcp__minsky__session_pr_create",
      tool_input: { sessionId: e2eWorkspaceId },
      tool_result: { session: { sessionId: e2eWorkspaceId } },
    };

    const proc = Bun.spawn(["bun", ".claude/hooks/stamp-pr-author-link.ts"], {
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
      "the generated hook exits 0 (it must never disturb PR creation)",
      exitCode === 0,
      `exit=${exitCode}${stderr.trim() ? ` stderr=${stderr.trim()}` : ""}${
        stdout.trim() ? ` stdout=${stdout.trim()}` : ""
      }`
    );

    const e2eResolved = await resolveConversationForWorkspace(db, e2eWorkspaceId);
    record(
      "the hook's link resolves back to the authoring conversation",
      e2eResolved === e2eConversationId,
      `resolved=${e2eResolved ?? "null"} expected=${e2eConversationId}`
    );
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
  `\n${steps.filter((s) => s.ok).length}/${steps.length} checks passed${RUN_E2E ? " (with --e2e)" : ""}\n`
);
process.exit(failed ? 1 : 0);
