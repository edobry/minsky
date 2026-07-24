#!/usr/bin/env bun
/**
 * Live verification for the conversation run-state channel (mt#3161).
 *
 * Exercises the REAL wired path end to end — hook body -> HTTP POST ->
 * mutation auth -> route -> event mapping -> Postgres upsert -> read back —
 * against a running cockpit daemon and the live database. Unit tests cover the
 * mapping and the hook's fail-open behavior with fakes; this covers the
 * BINDING between them, which no seam-injected test can (memory `78a6043e`:
 * a never-worked binding is indistinguishable from "no data" at every
 * downstream surface when the error handling is fail-open, and this hook's is
 * fail-open by design).
 *
 * Usage:
 *   bun scripts/verify-conversation-run-state.ts
 *
 * Env:
 *   MINSKY_COCKPIT_URL   optional — cockpit origin (default: resolved from the
 *                        cockpit state file, else http://127.0.0.1:3737)
 *
 * Exits 0 on pass, 1 on fail, 0 with a SKIP message when the preconditions
 * (cockpit token / reachable daemon) are absent.
 */
import { eq } from "drizzle-orm";
import {
  buildIngestBody,
  postRunState,
  readCockpitToken,
  resolveCockpitOrigin,
} from "../.minsky/hooks/record-conversation-run-state";
import type { ClaudeHookInput } from "../.minsky/hooks/types";
import { conversationRunStateTable } from "../packages/domain/src/storage/schemas/conversation-run-state-schema";

/** Synthetic conversation id — namespaced so it can never collide with a real one. */
const PROBE_CONVERSATION_ID = "verify-run-state-probe-mt3161";

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];
function record(step: string, ok: boolean, detail: string): boolean {
  results.push({ step, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${step} — ${detail}\n`);
  return ok;
}

function skip(reason: string): never {
  process.stdout.write(`SKIP: ${reason}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const token = readCockpitToken();
  if (!token)
    skip("no cockpit token at <state-dir>/cockpit-token — start the cockpit daemon first");

  const origin = resolveCockpitOrigin();
  process.stdout.write(`cockpit origin: ${origin}\n`);

  // --- 1. The hook's body builder produces an addressable payload -----------
  const observedAt = new Date();
  const input = {
    session_id: PROBE_CONVERSATION_ID,
    hook_event_name: "PreToolUse",
    cwd: process.cwd(),
    tool_name: "VerifyProbe",
    prompt_id: "verify-prompt-1",
  } as ClaudeHookInput;

  const body = buildIngestBody(input, observedAt);
  if (!body) {
    record("build ingest body", false, "buildIngestBody returned null");
    process.exit(1);
  }
  record("build ingest body", true, `conversationId=${body["conversationId"]}`);

  // --- 2. POST it through the REAL auth + route path -----------------------
  const posted = await postRunState(origin, token, body);
  if (!posted) {
    record(
      "POST /api/conversation-run-state",
      false,
      "non-2xx or unreachable — is the daemon running this build, and is migration 0071 applied?"
    );
    process.exit(1);
  }
  record("POST /api/conversation-run-state", true, "2xx");

  // --- 3. Read the row back from the live database -------------------------
  const { resolvePersistenceProvider } = await import("../packages/domain/src/persistence/factory");
  const provider = await resolvePersistenceProvider();
  if (!provider || !("getDatabaseConnection" in provider)) {
    record("read back row", false, "no SQL persistence provider available");
    process.exit(1);
  }
  const db = await (
    provider as {
      getDatabaseConnection(): Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
    }
  ).getDatabaseConnection();

  try {
    const rows = await db
      .select()
      .from(conversationRunStateTable)
      .where(eq(conversationRunStateTable.conversationId, PROBE_CONVERSATION_ID));

    const row = rows[0];
    if (!row) {
      record("read back row", false, "POST returned 2xx but no row landed");
      process.exit(1);
    }
    record("read back row", true, `lastEventName=${row.lastEventName}`);

    // --- 4. Assert the mapping actually applied ----------------------------
    let ok = true;
    ok = record("activity mapped", row.activity === "running", `activity=${row.activity}`) && ok;
    ok =
      record("tool name mapped", row.toolName === "VerifyProbe", `toolName=${row.toolName}`) && ok;
    ok =
      record(
        "tool start stamped",
        row.toolStartedAt !== null,
        `toolStartedAt=${row.toolStartedAt?.toISOString() ?? "null"}`
      ) && ok;
    ok =
      record("prompt id carried", row.promptId === "verify-prompt-1", `promptId=${row.promptId}`) &&
      ok;

    // --- 5. Upsert semantics: a second event must REFRESH, not duplicate ---
    const second = buildIngestBody(
      { ...input, hook_event_name: "Stop" } as ClaudeHookInput,
      new Date()
    );
    if (second && (await postRunState(origin, token, second))) {
      const after = await db
        .select()
        .from(conversationRunStateTable)
        .where(eq(conversationRunStateTable.conversationId, PROBE_CONVERSATION_ID));
      ok = record("refresh-not-duplicate", after.length === 1, `rowCount=${after.length}`) && ok;
      ok =
        record(
          "Stop clears the in-flight tool",
          after[0]?.toolName === null && after[0]?.activity === "idle",
          `activity=${after[0]?.activity} toolName=${after[0]?.toolName}`
        ) && ok;
    } else {
      ok = record("refresh-not-duplicate", false, "second POST failed") && ok;
    }

    // --- 6. Clean up the synthetic row -------------------------------------
    await db
      .delete(conversationRunStateTable)
      .where(eq(conversationRunStateTable.conversationId, PROBE_CONVERSATION_ID));
    record("cleanup", true, "probe row deleted");

    process.stdout.write(`\n${JSON.stringify({ results }, null, 2)}\n`);
    process.exit(ok ? 0 : 1);
  } finally {
    await provider.close?.().catch(() => {});
  }
}

await main();
