#!/usr/bin/env bun
/**
 * Smoke test for conversation-title generation (mt#3321).
 *
 * Verifies the REAL wiring end-to-end: config -> AI completion service ->
 * DirectCognitionProvider -> TitleGenerator -> (execute mode) TitlePipeline
 * write. Unit tests cover the logic with fakes; only this exercises the live
 * model call and the actual column write.
 *
 * Two modes, and BOTH must be exercised before shipping (the `--execute`
 * branch has imports and a DB write the dry-run never touches):
 *
 *   bun scripts/smoke-conversation-titles.ts                  # dry-run: generate + print, NO write
 *   bun scripts/smoke-conversation-titles.ts --execute        # bounded real run (writes titles)
 *   bun scripts/smoke-conversation-titles.ts --limit 3        # candidate bound (default 1)
 *   bun scripts/smoke-conversation-titles.ts --session <uuid> # target one conversation
 *   bun scripts/smoke-conversation-titles.ts --execute --force # re-title already-titled rows
 *
 * Exit 0 = pass (or a clean SKIP when the environment can't run it);
 * non-zero = failure. Emits a JSON result block on stdout.
 */

import "reflect-metadata";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
/**
 * Re-title rows that already have a title. Exposed so the smoke can exercise
 * the force WHERE against a REAL database (PR #2408 R1) — that branch builds a
 * different condition set and the unit fakes cannot prove its SQL executes.
 */
const FORCE = args.includes("--force");
const LIMIT = readNumberFlag("--limit") ?? 1;
const SESSION = readStringFlag("--session");

function readStringFlag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : null;
}
function readNumberFlag(name: string): number | null {
  const raw = readStringFlag(name);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function emit(status: "pass" | "fail" | "skip", detail: Record<string, unknown>): never {
  console.log(JSON.stringify({ smoke: "conversation-titles", status, ...detail }, null, 2));
  process.exit(status === "fail" ? 1 : 0);
}

async function main(): Promise<void> {
  // Container bootstrap mirrors scripts/dedupe-transcript-lines.ts — the
  // established pattern for a script that needs the SQL connection. This must
  // come FIRST: `getConfiguration()` throws until the container has
  // initialized configuration.
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");

  const container = await createCliContainer();
  await container.initialize();

  const { getConfiguration } = await import("@minsky/domain/configuration");
  const config = getConfiguration();

  // Env gate: skip cleanly rather than failing when there is no AI credential.
  if (!config?.ai?.providers?.anthropic?.apiKey) {
    emit("skip", {
      reason: "SKIP: no anthropic API key configured; cannot exercise the model call",
    });
  }

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (
    !persistence ||
    !(persistence instanceof PersistenceProvider) ||
    !persistence.capabilities.sql ||
    typeof persistence.getDatabaseConnection !== "function"
  ) {
    emit("skip", { reason: "SKIP: persistence provider is not SQL-capable" });
  }
  const connection = await persistence.getDatabaseConnection();
  if (!connection) emit("skip", { reason: "SKIP: no database connection available" });
  const db = connection as import("drizzle-orm/postgres-js").PostgresJsDatabase;

  const { DefaultAICompletionService } = await import("@minsky/domain/ai/completion-service");
  const { DirectCognitionProvider } = await import("@minsky/domain/cognition/providers/direct");
  const configService = { loadConfiguration: () => Promise.resolve({ resolved: config }) };
  const cognition = new DirectCognitionProvider(new DefaultAICompletionService(configService));

  if (EXECUTE) {
    // ── Real branch: runs the pipeline, which WRITES agent_transcripts.title.
    const { TitlePipeline } = await import("@minsky/domain/transcripts/title-pipeline");
    const result = await new TitlePipeline(db, cognition, {
      batchSize: LIMIT,
      force: FORCE,
    }).run();

    // Read the titles back — verify the OUTCOME, not just that run() returned.
    const { agentTranscriptsTable } = await import(
      "@minsky/domain/storage/schemas/agent-transcripts-schema"
    );
    const { isNotNull, desc } = await import("drizzle-orm");
    const titled = await db
      .select({
        agentSessionId: agentTranscriptsTable.agentSessionId,
        title: agentTranscriptsTable.title,
      })
      .from(agentTranscriptsTable)
      .where(isNotNull(agentTranscriptsTable.title))
      .orderBy(desc(agentTranscriptsTable.startedAt))
      .limit(10);

    if (result.titled === 0 && result.candidates > 0 && result.errored > 0) {
      emit("fail", { mode: "execute", result, reason: "every candidate errored" });
    }
    emit("pass", { mode: "execute", result, titlesInDb: titled });
  }

  // ── Dry-run branch: generate a title WITHOUT writing it.
  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { agentTranscriptTurnsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcript-turns-schema"
  );
  const { TitleGenerator, selectTitleTurns, TURN_SCAN_LIMIT } = await import(
    "@minsky/domain/transcripts/title-generator"
  );
  const { titleCandidateConditions } = await import("@minsky/domain/transcripts/title-pipeline");
  const { and, asc, eq, or, sql, isNotNull, desc } = await import("drizzle-orm");

  // mt#4179 / PR #3040 R1 — the candidate filter is IMPORTED, never restated.
  // This preview drifted from the pipeline twice in one task while it carried
  // its own copy, and an acceptance instrument that previews a different query
  // than the one it exists to check is worse than no instrument.
  const rows = await db
    .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
    .from(agentTranscriptsTable)
    .where(
      SESSION
        ? // `agentSessionId` is a BRANDED ConversationId column, so a plain
          // string argument does not satisfy `eq`'s type; the sql template
          // binds it as a parameter the same way TitlePipeline does.
          sql`${agentTranscriptsTable.agentSessionId} = ${SESSION}`
        : and(...titleCandidateConditions())
    )
    .orderBy(desc(agentTranscriptsTable.startedAt))
    .limit(LIMIT);

  if (rows.length === 0) {
    emit("skip", { mode: "dry-run", reason: "SKIP: no candidate transcripts found" });
  }

  const generator = new TitleGenerator(cognition);
  const generated: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    // Same source and same bound as TitlePipeline.loadTurns — the whole point
    // of the smoke is that it exercises the path that actually runs.
    const turns = await db
      .select({
        userText: agentTranscriptTurnsTable.userText,
        assistantText: agentTranscriptTurnsTable.assistantText,
      })
      .from(agentTranscriptTurnsTable)
      .where(
        and(
          eq(agentTranscriptTurnsTable.agentSessionId, row.agentSessionId),
          or(
            isNotNull(agentTranscriptTurnsTable.userText),
            isNotNull(agentTranscriptTurnsTable.assistantText)
          )
        )
      )
      .orderBy(asc(agentTranscriptTurnsTable.turnIndex))
      .limit(TURN_SCAN_LIMIT);

    if (turns.length === 0) {
      generated.push({ agentSessionId: row.agentSessionId, skipped: "no-turns" });
      continue;
    }

    const visible = selectTitleTurns(turns);
    if (visible.length === 0) {
      generated.push({ agentSessionId: row.agentSessionId, skipped: "no-content" });
      continue;
    }

    // Report BOTH openings: the raw first text-bearing turn and the first one
    // the window actually keeps. When they differ, that difference IS the
    // mt#4179 window fix, and printing only the raw one would hide it.
    const rawOpening = turns[0]?.userText?.slice(0, 90) ?? null;
    const windowOpening = visible[0]?.userText?.slice(0, 90) ?? null;
    const title = await generator.generateTitle(row.agentSessionId, visible);
    generated.push({
      agentSessionId: row.agentSessionId,
      turnsScanned: turns.length,
      turnsSent: visible.length,
      rawOpening,
      windowOpening,
      title,
    });
  }

  const anyTitled = generated.some((g) => typeof g.title === "string" && g.title.length > 0);
  emit(anyTitled ? "pass" : "fail", {
    mode: "dry-run",
    wroteAnything: false,
    generated,
    ...(anyTitled ? {} : { reason: "no title produced for any candidate" }),
  });
}

main().catch((err) => {
  emit("fail", { reason: err instanceof Error ? err.message : String(err) });
});
