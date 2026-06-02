import { describe, it, expect } from "bun:test";
import { pgTable, text, integer } from "drizzle-orm/pg-core";
import {
  diffDeclaredVsActual,
  analyzeLedger,
  getDeclaredTables,
  isSchemaDriftClean,
  isLedgerClean,
  type DeclaredTable,
  type ActualTable,
} from "./schema-drift-detector";

// Table names extracted to constants to satisfy custom/no-magic-string-duplication.
const TASKS_EMB = "tasks_embeddings";
const KNOW_EMB = "knowledge_embeddings";
const TASKS_COLS = ["task_id", "vector", "status", "backend"];
const KNOW_COLS = ["knowledge_id", "vector"];

describe("diffDeclaredVsActual (mt#1641)", () => {
  const declared: DeclaredTable[] = [
    { name: TASKS_EMB, columns: TASKS_COLS },
    { name: KNOW_EMB, columns: KNOW_COLS },
  ];

  it("reports clean when declared matches actual", () => {
    const actual: ActualTable[] = [
      { name: TASKS_EMB, columns: TASKS_COLS },
      { name: KNOW_EMB, columns: KNOW_COLS },
    ];
    expect(isSchemaDriftClean(diffDeclaredVsActual(declared, actual))).toBe(true);
  });

  it("detects a missing table (mt#1641 0020-phantom class)", () => {
    const actual: ActualTable[] = [{ name: TASKS_EMB, columns: TASKS_COLS }]; // KNOW_EMB absent
    const report = diffDeclaredVsActual(declared, actual);
    expect(report.missingTables).toEqual([KNOW_EMB]);
    expect(isSchemaDriftClean(report)).toBe(false);
  });

  it("detects a missing column (mt#2229 manual-DROP class)", () => {
    const actual: ActualTable[] = [
      { name: TASKS_EMB, columns: ["task_id", "vector"] }, // status + backend dropped in DB
      { name: KNOW_EMB, columns: KNOW_COLS },
    ];
    const report = diffDeclaredVsActual(declared, actual);
    expect(report.missingColumns).toEqual([
      { table: TASKS_EMB, column: "status" },
      { table: TASKS_EMB, column: "backend" },
    ]);
  });

  it("detects an extra (un-modeled) DB column", () => {
    const actual: ActualTable[] = [
      { name: TASKS_EMB, columns: [...TASKS_COLS, "legacy"] },
      { name: KNOW_EMB, columns: KNOW_COLS },
    ];
    const report = diffDeclaredVsActual(declared, actual);
    expect(report.extraColumns).toEqual([{ table: TASKS_EMB, column: "legacy" }]);
  });

  it("only compares declared tables (ignores unrelated DB tables)", () => {
    const actual: ActualTable[] = [
      { name: TASKS_EMB, columns: TASKS_COLS },
      { name: KNOW_EMB, columns: KNOW_COLS },
      { name: "some_other_table", columns: ["x"] },
    ];
    expect(isSchemaDriftClean(diffDeclaredVsActual(declared, actual))).toBe(true);
  });
});

describe("analyzeLedger (mt#1641 / mt#2229)", () => {
  it("is clean when total == distinct == journal", () => {
    expect(
      isLedgerClean(analyzeLedger({ totalRows: 44, distinctHashes: 44, journalEntryCount: 44 }))
    ).toBe(true);
  });

  it("flags a duplicate ledger row (real mt#2229 numbers: 45 rows / 44 hashes / 44 journal)", () => {
    const r = analyzeLedger({ totalRows: 45, distinctHashes: 44, journalEntryCount: 44 });
    expect(r.duplicateRows).toBe(1);
    expect(r.ledgerVsJournalDelta).toBe(0);
    expect(r.anomalies.length).toBe(1);
    expect(r.anomalies[0]).toContain("duplicate ledger row");
  });

  it("flags a ledger/journal count disagreement", () => {
    const r = analyzeLedger({ totalRows: 44, distinctHashes: 44, journalEntryCount: 43 });
    expect(r.ledgerVsJournalDelta).toBe(1);
    expect(r.anomalies.length).toBe(1);
    expect(r.anomalies[0]).toContain("does not match journal");
  });

  it("neutralizes the delta check when journalEntryCount equals distinctHashes (unknown journal)", () => {
    const r = analyzeLedger({ totalRows: 45, distinctHashes: 44, journalEntryCount: 44 });
    expect(r.anomalies.every((a) => !a.includes("journal"))).toBe(true);
  });
});

describe("getDeclaredTables", () => {
  it("introspects a pgTable into {name, columns}", () => {
    const fixture = pgTable("fixture_tbl", {
      id: text("id").primaryKey(),
      n: integer("n"),
      label: text("label"),
    });
    const [declared] = getDeclaredTables([fixture]);
    expect(declared.name).toBe("fixture_tbl");
    expect(declared.columns.sort()).toEqual(["id", "label", "n"]);
  });
});
