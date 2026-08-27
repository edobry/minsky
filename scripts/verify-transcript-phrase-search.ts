#!/usr/bin/env bun
/**
 * Live verification for mt#3713 — phrase/literal matching + snippets on
 * `TranscriptFtsService.searchText()`.
 *
 * This is the acceptance-test vehicle for the task, and it runs against a REAL
 * Postgres on purpose. The service's unit suite drives a fake DB (a stubbed
 * `.select()` chain), which can verify how a query is ASSEMBLED but cannot
 * evaluate what Postgres does with it — whether `websearch_to_tsquery` actually
 * enforces adjacency, whether an unescaped `_` silently behaves as a wildcard,
 * whether the GIN prefilter changes which rows come back. Those are precisely
 * the claims this change rests on, so they are checked here against the engine
 * that decides them.
 *
 * Seeds a uniquely-named conversation, asserts, and removes it in a `finally`
 * so a failed run does not leave rows behind.
 *
 * Usage:
 *   bun scripts/verify-transcript-phrase-search.ts
 *
 * Exits 0 on pass (and on SKIP when no Postgres is reachable), non-zero on any
 * failed assertion. Prints a structured JSON report as its last line.
 */

import "reflect-metadata";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

// ── Seed vocabulary ───────────────────────────────────────────────────────────

/**
 * Nonsense tokens, so an assertion can never be satisfied by a real transcript
 * that happens to discuss the same subject as the fixture.
 */
const A = "zorbit";
const B = "fleeglaxon";
const C = "quibnar";

/** Carries an underscore, to prove it is escaped rather than treated as a LIKE wildcard. */
const LITERAL_ID = "MINSKY_ZORBIT_FLAG";

/**
 * Differs from the query `zorbit_flag` at exactly the underscore position — and
 * differs by a SPACE specifically, which is what makes the escaping assertion
 * able to fail.
 *
 * Two earlier drafts of this decoy were vacuous, each caught by running the
 * negative control (disable `escapeLikeLiteral`, expect AT4b to go red):
 *
 *  1. Seeded beside `MINSKY_ZORBIT_FLAG`, whose text literally contains
 *     `zorbit_flag` — so the query matched that conversation via the real
 *     substring, escaped or not.
 *  2. Seeded as `zorbitXflag` in isolation. `zorbitXflag` is a SINGLE lexeme,
 *     so the `'zorbit' <-> 'flag'` tsquery PREFILTER already excluded it and
 *     the ILIKE never ran. AT4b passed with escaping disabled.
 *
 * `zorbit flag` fixes both: it tokenizes to two adjacent lexemes, so the
 * prefilter ADMITS it and the ILIKE is genuinely the deciding condition. An
 * unescaped `_` matches the space; an escaped one does not.
 */
const WILDCARD_DECOY = "zorbit flag";

/** Long filler, so the snippet check runs against a turn a snippet can shorten. */
const FILLER_SENTENCE =
  "This sentence is padding that exists only to make the turn long enough that a bounded snippet is meaningfully smaller than the full text. ";

const RUN_TAG = "mt3713-verify";
const SESSION_PHRASE = `${RUN_TAG}-phrase`;
const SESSION_SCATTERED = `${RUN_TAG}-scattered`;
const SESSION_LITERAL = `${RUN_TAG}-literal`;
const SESSION_DECOY = `${RUN_TAG}-decoy`;
const SESSION_LONG = `${RUN_TAG}-long`;
const SESSION_OTHER_PROJECT = `${RUN_TAG}-other-project`;
const ALL_SESSIONS = [
  SESSION_PHRASE,
  SESSION_SCATTERED,
  SESSION_LITERAL,
  SESSION_DECOY,
  SESSION_LONG,
  SESSION_OTHER_PROJECT,
];

/** Slug of the throwaway project row used by the scoping check. */
const FIXTURE_PROJECT_SLUG = `${RUN_TAG}-project`;

// ── Result accounting ─────────────────────────────────────────────────────────

interface CheckResult {
  id: string;
  description: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

const results: CheckResult[] = [];

function check(id: string, description: string, condition: boolean, detail: string): void {
  results.push({ id, description, status: condition ? "pass" : "fail", detail });
  const mark = condition ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${id}: ${description}`);
  if (!condition) console.log(`         ${detail}`);
}

function skip(id: string, description: string, detail: string): void {
  results.push({ id, description, status: "skip", detail });
  console.log(`  [SKIP] ${id}: ${description} — ${detail}`);
}

/**
 * Read one text column out of a raw `db.execute` result.
 *
 * Drizzle types `execute` loosely, and this script only ever reads
 * `::text`-cast scalars out of it. Narrowing once here — with a runtime shape
 * check rather than an assertion — keeps the row-shape handling in one place.
 */
function readTextColumn(result: unknown, column: string): string[] {
  if (!Array.isArray(result)) return [];
  return result
    .map((row) =>
      row !== null && typeof row === "object" ? (row as Record<string, unknown>)[column] : undefined
    )
    .filter((value): value is string => typeof value === "string");
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrapDb(): Promise<PostgresJsDatabase | null> {
  try {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "@minsky/domain/configuration"
    );
    const { createCliContainer } = await import("../src/composition/cli");

    await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

    const container = await createCliContainer();
    await container.initialize();

    const persistence = container.has("persistence") ? container.get("persistence") : undefined;
    const isSqlCapable = (
      p: unknown
    ): p is { getDatabaseConnection: () => Promise<PostgresJsDatabase | null> } =>
      !!p &&
      !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
      typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

    if (!isSqlCapable(persistence)) return null;
    return await persistence.getDatabaseConnection();
  } catch (err) {
    console.log(`SKIP: could not reach Postgres — ${getLoggableErrorSummary(err)}`);
    return null;
  }
}

// ── Fixture ───────────────────────────────────────────────────────────────────

async function removeFixture(db: PostgresJsDatabase): Promise<void> {
  const ids = sql.join(
    ALL_SESSIONS.map((id) => sql`${id}`),
    sql`, `
  );
  await db.execute(sql`DELETE FROM agent_transcript_turns WHERE agent_session_id IN (${ids})`);
  await db.execute(sql`DELETE FROM agent_transcripts WHERE agent_session_id IN (${ids})`);
  // Ordered after the transcripts delete — project_id is an FK from them.
  await db.execute(sql`DELETE FROM projects WHERE slug = ${FIXTURE_PROJECT_SLUG}`);
}

/**
 * Ensure a SECOND project exists, so the scoping check has two scopes to tell
 * apart, and report whether this run created it.
 *
 * A database with a single project (the common local case) cannot exercise
 * scoping at all — an unscoped and a scoped search return the same rows, and
 * the check would pass without testing anything. The row is removed by
 * `removeFixture` in the `finally`.
 */
async function ensureSecondProject(
  db: PostgresJsDatabase,
  existingProjectId: string | null
): Promise<string | null> {
  if (!existingProjectId) return null;

  const inserted = await db.execute(sql`
    INSERT INTO projects (slug, display_name)
    VALUES (${FIXTURE_PROJECT_SLUG}, 'mt#3713 verification fixture')
    ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING id::text AS id
  `);

  return readTextColumn(inserted, "id")[0] ?? null;
}

/**
 * Insert the fixture rows.
 *
 * Deliberately does NOT clean up first — the caller does that before creating
 * the fixture project, because `removeFixture` drops that project row and any
 * conversation seeded against it would then violate the FK.
 */
async function seedFixture(
  db: PostgresJsDatabase,
  projectId: string | null,
  otherProjectId: string | null
): Promise<void> {
  const insertConversation = async (id: string, project: string | null): Promise<void> => {
    await db.execute(sql`
      INSERT INTO agent_transcripts (agent_session_id, harness, started_at, cwd, project_id)
      VALUES (${id}, 'claude_code', now(), '/tmp/mt3713', ${project}::uuid)
    `);
  };

  const insertTurn = async (
    id: string,
    turnIndex: number,
    userText: string | null,
    assistantText: string | null,
    startedAt: string
  ): Promise<void> => {
    await db.execute(sql`
      INSERT INTO agent_transcript_turns
        (agent_session_id, turn_index, user_text, assistant_text, started_at)
      VALUES (${id}, ${turnIndex}, ${userText}, ${assistantText}, ${startedAt}::timestamptz)
    `);
  };

  // The three tokens ADJACENT, as a phrase.
  await insertConversation(SESSION_PHRASE, projectId);
  await insertTurn(
    SESSION_PHRASE,
    0,
    `Investigating the ${A} ${B} ${C} interaction today.`,
    `Confirmed: the ${A} ${B} ${C} path is the one that matters.`,
    "2026-01-01T00:00:00Z"
  );

  // The same three tokens, SCATTERED across separate sentences.
  await insertConversation(SESSION_SCATTERED, projectId);
  await insertTurn(
    SESSION_SCATTERED,
    0,
    `First we saw ${A} in the logs. Much later a ${B} appeared. Eventually ${C} showed up too.`,
    `None of ${A}, ${B}, or ${C} were adjacent in this turn.`,
    "2026-01-02T00:00:00Z"
  );

  // Literal-matching fixture: the underscore-bearing identifier.
  await insertConversation(SESSION_LITERAL, projectId);
  await insertTurn(
    SESSION_LITERAL,
    0,
    `Set ${LITERAL_ID}=1 before running it.`,
    `Acknowledged — ${LITERAL_ID} is now set.`,
    "2026-01-03T00:00:00Z"
  );
  // A second, more recent turn so `exact` ordering is observable.
  await insertTurn(
    SESSION_LITERAL,
    1,
    `Reminder about ${LITERAL_ID} again.`,
    `Still ${LITERAL_ID}.`,
    "2026-01-04T00:00:00Z"
  );

  // The wildcard decoy, ISOLATED — no underscore anywhere in this conversation,
  // so a `zorbit_flag` query can only reach it if `_` acted as a wildcard.
  await insertConversation(SESSION_DECOY, projectId);
  await insertTurn(
    SESSION_DECOY,
    0,
    `An isolated token: ${WILDCARD_DECOY} and nothing else of note.`,
    `Echoing ${WILDCARD_DECOY} back.`,
    "2026-01-06T00:00:00Z"
  );

  // A long turn with the phrase buried mid-text, so a snippet has something to
  // shorten. A real transcript turn runs to tens of kilobytes; this is the
  // property that makes snippets worth having.
  await insertConversation(SESSION_LONG, projectId);
  await insertTurn(
    SESSION_LONG,
    0,
    `${FILLER_SENTENCE.repeat(12)}Buried here: ${A} ${B} ${C}. ${FILLER_SENTENCE.repeat(12)}`,
    FILLER_SENTENCE.repeat(20),
    "2026-01-07T00:00:00Z"
  );

  // Same phrase, different project — for the scoping check.
  if (otherProjectId) {
    await insertConversation(SESSION_OTHER_PROJECT, otherProjectId);
    await insertTurn(
      SESSION_OTHER_PROJECT,
      0,
      `Another project also mentions ${A} ${B} ${C} verbatim.`,
      null,
      "2026-01-05T00:00:00Z"
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const db = await bootstrapDb();
if (!db) {
  console.log("SKIP: no SQL-capable persistence provider configured.");
  process.exit(0);
}

const { TranscriptFtsService } = await import("@minsky/domain/transcripts/transcript-fts-service");

const projectRows = await db.execute(
  sql`SELECT id::text AS id FROM projects WHERE slug <> ${FIXTURE_PROJECT_SLUG} ORDER BY id LIMIT 1`
);
const projectId = readTextColumn(projectRows, "id")[0] ?? null;

let exitCode = 0;
let otherProjectId: string | null = null;

try {
  // Clear any residue from a previous run BEFORE creating the fixture project,
  // since removeFixture drops that project row.
  await removeFixture(db);
  otherProjectId = await ensureSecondProject(db, projectId);
  await seedFixture(db, projectId, otherProjectId);
  const svc = new TranscriptFtsService(db);

  const idsOf = (rows: Array<{ agentSessionId: string }>): string[] =>
    rows.map((r) => r.agentSessionId);
  const seededOnly = (rows: Array<{ agentSessionId: string }>): string[] =>
    idsOf(rows).filter((id) => id.startsWith(RUN_TAG));

  console.log("\n== AT1: quoted phrase matches adjacency only; plain matches both ==");

  const quoted = await svc.searchText(`"${A} ${B} ${C}"`, { limit: 50, mode: "websearch" });
  const quotedIds = seededOnly(quoted);
  check(
    "AT1a",
    "websearch with a quoted phrase returns the contiguous turn",
    quotedIds.includes(SESSION_PHRASE),
    `got: ${JSON.stringify(quotedIds)}`
  );
  check(
    "AT1b",
    "websearch with a quoted phrase EXCLUDES the scattered turn",
    !quotedIds.includes(SESSION_SCATTERED),
    `got: ${JSON.stringify(quotedIds)}`
  );

  const unquoted = await svc.searchText(`${A} ${B} ${C}`, { limit: 50, mode: "plain" });
  const unquotedIds = seededOnly(unquoted);
  check(
    "AT1c",
    "plain with the same words unquoted returns BOTH turns",
    unquotedIds.includes(SESSION_PHRASE) && unquotedIds.includes(SESSION_SCATTERED),
    `got: ${JSON.stringify(unquotedIds)}`
  );

  console.log("\n== AT2: websearch vs plain on a no-operator query (SC#2, falsified) ==");

  const parsed = await db.execute(sql`
    SELECT plainto_tsquery('english', ${LITERAL_ID})::text AS plain,
           websearch_to_tsquery('english', ${LITERAL_ID})::text AS websearch
  `);
  const plainParse = readTextColumn(parsed, "plain")[0] ?? "";
  const webParse = readTextColumn(parsed, "websearch")[0] ?? "";
  check(
    "AT2",
    "a punctuation-joined identifier parses to a PHRASE under websearch but an AND under plain",
    plainParse.includes("&") && webParse.includes("<->"),
    `plainto=${plainParse} websearch=${webParse}`
  );

  console.log("\n== AT3/AT4: exact literal matching ==");

  const exactHits = await svc.searchText(LITERAL_ID, { limit: 50, mode: "exact" });
  const exactIds = seededOnly(exactHits);
  check(
    "AT3",
    "exact finds the underscore-bearing identifier",
    exactIds.includes(SESSION_LITERAL),
    `got: ${JSON.stringify(exactIds)}`
  );

  const mixedCase = await svc.searchText(LITERAL_ID.toLowerCase(), { limit: 50, mode: "exact" });
  check(
    "AT4a",
    "exact matches case-insensitively",
    seededOnly(mixedCase).includes(SESSION_LITERAL),
    `searched ${LITERAL_ID.toLowerCase()}, got: ${JSON.stringify(seededOnly(mixedCase))}`
  );

  // Negative control for LIKE-metacharacter escaping: `zorbit_flag` must NOT
  // reach the isolated `zorbitXflag` conversation. Without ESCAPE handling, `_`
  // is a single-character wildcard and this check fails.
  const wildcardProbe = await svc.searchText("zorbit_flag", { limit: 50, mode: "exact" });
  check(
    "AT4b",
    "an underscore in an exact query is escaped, not treated as a wildcard",
    !seededOnly(wildcardProbe).includes(SESSION_DECOY),
    `searched zorbit_flag against isolated ${WILDCARD_DECOY}; got: ${JSON.stringify(seededOnly(wildcardProbe))}`
  );

  console.log("\n== AT5: snippets ==");

  const snippetProbe = await svc.searchText(`"${A} ${B}"`, { limit: 10, mode: "websearch" });
  const withSnippets = snippetProbe.filter((r) => (r.snippet ?? "") !== "");
  check(
    "AT5a",
    "every websearch result carries a non-empty snippet",
    snippetProbe.length > 0 && withSnippets.length === snippetProbe.length,
    `${withSnippets.length}/${snippetProbe.length} had snippets`
  );

  // Asserted against the LONG turn: a snippet can only shorten a turn that
  // exceeds the snippet budget, and shortening long turns is the entire point
  // (search results used to return turn bodies tens of kilobytes wide).
  const longHit = snippetProbe.find((r) => r.agentSessionId === SESSION_LONG);
  const longFullLength = ((longHit?.userText ?? "") + (longHit?.assistantText ?? "")).length;
  const longSnippetLength = (longHit?.snippet ?? "").length;
  check(
    "AT5b",
    "the snippet marks the matched term and is far shorter than a long turn",
    !!longHit &&
      (longHit.snippet ?? "").includes(`[${A}]`) &&
      longSnippetLength < longFullLength / 4,
    `snippet ${longSnippetLength} chars vs full turn ${longFullLength} chars; snippet=${JSON.stringify(longHit?.snippet)}`
  );

  const exactSnippet = exactHits.find((r) => r.agentSessionId === SESSION_LITERAL);
  check(
    "AT5c",
    "an exact-mode result carries a snippet delimiting the literal",
    !!exactSnippet && (exactSnippet.snippet ?? "").includes(`[${LITERAL_ID}]`),
    `snippet=${JSON.stringify(exactSnippet?.snippet)}`
  );

  console.log("\n== AT6: exact ordering is recency, not relevance ==");

  const seededExact = exactHits.filter((r) => r.agentSessionId === SESSION_LITERAL);
  const times = seededExact.map((r) => r.startedAt?.getTime() ?? 0);
  const descending = times.every((time, i) => {
    const previous = times[i - 1];
    return i === 0 || (previous !== undefined && previous >= time);
  });
  check(
    "AT6",
    "exact results are ordered by started_at descending",
    seededExact.length >= 2 && descending,
    `turn order: ${JSON.stringify(seededExact.map((r) => r.turnIndex))}, times: ${JSON.stringify(times)}`
  );

  console.log("\n== AT7: project scoping ==");

  if (!projectId || !otherProjectId) {
    skip("AT7", "project scoping", "no project rows exist in this database to scope against");
  } else {
    const scoped = await svc.searchText(`"${A} ${B} ${C}"`, {
      limit: 50,
      mode: "websearch",
      projectId,
    });
    const scopedIds = seededOnly(scoped);
    check(
      "AT7a",
      "a projectId-scoped search excludes the other project's turn",
      scopedIds.includes(SESSION_PHRASE) && !scopedIds.includes(SESSION_OTHER_PROJECT),
      `got: ${JSON.stringify(scopedIds)}`
    );

    const unscoped = await svc.searchText(`"${A} ${B} ${C}"`, { limit: 50, mode: "websearch" });
    const unscopedIds = seededOnly(unscoped);
    check(
      "AT7b",
      "an unscoped search returns both projects' turns",
      unscopedIds.includes(SESSION_PHRASE) && unscopedIds.includes(SESSION_OTHER_PROJECT),
      `got: ${JSON.stringify(unscopedIds)}`
    );
  }
} catch (err) {
  console.error(`\nERROR: ${err instanceof Error ? err.stack : String(err)}`);
  exitCode = 1;
} finally {
  await removeFixture(db);
  console.log("\nfixture removed.");
}

const failed = results.filter((r) => r.status === "fail");
if (failed.length > 0) exitCode = 1;

console.log(
  `\n${JSON.stringify(
    {
      passed: results.filter((r) => r.status === "pass").length,
      failed: failed.length,
      skipped: results.filter((r) => r.status === "skip").length,
      results,
    },
    null,
    2
  )}`
);

process.exit(exitCode);
