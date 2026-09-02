/**
 * Unit tests for the mt#4839 ask-project_id backfill.
 *
 * Two halves are pinned here. The pure guards (`checkScopeMatch`, `parseIntFlag`, the state
 * partition) decide whether the sweep is allowed to run at all — the thing standing between a
 * scoped correction and an unintended bulk mutation. The SQL-shaped half is exercised through an
 * INJECTED fake db rather than a patched module: `withBackfillLock` and `applyBackfill` both take
 * their connection as a parameter, so the safety-critical branches (lock refused; the UPDATE
 * re-asserting eligibility rather than trusting an id list) are observable without touching a
 * real Postgres. The live dry-run and bounded `--execute` runs are recorded in the PR body.
 */

import { describe, test, expect } from "bun:test";
import type { SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  checkScopeMatch,
  parseIntFlag,
  applyBackfill,
  withBackfillLock,
  MEASURED_BASELINE,
  SCOPE_DIVERGENCE_FACTOR,
  TERMINAL_ASK_STATES,
  TARGET_ASK_STATES,
  BACKFILL_ASK_PROJECT_LOCK_NAMESPACE,
} from "./backfill-ask-project-ids";
import type { SqlExecutor } from "./backfill-ask-project-ids";
import { ASK_STATE_VALUES } from "@minsky/domain/storage/schemas/ask-schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a drizzle `SQL` object to the statement Postgres would receive, with bound values as
 * `$n` placeholders. Asserting on that text is what lets these tests check that the UPDATE carries
 * its own eligibility clauses — the property that makes a mid-flight close or a peer write safe.
 *
 * Uses `PgDialect#sqlToQuery`, drizzle's public rendering API — the same entry point the driver
 * itself goes through (PR #3575 R1, NON-BLOCKING). An earlier revision walked the `queryChunks`
 * internals by hand, which read the right text today and would drift silently on a drizzle
 * upgrade; the point of these assertions is that they keep meaning what they say.
 */
const dialect = new PgDialect();

function sqlText(query: SQL): string {
  return dialect.sqlToQuery(query).sql.replace(/\s+/g, " ").trim();
}

interface FakeCall {
  query: SQL;
}

/** Read the Nth recorded call, failing loudly rather than asserting non-null on an empty list. */
function callAt(calls: FakeCall[], index: number): FakeCall {
  const call = calls[index];
  if (!call) throw new Error(`expected a SQL call at index ${index}, got ${calls.length} call(s)`);
  return call;
}

/** A db whose `execute` records the SQL it was handed and replays a scripted result. */
function fakeDb(options: {
  lockAcquired?: boolean;
  updateRows?: Record<string, unknown>[];
  calls?: FakeCall[];
}): PostgresJsDatabase & SqlExecutor {
  const calls = options.calls ?? [];
  const tx: SqlExecutor = {
    execute: (query: SQL) => {
      calls.push({ query });
      const text = sqlText(query);
      if (text.includes("pg_try_advisory_xact_lock")) {
        return Promise.resolve([{ acquired: options.lockAcquired ?? true }]);
      }
      return Promise.resolve(options.updateRows ?? []);
    },
  };
  return {
    ...tx,
    transaction: (fn: (t: SqlExecutor) => Promise<unknown>) => fn(tx),
  } as unknown as PostgresJsDatabase & SqlExecutor;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("checkScopeMatch", () => {
  test("passes at the recorded baseline", () => {
    expect(checkScopeMatch(MEASURED_BASELINE).ok).toBe(true);
  });

  test("treats 0 matched rows as the idempotent re-run, not a divergence", () => {
    const verdict = checkScopeMatch(0);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain("0 rows matched");
  });

  test("aborts when the matched count exceeds the baseline by more than the factor", () => {
    const verdict = checkScopeMatch(MEASURED_BASELINE * SCOPE_DIVERGENCE_FACTOR + 1);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("STOP");
  });

  test("aborts when the matched count falls far BELOW the baseline too", () => {
    // This population has only ever drifted downward (14 → 13 → 10) as asks reach a terminal
    // state, so under-matching is the LIKELY divergence here, not the exotic one.
    const verdict = checkScopeMatch(1, 100);
    expect(verdict.ok).toBe(false);
  });

  test("an operator-stated re-measured baseline re-confirms rather than skips the check", () => {
    expect(checkScopeMatch(4, 4).ok).toBe(true);
    expect(checkScopeMatch(50, 4).ok).toBe(false);
  });
});

describe("parseIntFlag", () => {
  test("returns null when the flag is absent", () => {
    expect(parseIntFlag(["--execute"], "--limit", 1)).toBeNull();
  });

  test("parses a well-formed value", () => {
    expect(parseIntFlag(["--limit", "3", "--execute"], "--limit", 1)).toBe(3);
  });

  test("throws on a malformed value rather than silently ignoring it", () => {
    // A typo'd `--limit` that quietly became "no limit" would turn a run intended to be bounded
    // into a full-population mutation — the failure this throw exists to prevent.
    expect(() => parseIntFlag(["--limit", "abc"], "--limit", 1)).toThrow();
    expect(() => parseIntFlag(["--limit"], "--limit", 1)).toThrow();
    expect(() => parseIntFlag(["--limit", "0"], "--limit", 1)).toThrow();
  });

  test("honours a per-flag minimum: --baseline 0 is legitimate", () => {
    expect(parseIntFlag(["--baseline", "0"], "--baseline", 0)).toBe(0);
  });
});

describe("the sweep's target states", () => {
  test("partition the enum: every state is either a target or explicitly terminal", () => {
    // Asserted against the schema's exported enum rather than a hand-copied list, so adding an
    // AskState member without deciding which side it falls on fails HERE — instead of silently
    // being swept (if it should have been terminal) or silently left behind (if it should not).
    const partition = [...TARGET_ASK_STATES, ...TERMINAL_ASK_STATES].sort();
    expect(partition).toEqual([...ASK_STATE_VALUES].sort());
  });

  test("the two halves are disjoint", () => {
    const targets = new Set<string>(TARGET_ASK_STATES);
    for (const terminal of TERMINAL_ASK_STATES) {
      expect(targets.has(terminal)).toBe(false);
    }
  });

  test("treats `expired` as terminal, per the AskState doc — diverging from the spec's query", () => {
    // mt#4839's Acceptance Tests say `state not in ('closed','cancelled')`; the domain type says
    // "Terminal states: closed, cancelled, expired". The domain wins — and this is load-bearing,
    // not pedantic: ask#10468 expired at 2026-09-02T18:10:40Z, mid-implementation, and the
    // spec's predicate would still stamp it. Recorded on the spec.
    expect([...TERMINAL_ASK_STATES]).toContain("expired");
    expect([...TARGET_ASK_STATES]).not.toContain("expired");
  });
});

// ---------------------------------------------------------------------------
// SQL shape
// ---------------------------------------------------------------------------

describe("applyBackfill", () => {
  test("issues nothing at all for an empty id list", async () => {
    const calls: FakeCall[] = [];
    const rows = await applyBackfill(fakeDb({ calls }), []);
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("re-asserts the full eligibility predicate on the UPDATE, not just the id list", async () => {
    // The property that makes a mid-flight close, a peer stamp, or a reparent safe. An id-only
    // UPDATE would pass every other test in this file and clobber all three.
    const calls: FakeCall[] = [];
    await applyBackfill(fakeDb({ calls }), ["11111111-1111-1111-1111-111111111111"]);
    expect(calls).toHaveLength(1);
    const text = sqlText(callAt(calls, 0).query);
    expect(text).toContain("a.project_id IS NULL");
    expect(text).toContain("t.project_id IS NOT NULL");
    expect(text).toContain("t.id = a.parent_task_id");
    expect(text).toContain("a.state NOT IN");
  });

  test("takes the stamped value from the JOINED task row, never from a pre-read id", async () => {
    // `SET project_id = t.project_id` resolves inside the statement, so a task reparented
    // between the SELECT and the UPDATE stamps the NEW project — or drops out of the predicate.
    const calls: FakeCall[] = [];
    await applyBackfill(fakeDb({ calls }), ["11111111-1111-1111-1111-111111111111"]);
    expect(sqlText(callAt(calls, 0).query)).toContain("SET project_id = t.project_id");
  });

  test("maps the RETURNING rows, so a partial apply is visible to the caller", async () => {
    const rows = await applyBackfill(
      fakeDb({
        updateRows: [{ id: "abc", short_id: "ask#1", project_id: "proj-1" }],
      }),
      ["abc", "def"]
    );
    expect(rows).toEqual([{ id: "abc", shortId: "ask#1", projectId: "proj-1" }]);
  });
});

describe("withBackfillLock", () => {
  test("runs the body when the transaction-scoped lock is acquired", async () => {
    const outcome = await withBackfillLock(fakeDb({ lockAcquired: true }), async () => "ran");
    expect(outcome).toEqual({ acquired: true, result: "ran" });
  });

  test("never runs the body when another process holds the lock", async () => {
    let ran = false;
    const outcome = await withBackfillLock(fakeDb({ lockAcquired: false }), async () => {
      ran = true;
      return "ran";
    });
    expect(outcome).toEqual({ acquired: false });
    expect(ran).toBe(false);
  });

  test("uses the XACT-scoped lock, not the session-scoped pair (mem#655)", async () => {
    // Session-level `pg_try_advisory_lock` LEAKS through this deployment's Supavisor transaction
    // pooler — the unlock lands on a different backend and the key stays held until that backend
    // is recycled, wedging every later run. Regressing to it would look correct and would be
    // invisible until the second run.
    const calls: FakeCall[] = [];
    await withBackfillLock(fakeDb({ calls }), async () => null);
    const text = sqlText(callAt(calls, 0).query);
    expect(text).toContain("pg_try_advisory_xact_lock");
    expect(text).not.toContain("pg_advisory_unlock");
    expect(String(BACKFILL_ASK_PROJECT_LOCK_NAMESPACE)).toBe("4839001");
  });
});
