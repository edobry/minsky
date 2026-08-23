/**
 * Snapshot-window SQL behaviour — Testcontainers + real Postgres (mt#4302)
 *
 * mt#4263 windows `GET /api/cockpit/context-inspector/snapshot` in SQL. Two of
 * its success criteria named tests that were never written, because the
 * behaviour they cover lives in the SQL rather than in TypeScript, and both
 * were verified by hand against production Postgres instead. This file is the
 * guard that keeps them true.
 *
 * ## Why a stubbed `db` cannot cover this
 *
 * The obvious cheap route — hand `assembleSessionContextSnapshot` a fake `db`
 * whose `execute()` returns canned rows — tests the TypeScript assembly and is
 * silent about the thing at risk. The window is applied by
 * `jsonb_path_query_array` over an index range, the attachment bound is a
 * `timestamptz` comparison against `min()`/`max()` of the sliced turns, and the
 * ordinals come from arithmetic on `jsonb_array_length`. A stub returns
 * whatever the test hands it, so every one of those could be wrong and the test
 * would still pass. Same argument mt#3709 makes about its own fake-DB gap: a
 * fake tests the caller, not the substrate.
 *
 * ## Why pg17 here when the sibling testcontainer tests pin pg16
 *
 * SC5 requires `EXPLAIN (ANALYZE, SERIALIZE)`, and the `SERIALIZE` option was
 * introduced in PostgreSQL 17 — on pg16 it is a syntax error, so the criterion
 * is unrunnable there. `output=` is the only figure that measures what the
 * window is FOR (bytes serialized to the client) rather than a proxy for it,
 * which is precisely why mt#4263 settled for response size and left SC2 unmet.
 *
 * Two-level gate (mirrors short-id-conflict-inference.testcontainer.integration.test.ts):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=180000 \
 *       tests/integration/snapshot-window-sql.testcontainer.integration.test.ts
 *
 * Or: bun run test:integration:docker (a glob over
 * tests/integration/*.testcontainer.integration.test.ts, so this file is picked
 * up with no script change).
 *
 * If the container fails to start with a "Log message ... Started ... not
 * received" error, that is testcontainers' Ryuk reaper sidecar failing to come
 * up in time. Workaround: TESTCONTAINERS_RYUK_DISABLED=true.
 *
 * @see mt#4302 — this file's originating task
 * @see mt#4263 — the windowing this covers; carries the live measurements
 * @see packages/domain/src/transcripts/session-context-snapshot.ts — the branch under test
 */

import { afterAll, describe, test, expect } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "path";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration journal, mirroring production's own bootstrap path (postgres-bootstrap.ts), not test-state faking
import { readFileSync } from "fs";
import {
  resolvePgMigrationsFolder,
  type Journal,
} from "@minsky/domain/persistence/postgres-migration-operations";
import { bootstrapFreshPostgres } from "@minsky/domain/persistence/postgres-bootstrap";
import { assembleSessionContextSnapshot } from "@minsky/domain/transcripts/session-context-snapshot";
import type { AgentSessionId } from "@minsky/domain/transcripts/transcript-source";
import type { SessionContextSnapshot } from "@minsky/domain/context/types";

// No-op wait strategy — every built-in testcontainers wait strategy hangs under
// Bun; readiness is determined by our own SQL probe below. See
// postgres-pool-saturation.testcontainer.integration.test.ts for the full rationale.
function makeNoOpWaitStrategy(defaultTimeoutMs: number): WaitStrategy {
  let storedTimeoutMs: number | undefined;
  const strategy: WaitStrategy = {
    async waitUntilReady() {
      // Intentionally empty — readiness is determined by the SQL probe below.
    },
    withStartupTimeout(timeoutMs: number) {
      storedTimeoutMs = timeoutMs;
      return strategy;
    },
    isStartupTimeoutSet() {
      return storedTimeoutMs !== undefined;
    },
    getStartupTimeout() {
      return storedTimeoutMs ?? defaultTimeoutMs;
    },
  };
  return strategy;
}

// pg17 for EXPLAIN (ANALYZE, SERIALIZE) — see the docblock. pgvector because
// the embeddings tables declare `vector(...)` columns, so migration replay
// needs the extension available.
const POSTGRES_IMAGE = "pgvector/pgvector:pg17";

const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";
const TOTAL_TURNS = 120;
const PAGE = 20;
/** Index of the newest page's oldest turn: 120 - 20 = 100. */
const PAGE1_LO = TOTAL_TURNS - PAGE;

const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Turn `i` is stamped exactly `i` minutes after the base. */
function turnTimestamp(i: number): string {
  return new Date(BASE_MS + i * 60_000).toISOString();
}

/**
 * ~4 KB of message content per turn, so the unwindowed payload is decisively
 * over the SC2 ceiling and the windowed one decisively under it. Varied by
 * index rather than a constant string so jsonb compression cannot collapse the
 * corpus into something unrepresentative of a real transcript.
 */
function turnBody(i: number, reps = 400): string {
  return `turn-${i} `.repeat(reps);
}

/**
 * A SECOND, larger conversation, used only by SC5.
 *
 * The criterion specifies at least 1,000 turns with a 50-turn window, and it
 * specifies that because the ratio a window delivers scales with how much of
 * the transcript it EXCLUDES. The 120-turn conversation above windows 20 of 120
 * — roughly 6x by count — and measures 5.4x, which is correct behaviour and
 * simply not the regime mt#4263 measured (2,236 turns, a 50-turn window, 51.6x
 * end-to-end). Asserting 10x against the small conversation would be asserting
 * something the mechanism never claimed.
 *
 * Per-turn body is deliberately small here: both EXPLAIN'd statements read the
 * same rows, so body size cancels out of the ratio while making the seed insert
 * an order of magnitude cheaper.
 */
const BIG_CONVERSATION_ID = "99999999-8888-7777-6666-555555555555";
const BIG_TOTAL_TURNS = 1000;
const BIG_PAGE = 50;
const BIG_LO = BIG_TOTAL_TURNS - BIG_PAGE;

function makeTranscript(count = TOTAL_TURNS, reps = 400): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? "user" : "assistant",
    uuid: `turn-uuid-${i}`,
    parentUuid: i === 0 ? null : `turn-uuid-${i - 1}`,
    timestamp: turnTimestamp(i),
    message: { role: i % 2 === 0 ? "user" : "assistant", content: turnBody(i, reps) },
  }));
}

/**
 * Attachments placed to straddle the page-1 window boundary in every direction.
 *
 * Page 1 (newest, no `before`) covers turn indices 100..119, i.e. timestamps
 * minute 100 through minute 119. Its attachment bound is
 * `timestamp >= min(sliced turn timestamps)` with the UPPER bound deliberately
 * OPEN — a live conversation can land an attachment after its last turn.
 *
 * Page 2 (`before: 100`) covers 80..99 and DOES apply an upper bound, which is
 * the whole point of SC4.
 */
const ATTACHMENTS = [
  // Below page 1's lower edge by one minute — outside page 1, inside page 2.
  { lineIndex: 1, ts: turnTimestamp(99), label: "below-edge" },
  // Exactly ON page 1's lower edge — the `>=` boundary case.
  { lineIndex: 2, ts: turnTimestamp(PAGE1_LO), label: "on-lower-edge" },
  // Comfortably inside page 1.
  { lineIndex: 3, ts: turnTimestamp(110), label: "inside" },
  // Newer than the newest turn — inside page 1 by the OPEN upper bound.
  { lineIndex: 4, ts: turnTimestamp(TOTAL_TURNS), label: "after-last-turn" },
  // Far below both pages.
  { lineIndex: 5, ts: turnTimestamp(10), label: "far-below" },
];

/**
 * Narrow away the `| null` ONCE rather than asserting it away at every use.
 *
 * A null here means the conversation row was not found at all — a seeding
 * failure, not something any criterion below is about — so it should abort with
 * a message that says so instead of surfacing as a confusing property access.
 */
function requireSnapshot(s: SessionContextSnapshot | null): SessionContextSnapshot {
  if (s === null) {
    throw new Error("assembleSessionContextSnapshot returned null — was the conversation seeded?");
  }
  return s;
}

/** The paging cursor, with the same narrow-once treatment. */
function requireNextBefore(s: SessionContextSnapshot): number {
  const nb = s.window?.nextBefore;
  if (typeof nb !== "number") {
    throw new Error(`expected a numeric window.nextBefore, got ${String(nb)}`);
  }
  return nb;
}

function attachmentLabels(snapshot: { blocks: Array<{ id: string; content: unknown }> }): string[] {
  return snapshot.blocks
    .map((b) => (b.content as { label?: unknown } | null)?.label)
    .filter((l): l is string => typeof l === "string")
    .sort();
}

/**
 * Pull `output=<n><unit>` out of an EXPLAIN (ANALYZE, SERIALIZE) plan, in BYTES.
 *
 * The unit is load-bearing and easy to drop: Postgres reports this figure in kB
 * for anything non-trivial, so a digits-only regex silently returns a number
 * ~1000x smaller than it looks. Two such figures still COMPARE correctly while
 * both are kB, which is exactly how a unit bug survives a ratio assertion — so
 * this parses the unit and throws on one it does not know rather than assuming.
 */
function parseSerializeOutputBytes(plan: string): number {
  const match = /output=(\d+)([kMG]?B)/.exec(plan);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`no output=<n><unit> figure in EXPLAIN plan:\n${plan}`);
  }
  const scale: Record<string, number> = { B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  const factor = scale[match[2]];
  if (factor === undefined) throw new Error(`unrecognized EXPLAIN output unit: ${match[2]}`);
  return Number(match[1]) * factor;
}

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[snapshot-window/testcontainer] starting ${POSTGRES_IMAGE}\n`);

  let container;
  try {
    container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_PASSWORD: "postgres",
        POSTGRES_USER: "postgres",
        POSTGRES_DB: "postgres",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(makeNoOpWaitStrategy(120_000))
      .withStartupTimeout(120_000)
      .start();
  } catch (err) {
    process.stdout.write(
      `[snapshot-window/testcontainer] container start FAILED: ${err instanceof Error ? err.message : String(err)}\n`
    );
    throw err;
  }

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgresql://postgres:postgres@${host}:${port}/postgres`;

  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() used for a timing deadline, not path creation
  const probeDeadline = Date.now() + 60_000;
  let probeReady = false;
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same false positive: Date.now() compared against a deadline variable
  while (Date.now() < probeDeadline) {
    try {
      const probe = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        probeReady = true;
        break;
      } finally {
        await probe.end().catch(() => {});
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!probeReady) {
    await container.stop().catch(() => {});
    throw new Error(
      `[snapshot-window/testcontainer] postgres readiness probe timed out after 60s at ${host}:${port}`
    );
  }

  const sql = postgres(connectionString, { prepare: false, max: 5 });

  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  const migrationsFolder = resolvePgMigrationsFolder();
  // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration journal, mirroring production's own bootstrap path
  const journalRaw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), {
    encoding: "utf8",
  }) as string;
  const journal = JSON.parse(journalRaw) as Journal;
  const bootstrapResult = await bootstrapFreshPostgres(sql, migrationsFolder, journal);
  if (!bootstrapResult) {
    await container.stop().catch(() => {});
    throw new Error(
      `[snapshot-window/testcontainer] no bootstrap snapshot found at ${migrationsFolder}/bootstrap`
    );
  }
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder });

  // WORKAROUND — tracking task mt#3509. The bootstrap snapshot declares itself
  // current through journal entry 0048 but does NOT contain
  // `agent_transcript_attachments`, which entry 0039 creates.
  // `bootstrapFreshPostgres` stamps the drizzle ledger through `throughTag`, so
  // `migrate()` starts at 0049 and never replays 0039 — on this path the table
  // can never be created, and every attachment assertion below would fail with
  // `42P01`. Applying 0039 explicitly is the only way this file can run at all.
  //
  // Escalation threshold: DELETE this block the moment mt#3509 lands. The
  // else-branch below reports that case in the run output rather than silently
  // no-opping, so the workaround cannot outlive its cause unnoticed.
  const attachmentsTable = await sql`
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'agent_transcript_attachments'
    limit 1
  `;
  if (attachmentsTable.length === 0) {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- reads a real committed migration file, the same artifact drizzle's own migrator reads
    const ddl = readFileSync(join(migrationsFolder, "0039_agent_transcript_attachments.sql"), {
      encoding: "utf8",
    }) as string;
    for (const stmt of ddl.split("--> statement-breakpoint")) {
      if (stmt.trim().length > 0) await sql.unsafe(stmt);
    }
    process.stdout.write(
      `[snapshot-window/testcontainer] mt#3509 workaround ACTIVE: bootstrap omitted ` +
        `agent_transcript_attachments (created by 0039, snapshot stamped through 0048); applied it explicitly\n`
    );
  } else {
    process.stdout.write(
      `[snapshot-window/testcontainer] mt#3509 appears FIXED — the bootstrap created ` +
        `agent_transcript_attachments. Delete the workaround block in this file.\n`
    );
  }

  // Seed one conversation: 120 turns plus the boundary-straddling attachments.
  // Bound as a STRING with an explicit ::jsonb cast rather than via `sql.json`.
  // postgres-js's json helper hands the array straight to its Bind serializer,
  // which calls Buffer.byteLength on it and throws ERR_INVALID_ARG_TYPE for a
  // non-string. Stringify-and-cast is the shape the rest of the repo uses.
  await sql`
    insert into agent_transcripts (agent_session_id, harness, transcript)
    values (${CONVERSATION_ID}, 'claude_code', ${JSON.stringify(makeTranscript())}::jsonb)
  `;
  for (const a of ATTACHMENTS) {
    await sql`
      insert into agent_transcript_attachments
        (agent_session_id, line_index, raw_jsonl_type, attachment_type, content, timestamp)
      values (
        ${CONVERSATION_ID}, ${a.lineIndex}, 'attachment', 'task_reminder',
        ${JSON.stringify({ label: a.label })}::jsonb, ${a.ts}::timestamptz
      )
    `;
  }

  // SC5's larger conversation — see BIG_CONVERSATION_ID's docblock for why it
  // is separate rather than a bigger version of the one above.
  await sql`
    insert into agent_transcripts (agent_session_id, harness, transcript)
    values (${BIG_CONVERSATION_ID}, 'claude_code', ${JSON.stringify(makeTranscript(BIG_TOTAL_TURNS, 20))}::jsonb)
  `;

  process.stdout.write(
    `[snapshot-window/testcontainer] seeded ${TOTAL_TURNS} turns + ${ATTACHMENTS.length} attachments, ` +
      `plus a ${BIG_TOTAL_TURNS}-turn conversation for SC5\n`
  );

  try {
    describe("snapshot window SQL [testcontainer, real Postgres]", () => {
      afterAll(async () => {
        process.stdout.write(`[snapshot-window/testcontainer] stopping container\n`);
        await sql.end().catch(() => {});
        await container.stop();
      });

      test("SC1: attachments straddling the window boundary are included by the timestamp bound, not by index", async () => {
        const page1 = requireSnapshot(
          await assembleSessionContextSnapshot(db as never, CONVERSATION_ID as AgentSessionId, {
            limit: PAGE,
          })
        );

        const labels = attachmentLabels(page1);
        // `>=` the oldest sliced turn, and OPEN above on the newest page.
        expect(labels).toEqual(["after-last-turn", "inside", "on-lower-edge"]);
        // One minute below the edge is out; far below is out.
        expect(labels).not.toContain("below-edge");
        expect(labels).not.toContain("far-below");
      });

      test("SC4: paging back applies an UPPER bound, so a second page re-delivers no attachment from the first", async () => {
        const page1 = requireSnapshot(
          await assembleSessionContextSnapshot(db as never, CONVERSATION_ID as AgentSessionId, {
            limit: PAGE,
          })
        );
        expect(page1.window?.nextBefore).toBe(PAGE1_LO);

        const page2 = requireSnapshot(
          await assembleSessionContextSnapshot(db as never, CONVERSATION_ID as AgentSessionId, {
            limit: PAGE,
            before: requireNextBefore(page1),
          })
        );

        const first = attachmentLabels(page1);
        const second = attachmentLabels(page2);

        // Page 2 covers minutes 80..99, so it carries the one below page 1's edge.
        expect(second).toEqual(["below-edge"]);
        // The property that regressed before the two-sided bound shipped: with an
        // open-ended upper bound page 2 would re-send everything page 1 had.
        expect(second.filter((l) => first.includes(l))).toEqual([]);
      });

      test("SC3: block ids and turn indices are ORIGINAL transcript positions, not re-based to the window", async () => {
        const windowed = requireSnapshot(
          await assembleSessionContextSnapshot(db as never, CONVERSATION_ID as AgentSessionId, {
            limit: PAGE,
          })
        );
        const full = requireSnapshot(
          await assembleSessionContextSnapshot(db as never, CONVERSATION_ID as AgentSessionId)
        );

        const windowedTurns = windowed.blocks.filter(
          (b): b is typeof b & { turnIndex: number } => typeof b.turnIndex === "number"
        );
        const fullById = new Map(full.blocks.map((b) => [b.id, b] as const));

        // Every windowed turn id exists byte-identically in the unwindowed snapshot.
        for (const b of windowedTurns) {
          const match = fullById.get(b.id);
          expect(match).toBeDefined();
          expect(match?.turnIndex).toBe(b.turnIndex);
        }
        // And the indices are 100..119 — re-basing would make them 0..19.
        const indices = windowedTurns.map((b) => b.turnIndex).sort((x, y) => x - y);
        expect(indices[0]).toBe(PAGE1_LO);
        expect(indices[indices.length - 1]).toBe(TOTAL_TURNS - 1);
      });

      test("SC2: the windowed payload stays under an explicit byte ceiling that the unwindowed one blows through", async () => {
        // The ceiling is the criterion. The unwindowed assertion beneath it is
        // the negative control in-line: it is the same payload with the window
        // removed, and it must FAIL the ceiling — otherwise the ceiling proves
        // nothing about the window.
        const CEILING_BYTES = 150 * 1024;

        const windowed = await assembleSessionContextSnapshot(
          db as never,
          CONVERSATION_ID as AgentSessionId,
          { limit: PAGE }
        );
        const full = await assembleSessionContextSnapshot(
          db as never,
          CONVERSATION_ID as AgentSessionId
        );

        const windowedBytes = JSON.stringify(windowed).length;
        const fullBytes = JSON.stringify(full).length;

        process.stdout.write(
          `[snapshot-window/testcontainer] SC2 windowed=${windowedBytes}B full=${fullBytes}B ceiling=${CEILING_BYTES}B\n`
        );

        expect(windowedBytes).toBeLessThan(CEILING_BYTES);
        expect(fullBytes).toBeGreaterThan(CEILING_BYTES);
      });

      test("SC5: EXPLAIN (ANALYZE, SERIALIZE) shows the windowed query serializing at least 10x fewer bytes", async () => {
        // These two statements are the payload-producing SHAPES the route's
        // windowed and unwindowed paths use. They are written here rather than
        // imported because the production query is built inline with drizzle's
        // `sql` template inside a non-exported function; extracting it would
        // mean widening that module's API purely for a test. The drift risk is
        // real and bounded: if the slice mechanism changes, SC1/SC3/SC4 above
        // fail against the REAL code path, so this measurement cannot silently
        // drift into measuring nothing.
        const fullPlan = await sql`
          explain (analyze, serialize, format text)
          select transcript from agent_transcripts where agent_session_id = ${BIG_CONVERSATION_ID}
        `;
        const windowedPlan = await sql`
          explain (analyze, serialize, format text)
          select jsonb_path_query_array(
            transcript,
            ('$[' || ${BIG_LO}::int || ' to ' || ${BIG_TOTAL_TURNS - 1}::int || ']')::jsonpath
          )
          from agent_transcripts where agent_session_id = ${BIG_CONVERSATION_ID}
        `;

        const fullText = fullPlan.map((r) => Object.values(r)[0]).join("\n");
        const windowedText = windowedPlan.map((r) => Object.values(r)[0]).join("\n");

        const fullOut = parseSerializeOutputBytes(fullText);
        const windowedOut = parseSerializeOutputBytes(windowedText);

        process.stdout.write(
          `[snapshot-window/testcontainer] SC5 EXPLAIN output= full=${fullOut}B windowed=${windowedOut}B ` +
            `ratio=${(fullOut / windowedOut).toFixed(1)}x\n`
        );

        expect(windowedOut * 10).toBeLessThanOrEqual(fullOut);
      });
    });
  } catch (err) {
    process.stdout.write(
      `[snapshot-window/testcontainer] suite registration failed; stopping container: ${err instanceof Error ? err.message : String(err)}\n`
    );
    await sql.end().catch(() => {});
    await container.stop().catch(() => {});
    throw err;
  }
} else {
  const missing: string[] = [];
  if (!process.env.RUN_INTEGRATION_TESTS) missing.push("RUN_INTEGRATION_TESTS=1");
  if (!process.env.RUN_TESTCONTAINER_TESTS) missing.push("RUN_TESTCONTAINER_TESTS=1");
  process.stdout.write(
    `[snapshot-window/testcontainer] integration tests skipped — set ${missing.join(", ")} to run\n`
  );
}
