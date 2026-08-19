#!/usr/bin/env bun
/**
 * Measure `asserted-not-self-resolving` against the real incident-ask corpus (mt#4315).
 *
 * ## Why this exists rather than a number in a docblock
 *
 * SC5 requires the phrase set be "measured against real incident asks rather than invented —
 * state the corpus and the fire rate". A pasted number answers that once and then rots: the
 * corpus grows every time an agent files a `severity: "incident"` ask, and a fire rate that was
 * 2-of-12 in August says nothing about the set six weeks later. This runs the ACTUAL exported
 * pattern against the ACTUAL corpus, so the claim can be re-derived instead of trusted.
 *
 * It is also the no-over-fire evidence. The two positives are partly circular — the pattern was
 * written from them — so what carries weight is the count of OTHER incident asks it stays silent
 * on, and that number is only meaningful when re-measured against whatever the corpus has become.
 *
 * ## What leaves this process, enumerated by channel
 *
 * Ask questions are read into memory and matched. They are NOT emitted on any channel:
 *
 * - **stdout/stderr** — short ids, ask kinds, booleans and counts only. When a fire is recorded,
 *   the MATCHED SUBSTRING is printed (a few words of the author's own vocabulary, e.g. "no sign
 *   of clearing"), because a fire you cannot see the trigger for is not reviewable. Never the
 *   surrounding question.
 * - **files** — none written.
 * - **network** — the database connection only. No third-party SDK is called; nothing here
 *   embeds, summarizes, or ships text anywhere.
 * - **subprocess argv** — no subprocess is spawned.
 *
 * ## Exit codes
 *
 * 0 — measured cleanly, and both pinned regression fixtures fire.
 * 1 — a pinned fixture stopped firing: the pattern regressed away from its own originating cases.
 * 0 with a SKIP line — persistence unavailable, so it is safe to run anywhere.
 *
 * Usage:
 *   bun scripts/verify-self-resolving-claim-check.ts
 */

// Must precede anything that can reach tsyringe (the persistence factory does).
import "reflect-metadata";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolvePersistenceProviderOrError } from "../packages/domain/src/persistence/factory";
import { NOT_SELF_RESOLVING_PATTERN } from "../packages/domain/src/ask/form-lint";

/**
 * The two asks that produced this check, pinned as literals.
 *
 * ask#9278's ORIGINAL question is not in the database — it was edited twice into a RESOLVED
 * notice on 2026-08-19, and `metadata.editHistory` keeps the field NAMES changed but not the
 * prior values. So the live corpus sweep below will correctly show ask#9278 NOT firing, and that
 * is a fact about the stored record rather than about the pattern. These fixtures are the
 * regression control the sweep cannot provide.
 */
const PINNED: readonly { id: string; note: string; text: string }[] = [
  {
    id: "ask#9278",
    note: "original question, recovered from the authoring transcript (the stored body is the RESOLVED rewrite)",
    text: "They block on `ClientRead`, so statement timeouts will not reap them; already held ~14 min with no sign of clearing.",
  },
  {
    id: "ask#9279",
    note: "stored question, still intact",
    text: "Wedged, not transient: count held at exactly 16 across ~5 minutes while ages advanced 576s->858s.",
  },
];

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

async function initializeConfig(): Promise<void> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
}

async function openDatabase(): Promise<PostgresJsDatabase> {
  const resolution = await resolvePersistenceProviderOrError();
  if (!resolution.ok) skip(`persistence unavailable (${JSON.stringify(resolution)})`);
  const provider = resolution.provider;
  if (!("getDatabaseConnection" in provider)) skip("provider has no database connection");
  const db = await (
    provider as { getDatabaseConnection(): Promise<unknown> }
  ).getDatabaseConnection();
  if (!db) skip("database connection unavailable");
  return db as PostgresJsDatabase;
}

/** The matched substring, or null. Printed so a fire is reviewable without the question. */
function matchedPhrase(question: string): string | null {
  const m = NOT_SELF_RESOLVING_PATTERN.exec(question);
  return m?.[0] ?? null;
}

async function main(): Promise<void> {
  await initializeConfig();
  const db = await openDatabase();

  // Validated at the boundary rather than asserted through it: a raw driver result is external
  // input, and a cast would let a schema change surface as an undefined field mid-loop.
  const rows = await db.execute(
    sql`select short_id, kind, created_at, question from asks where severity = 'incident' order by created_at`
  );

  interface Row {
    shortId: string;
    kind: string;
    createdAt: string;
    fired: boolean;
    phrase: string | null;
  }

  const measured: Row[] = [];
  for (const raw of rows as Iterable<Record<string, unknown>>) {
    const question = raw.question;
    const shortId = raw.short_id;
    if (typeof question !== "string" || typeof shortId !== "string") continue;
    const phrase = matchedPhrase(question);
    measured.push({
      shortId,
      kind: typeof raw.kind === "string" ? raw.kind : "unknown",
      createdAt: String(raw.created_at ?? ""),
      fired: phrase !== null,
      phrase,
    });
  }

  if (measured.length === 0) skip("no incident asks stored");

  console.log(`Corpus: ${measured.length} ask(s) with severity='incident'.\n`);
  for (const row of measured) {
    const verdict = row.fired ? `FIRES  (matched: "${row.phrase}")` : "silent";
    console.log(`  ${row.shortId.padEnd(10)} ${row.kind.padEnd(22)} ${verdict}`);
  }

  const fires = measured.filter((r) => r.fired);
  console.log(
    `\nFire rate: ${fires.length} of ${measured.length}${
      fires.length > 0 ? ` — ${fires.map((f) => f.shortId).join(", ")}` : ""
    }`
  );
  console.log(
    `Silent on ${measured.length - fires.length} — this is the no-over-fire evidence, and it is ` +
      `the half that is not circular.`
  );

  // Regression control: the pattern must still fire on the cases it was written from. A sweep
  // alone cannot check this, because one of those cases no longer exists in the database.
  console.log("\nPinned regression fixtures:");
  let regressed = 0;
  for (const fixture of PINNED) {
    const phrase = matchedPhrase(fixture.text);
    const ok = phrase !== null;
    if (!ok) regressed++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${fixture.id} — ${fixture.note}${
        ok ? ` (matched: "${phrase}")` : ""
      }`
    );
  }

  if (regressed > 0) {
    console.error(
      `\nFAIL: ${regressed} pinned fixture(s) no longer match — the pattern has drifted away ` +
        `from its own originating cases.`
    );
    process.exit(1);
  }
  console.log("\nPASS: both originating cases still fire; corpus measured above.");
}

await main();
