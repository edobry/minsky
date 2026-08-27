#!/usr/bin/env bun
/**
 * Live probe for the mt#3529 derived workspace -> conversation fallback.
 *
 * Exercises `resolveDerivedConversationLinks` against the REAL transcripts DB
 * and the REAL session records — the query, the branded-id cast, and the
 * ADR-006 scope parse all run against production data, which is the part unit
 * tests (which stub the db) cannot cover.
 *
 * Two arms:
 *
 *   POSITIVE — every workspace whose `agentId` carries a `conv` scope should
 *     derive that conversation, and the derived id must be one that actually
 *     exists in `agent_transcripts`. Where the workspace ALSO has a stamped
 *     link row, the probe reports whether the two agree; a disagreement is
 *     informational, not a failure (a workspace legitimately has several
 *     conversations, and the stamped row wins in the resolver either way).
 *   NEGATIVE — every workspace whose `agentId` is an `unknown:hash:*` (or any
 *     other non-`conv` scope) must derive NOTHING. This is the arm that can
 *     actually fail: if it ever derives something, the resolver would be
 *     inventing links out of ascribed identities.
 *
 * Read-only: issues SELECTs and nothing else.
 *
 * Exit codes: 0 = pass (or SKIP when no DB is configured), 1 = fail.
 *
 * Usage: bun scripts/verify-derived-conversation-link.ts
 */
// tsyringe reflect polyfill. MUST be static and first — the domain imports
// below reach tsyringe-decorated code, and without it the first decorator
// throws before any of this script's own output runs (mt#3178).
import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  conversationIdFromAgentId,
  resolveDerivedConversationLinks,
} from "../src/cockpit/derived-conversation-link";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

interface SqlCapablePersistence {
  getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
}

const isSqlCapablePersistence = (p: unknown): p is SqlCapablePersistence =>
  !!p &&
  !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
  typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

/**
 * Canonical CLI DB/session bootstrap, mirroring the sibling backfill scripts.
 *
 * A bare `getContextInspectorDb()` returns null outside the cockpit server
 * process — that getter reads a singleton the SERVER initializes at boot. A
 * probe that reported that as "SKIP: no DB configured" would be reporting a
 * broken probe as an absent environment (mt#3178's exact failure), so the
 * bootstrap runs here explicitly and a missing DB is distinguished from a
 * missing config.
 */
async function bootstrap(): Promise<{
  db: PostgresJsDatabase | null;
  listSessions: () => Promise<Array<{ sessionId: string; agentId?: string }>>;
} | null> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!isSqlCapablePersistence(persistence)) return null;

  const db = await persistence.getDatabaseConnection();

  const { createSessionProvider } = await import("@minsky/domain/session");
  // The container's persistence IS the initialized PersistenceProvider this
  // factory wants — it accepts one directly (drizzle-session-repository.ts).
  const provider = await createSessionProvider(undefined, persistence as never);

  return {
    db,
    listSessions: () => provider.listSessions(),
  };
}

/**
 * Exit code for an unverified run.
 *
 * Default 0, so running this unattended (or from a machine with no DB) is safe
 * — the established convention for the `scripts/verify-*.ts` family. But a SKIP
 * is an ABSENCE of verification, not a pass, and a caller that wired this into
 * a gate would otherwise read the two as identical. Set
 * `MINSKY_REQUIRE_DERIVED_LINK_PROBE=1` to make a SKIP fail loudly instead.
 */
function skipExitCode(): number {
  return process.env.MINSKY_REQUIRE_DERIVED_LINK_PROBE === "1" ? 2 : 0;
}

function skip(reason: string): number {
  const code = skipExitCode();
  console.log(`SKIP: ${reason}`);
  if (code !== 0) {
    console.error(
      "SKIP treated as failure: MINSKY_REQUIRE_DERIVED_LINK_PROBE=1 demanded a real verification."
    );
  }
  return code;
}

async function main(): Promise<number> {
  const boot = await bootstrap();
  if (!boot) {
    return skip("persistence provider is not SQL-capable in this environment");
  }
  const { db } = boot;
  if (!db) {
    return skip("no Postgres connection available in this environment");
  }

  const records = await boot.listSessions();
  const workspaces = records.map((r) => ({
    sessionId: r.sessionId,
    agentId: r.agentId ?? null,
  }));

  // A probe whose key is undefined silently collapses every workspace onto one
  // map entry and still reports PASS — caught exactly that way while writing
  // this. Fail loudly instead of measuring nothing.
  const keyless = workspaces.filter((w) => !w.sessionId).length;
  if (keyless > 0) {
    console.error(`FAIL: ${keyless} workspace record(s) have no sessionId — probe cannot key them`);
    return 1;
  }

  const convScoped = workspaces.filter((w) => conversationIdFromAgentId(w.agentId) !== null);
  const nonConvScoped = workspaces.filter((w) => conversationIdFromAgentId(w.agentId) === null);

  console.log(
    `Scanned ${workspaces.length} workspace records: ${convScoped.length} carry a conv-scoped agentId, ${nonConvScoped.length} do not.`
  );

  // --- positive arm ---
  const derived = await resolveDerivedConversationLinks(db, convScoped);
  console.log(
    `\nPOSITIVE: ${derived.size}/${convScoped.length} conv-scoped workspaces derived an ` +
      `existence-checked conversation (the remainder name a conversation this deployment ` +
      `has not ingested — correctly dropped).`
  );
  for (const ws of convScoped) {
    const link = derived.get(ws.sessionId);
    const named = conversationIdFromAgentId(ws.agentId);
    console.log(
      `  ${ws.sessionId} names ${named} -> ${link ? `derived ${link.agentSessionId}` : "no transcript row (dropped)"}`
    );
  }

  // --- negative arm (the one that can fail) ---
  const negative = await resolveDerivedConversationLinks(db, nonConvScoped);
  const leaked = Array.from(negative.keys());
  if (leaked.length > 0) {
    console.error(
      `\nFAIL: ${leaked.length} workspace(s) with a non-conv agentId derived a link: ${leaked.join(", ")}`
    );
    return 1;
  }
  console.log(
    `\nNEGATIVE: 0/${nonConvScoped.length} non-conv-scoped workspaces derived a link (expected 0).`
  );

  // Every derived id must be distinct from "nothing" and well-formed — the
  // dangling-reference guard is what keeps the Conversation tab off a 404.
  for (const [sessionId, link] of derived) {
    if (!link.agentSessionId) {
      console.error(`FAIL: ${sessionId} derived an empty conversation id`);
      return 1;
    }
  }

  console.log("\nPASS");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`FAIL: probe errored: ${getLoggableErrorSummary(err)}`);
    process.exit(1);
  });
