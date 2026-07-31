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
 * ## Entry-point bootstrap (mt#3176 — why the imports look like this)
 *
 * A script is its own entry point: nothing installs the tsyringe reflect
 * polyfill or the process-global configuration system for it. The domain module
 * tree pulls tsyringe transitively through the schema chain
 * (schema -> projects-schema -> configuration/backend-detection), so a STATIC
 * import of any domain module — including a Drizzle table — throws
 * "tsyringe requires a reflect polyfill" before a single line of this file
 * runs.
 *
 * The first version of this script did exactly that and died after its HTTP
 * legs, never reaching a database assertion. Hence: `ensureHookDomainBootstrap`
 * is the ONLY non-type import at module scope, it is awaited before anything
 * else, and every domain import below is dynamic and comes after it. Same shape
 * as `scripts/verify-session-creator-link.ts`. Do not "tidy" these into static
 * imports — the ordering is the whole point.
 *
 * ## Cleanup
 *
 * Everything this script writes is deleted before exit, INCLUDING on failure.
 * A synthetic row in `conversation_run_state` is not harmless: the table is the
 * source for cockpit presence rendering, and a probe row that outlives the run
 * shows up as a live-looking conversation that does not exist. The database
 * handle is therefore acquired BEFORE the first write, so the cleanup path can
 * never be unreachable.
 *
 * ## Preconditions vs failures (mt#3176 R1)
 *
 * These are different things and must not share an exit code:
 *
 *   - **Precondition absent** — no cockpit token, daemon not running, no
 *     database. The thing under test could not be reached at all, so there is
 *     nothing to assert. SKIP, exit 0.
 *   - **Failure** — every precondition was met and an assertion did not hold.
 *     Exit 1.
 *
 * The distinction matters because `postRunState` is fail-open by design: it
 * returns false for "daemon is not running" AND for "daemon is running but the
 * ingest path is broken". Collapsing those would make this script either cry
 * wolf whenever the daemon happens to be down, or — far worse — stay quiet
 * about a genuinely broken binding. So reachability is probed separately,
 * BEFORE any assertion runs, and only a reachable-but-wrong daemon fails.
 *
 * Usage:
 *   bun scripts/verify-conversation-run-state.ts
 *
 * Env:
 *   MINSKY_COCKPIT_URL   optional — cockpit origin (default: resolved from the
 *                        cockpit state file, else http://127.0.0.1:3737)
 *
 * Exits 0 on pass, 0 with a SKIP when a precondition is absent, 1 on failure.
 */
import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";
import type { ClaudeHookInput } from "../.minsky/hooks/types";

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

/**
 * Is a cockpit daemon actually listening at `origin`?
 *
 * `/api/health` is a GET, so it is exempt from `mutationAuthMiddleware` and
 * answers without a token — which makes it a clean reachability probe that
 * cannot be confused with an auth problem.
 */
async function probeDaemonReachable(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap FIRST — before any domain import (see the header).
// ---------------------------------------------------------------------------
const bootstrap = await ensureHookDomainBootstrap();
if (!bootstrap.ok) {
  process.stderr.write(`domain bootstrap failed: ${bootstrap.error}\n`);
  process.exit(1);
}

const { buildIngestBody, postRunState, readCockpitToken, resolveCockpitOrigin } = await import(
  "../.minsky/hooks/record-conversation-run-state"
);
const { conversationRunStateTable } = await import(
  "../packages/domain/src/storage/schemas/conversation-run-state-schema"
);
const { resolvePersistenceProvider } = await import("../packages/domain/src/persistence/factory");
const { eq } = await import("drizzle-orm");

const token = readCockpitToken();
if (!token) {
  skip("no cockpit token at <state-dir>/cockpit-token — start the cockpit daemon first");
}

const origin = resolveCockpitOrigin();
process.stdout.write(`cockpit origin: ${origin}\n`);

if (!(await probeDaemonReachable(origin))) {
  skip(`no cockpit daemon reachable at ${origin} — start it first`);
}

// ---------------------------------------------------------------------------
// Acquire the DB handle BEFORE the first write, so cleanup is always reachable.
// ---------------------------------------------------------------------------
const provider = await resolvePersistenceProvider();
if (!provider || !("getDatabaseConnection" in provider)) {
  skip("no SQL persistence provider available — nothing to verify against");
}
const db = await (
  provider as {
    getDatabaseConnection(): Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
  }
).getDatabaseConnection();
record("acquire db handle", true, "connected");

let ok = true;

try {
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
    ok = record("build ingest body", false, "buildIngestBody returned null");
  } else {
    record("build ingest body", true, `conversationId=${body["conversationId"]}`);

    // --- 2. POST it through the REAL auth + route path ---------------------
    const posted = await postRunState(origin, token, body);
    if (!posted) {
      ok = record(
        "POST /api/conversation-run-state",
        false,
        "non-2xx or unreachable — is the daemon running this build, and is migration 0071 applied?"
      );
    } else {
      record("POST /api/conversation-run-state", true, "2xx");

      // --- 3. Read the row back from the live database -------------------
      const rows = await db
        .select()
        .from(conversationRunStateTable)
        .where(eq(conversationRunStateTable.conversationId, PROBE_CONVERSATION_ID));

      const row = rows[0];
      if (!row) {
        ok = record("read back row", false, "POST returned 2xx but no row landed");
      } else {
        record("read back row", true, `lastEventName=${row.lastEventName}`);

        // --- 4. Assert the mapping actually applied ----------------------
        ok =
          record("activity mapped", row.activity === "running", `activity=${row.activity}`) && ok;
        ok =
          record("tool name mapped", row.toolName === "VerifyProbe", `toolName=${row.toolName}`) &&
          ok;
        ok =
          record(
            "tool start stamped",
            row.toolStartedAt !== null,
            `toolStartedAt=${row.toolStartedAt?.toISOString() ?? "null"}`
          ) && ok;
        ok =
          record(
            "prompt id carried",
            row.promptId === "verify-prompt-1",
            `promptId=${row.promptId}`
          ) && ok;

        // --- 5. Upsert semantics: a second event REFRESHES, not duplicates -
        const second = buildIngestBody(
          { ...input, hook_event_name: "Stop" } as ClaudeHookInput,
          new Date()
        );
        if (second && (await postRunState(origin, token, second))) {
          const after = await db
            .select()
            .from(conversationRunStateTable)
            .where(eq(conversationRunStateTable.conversationId, PROBE_CONVERSATION_ID));
          ok =
            record("refresh-not-duplicate", after.length === 1, `rowCount=${after.length}`) && ok;
          ok =
            record(
              "Stop clears the in-flight tool",
              after[0]?.toolName === null && after[0]?.activity === "idle",
              `activity=${after[0]?.activity} toolName=${after[0]?.toolName}`
            ) && ok;
        } else {
          ok = record("refresh-not-duplicate", false, "second POST failed") && ok;
        }
      }
    }
  }
} finally {
  // Runs on every path — pass, assertion failure, or an unexpected throw. A
  // probe row that outlives this script renders as a live conversation that
  // does not exist.
  try {
    const deleted = await db
      .delete(conversationRunStateTable)
      .where(eq(conversationRunStateTable.conversationId, PROBE_CONVERSATION_ID))
      .returning({ id: conversationRunStateTable.conversationId });
    record("cleanup", true, `probe rows deleted=${deleted.length}`);
  } catch (err) {
    // Loud, not swallowed: a failed cleanup leaves prod state behind, which is
    // the one outcome worse than a failed verification.
    record("cleanup", false, `FAILED to delete probe row: ${String(err)}`);
    ok = false;
  }
  await provider.close?.().catch(() => {});
}

process.stdout.write(`\n${JSON.stringify({ results }, null, 2)}\n`);
process.exit(ok ? 0 : 1);
