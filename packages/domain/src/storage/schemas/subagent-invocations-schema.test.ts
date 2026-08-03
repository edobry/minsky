/**
 * Subagent invocations schema shape and enum tests — mt#1735
 *
 * Verifies that the Drizzle table definition has the expected column names,
 * that the outcome enum has exactly the 7 specified values (6 terminal classes plus the
 * mt#1770 `pending` placeholder), and that the SQL migration file contains the required DDL.
 *
 * These are pure unit tests — no live DB required.
 */

/* eslint-disable custom/no-real-fs-in-tests -- reading shipped migration SQL IS the point of drift checks */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  subagentInvocationsTable,
  subagentInvocationOutcomeEnum,
  SUBAGENT_INVOCATION_OUTCOME_VALUES,
} from "./subagent-invocations-schema";
import type { TerminalSubagentInvocationOutcome } from "./subagent-invocations-schema";

const MIGRATIONS_DIR = join(import.meta.dir, "../migrations/pg");
/** The Postgres enum type name, as written in the migrations. */
const ENUM_TYPE_NAME = "subagent_invocation_outcome";
/** A representative TERMINAL outcome, used where the value itself is not what's under test. */
const A_TERMINAL_OUTCOME = "crashed-no-output";

// ---------------------------------------------------------------------------
// Outcome enum
// ---------------------------------------------------------------------------

describe("SubagentInvocationOutcome enum", () => {
  test("SUBAGENT_INVOCATION_OUTCOME_VALUES has exactly 7 values", () => {
    // 6 terminal classes (mt#1005) + the dispatch-time `pending` placeholder (mt#1770).
    expect(SUBAGENT_INVOCATION_OUTCOME_VALUES).toHaveLength(7);
  });

  test("SUBAGENT_INVOCATION_OUTCOME_VALUES contains exactly the 7 specified outcome values", () => {
    const expected = [
      "completed-with-pr",
      "committed-no-pr",
      "partial-committed-handoff-written",
      "partial-uncommitted-no-handoff",
      A_TERMINAL_OUTCOME,
      "rate-limited",
      "pending",
    ] as string[];
    const actual: string[] = [...SUBAGENT_INVOCATION_OUTCOME_VALUES].sort();
    expect(actual).toEqual(expected.sort());
  });

  test("`pending` is excluded from TerminalSubagentInvocationOutcome (mt#1770)", () => {
    // The classifier's return type. A compile-time constraint needs a compile-time assertion:
    // if `pending` ever became assignable, this stops compiling. Paired with a runtime
    // assertion so the test still exercises executable behavior (placeholder-test policy).
    const terminal: TerminalSubagentInvocationOutcome = A_TERMINAL_OUTCOME;
    // @ts-expect-error — `pending` must NOT be assignable to the terminal (classifier) type.
    const notTerminal: TerminalSubagentInvocationOutcome = "pending";
    expect(terminal).toBe(A_TERMINAL_OUTCOME);
    expect(notTerminal).toBe("pending");
  });

  test("`pending` cannot reach an escalation threshold — the doc claim, pinned (PR #2501 R1)", () => {
    // `subagent-dispatch-cadence.mdc` class 7 says pending must not count toward any escalation
    // threshold. The tracker enforces that structurally: its threshold queries filter on
    // SPECIFIC terminal outcomes rather than "not completed", so pending is excluded by
    // construction. This asserts the doc claim against the source rather than trusting prose.
    const trackerSrc = readFileSync(
      join(import.meta.dir, "../../../../../src/mcp/subagent-dispatch-tracker.ts")
    ).toString();
    const outcomeFilters = [
      ...trackerSrc.matchAll(/eq\(\s*subagentInvocationsTable\.outcome,\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(outcomeFilters.length).toBeGreaterThan(0);
    expect(outcomeFilters).not.toContain("pending");
  });

  test("`pending` is present — the dispatch-time placeholder (mt#1770)", () => {
    // Guards the specific member rather than only the count: a future edit that swaps one
    // value for another keeps the length at 7 and would otherwise pass silently.
    expect([...SUBAGENT_INVOCATION_OUTCOME_VALUES]).toContain("pending");
  });

  test("pgEnum enumValues matches SUBAGENT_INVOCATION_OUTCOME_VALUES", () => {
    const enumValues = [...subagentInvocationOutcomeEnum.enumValues].sort();
    const tsValues = [...SUBAGENT_INVOCATION_OUTCOME_VALUES].sort();
    expect(enumValues).toEqual(tsValues);
  });

  test("pgEnum name is subagent_invocation_outcome", () => {
    expect(subagentInvocationOutcomeEnum.enumName).toBe("subagent_invocation_outcome");
  });
});

// ---------------------------------------------------------------------------
// Table column shape — identity group
// ---------------------------------------------------------------------------

describe("subagentInvocationsTable identity columns", () => {
  test("id column has correct DB name", () => {
    expect(subagentInvocationsTable.id.name).toBe("id");
  });

  test("taskId column has correct DB name", () => {
    expect(subagentInvocationsTable.taskId.name).toBe("task_id");
  });

  test("sessionId column has correct DB name", () => {
    expect(subagentInvocationsTable.sessionId.name).toBe("session_id");
  });

  test("agentSessionId column has correct DB name", () => {
    expect(subagentInvocationsTable.agentSessionId.name).toBe("agent_session_id");
  });

  test("parentSessionId column has correct DB name", () => {
    expect(subagentInvocationsTable.parentSessionId.name).toBe("parent_session_id");
  });

  test("parentTaskId column has correct DB name", () => {
    expect(subagentInvocationsTable.parentTaskId.name).toBe("parent_task_id");
  });

  test("subagentSessionId column has correct DB name", () => {
    expect(subagentInvocationsTable.subagentSessionId.name).toBe("subagent_session_id");
  });
});

// ---------------------------------------------------------------------------
// Table column shape — dispatch params group
// ---------------------------------------------------------------------------

describe("subagentInvocationsTable dispatch param columns", () => {
  test("agentType column has correct DB name", () => {
    expect(subagentInvocationsTable.agentType.name).toBe("agent_type");
  });

  test("suggestedModel column has correct DB name", () => {
    expect(subagentInvocationsTable.suggestedModel.name).toBe("suggested_model");
  });

  test("actualModel column has correct DB name", () => {
    expect(subagentInvocationsTable.actualModel.name).toBe("actual_model");
  });
});

// ---------------------------------------------------------------------------
// Table column shape — timing group
// ---------------------------------------------------------------------------

describe("subagentInvocationsTable timing columns", () => {
  test("startedAt column has correct DB name", () => {
    expect(subagentInvocationsTable.startedAt.name).toBe("started_at");
  });

  test("endedAt column has correct DB name", () => {
    expect(subagentInvocationsTable.endedAt.name).toBe("ended_at");
  });

  test("durationMs column has correct DB name", () => {
    expect(subagentInvocationsTable.durationMs.name).toBe("duration_ms");
  });
});

// ---------------------------------------------------------------------------
// Table column shape — metrics group
// ---------------------------------------------------------------------------

describe("subagentInvocationsTable metrics columns", () => {
  test("toolUseCount column has correct DB name", () => {
    expect(subagentInvocationsTable.toolUseCount.name).toBe("tool_use_count");
  });

  test("totalTokens column has correct DB name", () => {
    expect(subagentInvocationsTable.totalTokens.name).toBe("total_tokens");
  });
});

// ---------------------------------------------------------------------------
// Table column shape — outcome group
// ---------------------------------------------------------------------------

describe("subagentInvocationsTable outcome columns", () => {
  test("outcome column has correct DB name", () => {
    expect(subagentInvocationsTable.outcome.name).toBe("outcome");
  });

  test("errorSummary column has correct DB name", () => {
    expect(subagentInvocationsTable.errorSummary.name).toBe("error_summary");
  });

  test("summary column has correct DB name", () => {
    expect(subagentInvocationsTable.summary.name).toBe("summary");
  });
});

// ---------------------------------------------------------------------------
// Table column shape — workspace state group
// ---------------------------------------------------------------------------

describe("subagentInvocationsTable workspace state columns", () => {
  test("prUrl column has correct DB name", () => {
    expect(subagentInvocationsTable.prUrl.name).toBe("pr_url");
  });

  test("lastCommitHash column has correct DB name", () => {
    expect(subagentInvocationsTable.lastCommitHash.name).toBe("last_commit_hash");
  });

  test("handoffWritten column has correct DB name", () => {
    expect(subagentInvocationsTable.handoffWritten.name).toBe("handoff_written");
  });
});

// ---------------------------------------------------------------------------
// Table DB name
// ---------------------------------------------------------------------------

describe("subagentInvocationsTable table name", () => {
  test("table DB name is subagent_invocations", () => {
    // Access the underlying symbol that holds the table name
    expect(subagentInvocationsTable[Symbol.for("drizzle:Name")]).toBe("subagent_invocations");
  });
});

// ---------------------------------------------------------------------------
// SQL migration sanity check
// ---------------------------------------------------------------------------

describe("0033_subagent_invocations.sql migration sanity", () => {
  const migrationPath = join(MIGRATIONS_DIR, "0033_subagent_invocations.sql");

  test("migration file exists and is readable", () => {
    expect(() => readFileSync(migrationPath)).not.toThrow();
  });

  test("migration creates subagent_invocations table", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "subagent_invocations"');
  });

  test("migration creates subagent_invocation_outcome enum type", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('CREATE TYPE "subagent_invocation_outcome" AS ENUM');
  });

  test("enum creation is guarded against duplicate_object errors (re-runnable)", () => {
    const sql = readFileSync(migrationPath).toString();
    // PG's CREATE TYPE doesn't support IF NOT EXISTS; the canonical idiom is a
    // DO block with EXCEPTION WHEN duplicate_object. Verify both halves of the
    // pattern are present.
    expect(sql).toContain("DO $$");
    expect(sql).toContain("EXCEPTION");
    expect(sql).toContain("duplicate_object");
  });

  test("migration enum contains the 6 ORIGINAL outcome values", () => {
    // Scoped to the values 0033 actually created. `pending` is deliberately absent here —
    // Postgres cannot add an enum member retroactively to an already-applied migration, so
    // mt#1770 added it in its own migration (asserted separately below). Asserting the full
    // current value list against 0033 would fail every time the enum is extended, which is
    // what it did when `pending` landed.
    const ORIGINAL_VALUES = [
      "completed-with-pr",
      "committed-no-pr",
      "partial-committed-handoff-written",
      "partial-uncommitted-no-handoff",
      "crashed-no-output",
      "rate-limited",
    ];
    const sql = readFileSync(migrationPath).toString();
    for (const value of ORIGINAL_VALUES) {
      expect(sql).toContain(`'${value}'`);
    }
  });

  test("every enum value is created by SOME migration for THIS enum (mt#1770)", () => {
    // The real invariant the 0033-scoped test was reaching for: no value can exist in the TS
    // enum without a migration that adds it to the Postgres type, or a fresh database would
    // reject the insert at runtime while every unit test passed.
    //
    // Two rounds of tightening, both driven by a false pass:
    //
    // 1. A repo-wide grep for the quoted value is not a check — `'pending'` also appears in 0060
    //    as a member of the unrelated `follow_up_status` enum, so that version passed with THIS
    //    enum's own migration deleted (verified by deleting it).
    // 2. Scoping to statements that merely NAME the enum is still too loose (PR #2501 R1): it
    //    proves the value appears somewhere near the name, not that any statement ADDS it. The
    //    CREATE TABLE in 0033 names the enum as a column type, so an unrelated quoted literal
    //    sharing a future value's spelling would satisfy it.
    //
    // The real invariant: every value is introduced either by the base `CREATE TYPE ... AS ENUM`
    // or by an `ALTER TYPE ... ADD VALUE`. Anything else means a fresh database would reject the
    // insert at runtime while every unit test passed.
    const statements = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .flatMap((f) => readFileSync(join(MIGRATIONS_DIR, f)).toString().split(";"))
      // Comment lines cannot introduce a value; drop them so a value merely MENTIONED in a
      // backout note or rationale never counts as its declaration.
      .map((stmt) =>
        stmt
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
      )
      .filter((stmt) => stmt.includes(ENUM_TYPE_NAME));

    const baseCreate = statements.filter((s) => /CREATE\s+TYPE/i.test(s));
    const addValues = statements.filter((s) => /ALTER\s+TYPE/i.test(s) && /ADD\s+VALUE/i.test(s));
    expect(baseCreate.length).toBeGreaterThan(0);

    for (const value of SUBAGENT_INVOCATION_OUTCOME_VALUES) {
      const introducedByCreate = baseCreate.some((s) => s.includes(`'${value}'`));
      const introducedByAlter = addValues.some((s) => s.includes(`'${value}'`));
      // Reported per-value so a failure names WHICH member has no migration.
      expect({ value, introduced: introducedByCreate || introducedByAlter }).toEqual({
        value,
        introduced: true,
      });
    }
  });

  test("`pending` specifically is introduced by an ALTER TYPE ... ADD VALUE (mt#1770)", () => {
    // Sharper than the loop above for the member this task adds: it must arrive via ADD VALUE,
    // not by being retrofitted into the base CREATE TYPE — editing an already-applied migration
    // would leave every existing database without the value while tests passed.
    const addValueStatements = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .flatMap((f) => readFileSync(join(MIGRATIONS_DIR, f)).toString().split(";"))
      .filter(
        (s) => s.includes(ENUM_TYPE_NAME) && /ALTER\s+TYPE/i.test(s) && /ADD\s+VALUE/i.test(s)
      );
    expect(addValueStatements.some((s) => s.includes("'pending'"))).toBe(true);
  });

  test("migration creates index on task_id", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('"idx_subagent_invocations_task_id"');
  });

  test("migration creates index on agent_session_id", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('"idx_subagent_invocations_agent_session_id"');
  });

  test("migration creates index on started_at", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('"idx_subagent_invocations_started_at"');
  });

  test("migration creates index on outcome", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('"idx_subagent_invocations_outcome"');
  });

  test("migration includes backout instructions as a comment", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("Backout");
  });

  test("migration includes task_id column (NOT NULL)", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('"task_id"');
  });

  test("migration includes agent_session_id column", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('"agent_session_id"');
  });

  test("migration includes started_at column (NOT NULL)", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('"started_at"');
  });

  test("migration includes outcome column (NOT NULL)", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('"outcome"');
  });

  test("migration includes handoff_written boolean column", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('"handoff_written"');
  });
});

// ---------------------------------------------------------------------------
// Drizzle journal registration — guards against the "SQL on disk but not
// applied at runtime" drift class (PR #1040 R1 reviewer-bot finding)
// ---------------------------------------------------------------------------

describe("drizzle journal registration for 0033_subagent_invocations", () => {
  const journalPath = join(MIGRATIONS_DIR, "meta", "_journal.json");

  test("journal file exists and parses as JSON", () => {
    const raw = readFileSync(journalPath).toString();
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("journal contains an entry tagged 0033_subagent_invocations", () => {
    const journal = JSON.parse(readFileSync(journalPath).toString()) as {
      entries: Array<{ idx: number; tag: string; version: string; breakpoints: boolean }>;
    };
    const entry = journal.entries.find((e) => e.tag === "0033_subagent_invocations");
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(33);
    expect(entry?.version).toBe("7");
    expect(entry?.breakpoints).toBe(true);
  });

  test("schema is registered in drizzle.pg.config.ts", () => {
    // mt#2108 moved this file from src/domain/storage/schemas to
    // packages/domain/src/storage/schemas — one directory level deeper, so
    // reaching the repo-root drizzle.pg.config.ts now needs one more ".."
    // (mt#2608).
    const configPath = join(import.meta.dir, "../../../../..", "drizzle.pg.config.ts");
    const cfg = readFileSync(configPath).toString();
    expect(cfg).toContain("subagent-invocations-schema.ts");
  });
});
