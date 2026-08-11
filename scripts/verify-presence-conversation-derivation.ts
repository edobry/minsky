#!/usr/bin/env bun
/**
 * Live probe for mt#3945: `presence_claims.cc_conversation_id` is derived from
 * `actor_id`, so the two cannot disagree.
 *
 * This is the acceptance test the task's AT5 names, made runnable and
 * repeatable. It is a PROD-DATA check by necessity — the defect it guards was
 * invisible to every unit test because the write path genuinely offered the
 * column a value on every call; only the stored rows show that the value was
 * null (task rows: 0 of 6076) or stale (session rows, frozen at process spawn).
 * See mem#931: a call-site read is a derived view of what a column contains.
 *
 * Two arms, split at a cutover instant (`--since`, or `MT3945_CUTOVER`), on
 * **`last_refreshed_at`** — the instant the checked value was last WRITTEN.
 * Not `claimed_at`: `upsertClaim` deliberately preserves the original claim
 * time across refreshes while rewriting `cc_conversation_id`, so a row first
 * claimed days ago and refreshed by the fixed code carries a post-fix value
 * under a pre-fix `claimed_at`. Splitting on the wrong column put four
 * correctly-derived rows in BEFORE and left AFTER with nothing to compare,
 * which made the probe SKIP at the exact moment it had evidence to report
 * (mt#3970, measured against the mt#3945 merge instant).
 *
 *   AFTER  — rows written by the fixed code. Every conversation-scoped
 *     `actor_id` MUST carry the matching `cc_conversation_id`. A mismatch or a
 *     null here is a real failure: it means the derivation is not reaching the
 *     write path in production.
 *   BEFORE — rows written by the old code. Reported for context only, never
 *     failed on. They are deliberately left as-is rather than backfilled (SC6);
 *     re-deriving them would write today's semantics onto rows whose
 *     `actor_id` was itself spawn-frozen pre-mt#3900, mixing two meanings in
 *     one column with no way to tell them apart afterwards.
 *
 * Layer-1 (`unknown:hash:`) rows are counted, never failed on: `actor_id` names
 * no conversation there, so whatever the column holds came from the ambient env
 * fallback and there is nothing to check it against.
 *
 * Read-only: issues SELECTs and nothing else.
 *
 * Exit codes: 0 = pass (or SKIP when no DB is configured), 1 = fail.
 *
 * Usage: bun scripts/verify-presence-conversation-derivation.ts [--since <ISO-8601>]
 */
// tsyringe reflect polyfill. MUST be static and first — the domain imports
// below reach tsyringe-decorated code, and without it the first decorator
// throws before any of this script's own output runs (mt#3178).
import "reflect-metadata";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { conversationIdFromAgentId } from "@minsky/domain/agent-identity/format";

interface SqlCapablePersistence {
  getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
}

const isSqlCapablePersistence = (p: unknown): p is SqlCapablePersistence =>
  !!p &&
  !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
  typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

/**
 * Canonical CLI DB bootstrap, mirroring `verify-derived-conversation-link.ts`.
 * A bare connection getter returns null outside the server process, and
 * reporting that as "SKIP: no DB configured" would report a broken probe as an
 * absent environment (mt#3178).
 */
async function connect(): Promise<PostgresJsDatabase | null> {
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

  return persistence.getDatabaseConnection();
}

/**
 * A SKIP is an ABSENCE of verification, not a pass. Default 0 so an unattended
 * run on a machine with no DB is safe (the `scripts/verify-*.ts` convention);
 * set `MINSKY_REQUIRE_PRESENCE_DERIVATION_PROBE=1` to make it fail loudly.
 */
function skip(reason: string): number {
  const code = process.env.MINSKY_REQUIRE_PRESENCE_DERIVATION_PROBE === "1" ? 2 : 0;
  console.log(`SKIP: ${reason}`);
  if (code !== 0) {
    console.error(
      "SKIP treated as failure: MINSKY_REQUIRE_PRESENCE_DERIVATION_PROBE=1 demanded a real verification."
    );
  }
  return code;
}

function resolveCutover(): string | null {
  const flagIndex = process.argv.indexOf("--since");
  const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
  const raw = fromFlag ?? process.env.MT3945_CUTOVER;
  if (!raw) return null;
  if (Number.isNaN(Date.parse(raw))) {
    throw new Error(`--since is not a parseable instant: ${raw}`);
  }
  return new Date(raw).toISOString();
}

interface ArmCounts {
  arm: string;
  subject_kind: string;
  conv_scoped: number;
  agrees: number;
  disagrees: number;
  missing: number;
  layer1: number;
}

async function main(): Promise<number> {
  const cutover = resolveCutover();
  const db = await connect();
  if (!db) return skip("no SQL-capable Postgres connection in this environment");

  // Classification happens in TypeScript, through the SAME
  // `conversationIdFromAgentId` the write path uses — NOT in SQL. A
  // `LIKE '%:conv:%'` predicate cannot do this job: the agentId format allows a
  // trailing `@{parent-agentId}` delegation chain, so a task-scoped actor
  // delegating from a conversation matches the pattern on its PARENT and gets
  // counted as conversation-scoped, and the same pattern can register a false
  // agreement against the parent's uuid. The `conv:<parent>/task:<sub>`
  // subagent form is a second case SQL string-matching gets wrong. Deriving the
  // probe's own classification from the production parser also means the two
  // cannot drift: if the parser's carve-outs change, this follows.
  const raw = await db.execute(sql`
    select subject_kind, actor_id, cc_conversation_id, last_refreshed_at
    from presence_claims
  `);

  const buckets = new Map<string, ArmCounts>();
  for (const r of raw) {
    // `last_refreshed_at`, NOT `claimed_at` — see the module doc comment: the
    // upsert rewrites the value while preserving the original claim time, so
    // only this column dates the thing being checked.
    const valueWrittenAt =
      r.last_refreshed_at instanceof Date
        ? r.last_refreshed_at
        : new Date(String(r.last_refreshed_at));
    const arm = !cutover ? "ALL" : valueWrittenAt >= new Date(cutover) ? "AFTER" : "BEFORE";
    const subjectKind = String(r.subject_kind);

    // `arm` is one of ALL/AFTER/BEFORE, so the separator cannot collide.
    const key = `${arm}|${subjectKind}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        arm,
        subject_kind: subjectKind,
        conv_scoped: 0,
        agrees: 0,
        disagrees: 0,
        missing: 0,
        layer1: 0,
      };
      buckets.set(key, bucket);
    }

    const expected = conversationIdFromAgentId(typeof r.actor_id === "string" ? r.actor_id : null);
    if (expected === null) {
      bucket.layer1 += 1;
      continue;
    }

    bucket.conv_scoped += 1;
    const stored = typeof r.cc_conversation_id === "string" ? r.cc_conversation_id : null;
    if (stored === null) bucket.missing += 1;
    else if (stored === expected) bucket.agrees += 1;
    else bucket.disagrees += 1;
  }

  const rows = Array.from(buckets.values()).sort(
    (a, b) => a.arm.localeCompare(b.arm) || a.subject_kind.localeCompare(b.subject_kind)
  );

  if (rows.length === 0) return skip("presence_claims is empty — nothing to verify");

  console.log(
    cutover
      ? `Cutover: ${cutover} (arms split on last_refreshed_at — when the value was written)`
      : "Cutover: none given — reporting all rows as ALL"
  );
  console.table(rows);

  const checked = rows.filter((r) => r.arm === "AFTER" || r.arm === "ALL");
  if (checked.length === 0) {
    return skip(`no rows written at or after the cutover ${cutover} yet`);
  }

  const failures = checked.filter((r) => r.disagrees > 0 || r.missing > 0);
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(
        `FAIL ${f.arm}/${f.subject_kind}: ${f.disagrees} disagree, ${f.missing} conversation-scoped rows carry no cc_conversation_id`
      );
    }
    return 1;
  }

  const totalConv = checked.reduce((n, r) => n + r.conv_scoped, 0);
  if (totalConv === 0) {
    return skip("no conversation-scoped rows in the checked window — nothing to compare");
  }

  console.log(`PASS: ${totalConv} conversation-scoped rows, 0 disagreements, 0 missing`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
