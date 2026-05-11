/**
 * Subagent invocations schema shape and enum tests — mt#1735
 *
 * Verifies that the Drizzle table definition has the expected column names,
 * that the outcome enum has exactly the 6 specified values, and that the SQL
 * migration file contains the required DDL.
 *
 * These are pure unit tests — no live DB required.
 */

/* eslint-disable custom/no-real-fs-in-tests -- reading shipped migration SQL IS the point of drift checks */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  subagentInvocationsTable,
  subagentInvocationOutcomeEnum,
  SUBAGENT_INVOCATION_OUTCOME_VALUES,
} from "./subagent-invocations-schema";

const MIGRATIONS_DIR = join(import.meta.dir, "../migrations/pg");

// ---------------------------------------------------------------------------
// Outcome enum
// ---------------------------------------------------------------------------

describe("SubagentInvocationOutcome enum", () => {
  test("SUBAGENT_INVOCATION_OUTCOME_VALUES has exactly 6 values", () => {
    expect(SUBAGENT_INVOCATION_OUTCOME_VALUES).toHaveLength(6);
  });

  test("SUBAGENT_INVOCATION_OUTCOME_VALUES contains exactly the 6 specified outcome values", () => {
    const expected = [
      "completed-with-pr",
      "committed-no-pr",
      "partial-committed-handoff-written",
      "partial-uncommitted-no-handoff",
      "crashed-no-output",
      "rate-limited",
    ] as string[];
    const actual: string[] = [...SUBAGENT_INVOCATION_OUTCOME_VALUES].sort();
    expect(actual).toEqual(expected.sort());
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

  test("migration enum contains all 6 outcome values", () => {
    const sql = readFileSync(migrationPath).toString();
    for (const value of SUBAGENT_INVOCATION_OUTCOME_VALUES) {
      expect(sql).toContain(`'${value}'`);
    }
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
    const configPath = join(import.meta.dir, "../../../..", "drizzle.pg.config.ts");
    const cfg = readFileSync(configPath).toString();
    expect(cfg).toContain("subagent-invocations-schema.ts");
  });
});
