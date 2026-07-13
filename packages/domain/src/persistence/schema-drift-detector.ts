/**
 * Schema-drift detector (mt#1641)
 *
 * The drizzle migration LEDGER (`drizzle.__drizzle_migrations`) is structurally
 * untrustworthy: it records migrations by hash with NO post-apply schema verification,
 * so a manual `DROP COLUMN` (mt#2229) or a never-executed `CREATE TABLE` (mt#1641's 0020
 * `knowledge_embeddings` phantom) leaves the ledger "clean" while the actual schema
 * diverges. The only reliable signal is **declared schema (drizzle models) vs actual DB**
 * (information_schema). This module provides that comparison plus a cheap ledger-anomaly
 * check (duplicate rows / count-vs-journal), as pure functions (testable without a DB) and
 * a read-only DB orchestrator.
 *
 * Read-only: this module never mutates the database.
 */

import { getTableConfig } from "drizzle-orm/pg-core";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle PgTable generic varies per table; we only read config
type AnyPgTable = any;

export interface DeclaredTable {
  name: string;
  columns: string[];
}

export interface ActualTable {
  name: string;
  columns: string[];
}

export interface SchemaDriftReport {
  /** declared tables absent from the DB (e.g. the 0020 knowledge_embeddings phantom) */
  missingTables: string[];
  /** declared columns absent from an existing DB table */
  missingColumns: Array<{ table: string; column: string }>;
  /** DB columns present on a declared table but not declared (e.g. mt#2229 vestigial cols
   *  before the model was updated, or a manual ADD COLUMN) */
  extraColumns: Array<{ table: string; column: string }>;
}

/** True when no declared-vs-actual divergence was found. */
export function isSchemaDriftClean(r: SchemaDriftReport): boolean {
  return (
    r.missingTables.length === 0 && r.missingColumns.length === 0 && r.extraColumns.length === 0
  );
}

/**
 * Pure declared-vs-actual diff. Only compares tables present in `declared` (so an
 * incomplete registry under-reports rather than false-positives on unrelated DB tables).
 */
export function diffDeclaredVsActual(
  declared: DeclaredTable[],
  actual: ActualTable[]
): SchemaDriftReport {
  const actualByName = new Map(actual.map((t) => [t.name, new Set(t.columns)]));
  const missingTables: string[] = [];
  const missingColumns: Array<{ table: string; column: string }> = [];
  const extraColumns: Array<{ table: string; column: string }> = [];

  for (const d of declared) {
    const actualCols = actualByName.get(d.name);
    if (!actualCols) {
      missingTables.push(d.name);
      continue;
    }
    const declaredCols = new Set(d.columns);
    for (const c of d.columns) {
      if (!actualCols.has(c)) missingColumns.push({ table: d.name, column: c });
    }
    for (const c of actualCols) {
      if (!declaredCols.has(c)) extraColumns.push({ table: d.name, column: c });
    }
  }

  return { missingTables, missingColumns, extraColumns };
}

export interface LedgerStats {
  /** total rows in drizzle.__drizzle_migrations */
  totalRows: number;
  /** distinct hash values in the ledger */
  distinctHashes: number;
  /** number of entries in the drizzle journal (_journal.json) */
  journalEntryCount: number;
}

export interface LedgerAnomalyReport {
  /** rows beyond the distinct-hash count — a migration recorded more than once */
  duplicateRows: number;
  /** distinctHashes - journalEntryCount; nonzero means ledger/journal disagree */
  ledgerVsJournalDelta: number;
  anomalies: string[];
}

export function isLedgerClean(r: LedgerAnomalyReport): boolean {
  return r.anomalies.length === 0;
}

/**
 * Pure ledger-anomaly analysis. Catches the mt#1641/mt#2229 symptom: a duplicate ledger
 * row (e.g. `d6c5f2987b19` recorded twice) inflates the count and trips
 * `assertMigrationCountMatch`, and a ledger/journal count disagreement signals drift.
 */
export function analyzeLedger(s: LedgerStats): LedgerAnomalyReport {
  const anomalies: string[] = [];
  const duplicateRows = Math.max(s.totalRows - s.distinctHashes, 0);
  if (duplicateRows > 0) {
    anomalies.push(
      `${duplicateRows} duplicate ledger row(s): __drizzle_migrations has ${s.totalRows} ` +
        `rows but only ${s.distinctHashes} distinct hashes (a migration is recorded more ` +
        `than once). This trips assertMigrationCountMatch once the runner is healthy.`
    );
  }
  const ledgerVsJournalDelta = s.distinctHashes - s.journalEntryCount;
  if (ledgerVsJournalDelta !== 0) {
    anomalies.push(
      `Ledger distinct-hash count (${s.distinctHashes}) does not match journal entry ` +
        `count (${s.journalEntryCount}) (delta ${ledgerVsJournalDelta}). The applied set ` +
        `and the declared migration set disagree.`
    );
  }
  return { duplicateRows, ledgerVsJournalDelta, anomalies };
}

/**
 * Introspect drizzle table model objects into the {name, columns} shape used by the diff.
 * Accepts any pgTable (including createEmbeddingsTable outputs).
 */
export function getDeclaredTables(tables: AnyPgTable[]): DeclaredTable[] {
  return tables.map((t) => {
    const cfg = getTableConfig(t);
    return { name: cfg.name, columns: cfg.columns.map((c: { name: string }) => c.name) };
  });
}

/** Minimal postgres.js surface this detector needs (read-only). */
export interface UnsafeSql {
  unsafe: (query: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
}

export interface DriftAuditResult {
  clean: boolean;
  issues: string[];
  suggestions: string[];
  schema: SchemaDriftReport;
  ledger: LedgerAnomalyReport;
}

/**
 * Read-only DB orchestrator: compares the given declared tables against the live DB's
 * actual columns, and checks the ledger for duplicate rows. `journalEntryCount` is
 * optional — when omitted, the ledger/journal delta check is skipped (the journal file
 * read is unreliable until the stale migrationsFolder path is fixed, mt#2227); the
 * duplicate-row check needs no journal and always runs.
 */
export async function auditPostgresSchemaDrift(
  sql: UnsafeSql,
  declared: DeclaredTable[],
  options: { journalEntryCount?: number } = {}
): Promise<DriftAuditResult> {
  // Actual columns for the declared table names (single round-trip).
  let actual: ActualTable[] = [];
  const names = declared.map((d) => d.name);
  if (names.length > 0) {
    const placeholders = names.map((_, i) => `$${i + 1}`).join(", ");
    const rows = (await sql.unsafe(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN (${placeholders})`,
      names
    )) as Array<{ table_name: string; column_name: string }>;
    const byTable = new Map<string, string[]>();
    for (const r of rows) {
      const list = byTable.get(r.table_name) ?? [];
      list.push(r.column_name);
      byTable.set(r.table_name, list);
    }
    actual = [...byTable.entries()].map(([name, columns]) => ({ name, columns }));
  }
  const schema = diffDeclaredVsActual(declared, actual);

  // Ledger stats (no journal needed for the duplicate-row check).
  let totalRows = 0;
  let distinctHashes = 0;
  try {
    const ledgerRows = (await sql.unsafe(
      `SELECT count(*)::int AS total, count(DISTINCT hash)::int AS distinct_hashes
       FROM drizzle.__drizzle_migrations`
    )) as Array<{ total: number; distinct_hashes: number }>;
    totalRows = Number(ledgerRows?.[0]?.total ?? 0);
    distinctHashes = Number(ledgerRows?.[0]?.distinct_hashes ?? 0);
  } catch {
    // ledger table absent / unreadable — leave zeros (no duplicate anomaly reported)
  }
  const ledger = analyzeLedger({
    totalRows,
    distinctHashes,
    // When journalEntryCount is unknown, neutralize the delta sub-check.
    journalEntryCount: options.journalEntryCount ?? distinctHashes,
  });

  const issues: string[] = [];
  const suggestions: string[] = [];
  for (const t of schema.missingTables) {
    issues.push(
      `Declared table "${t}" is MISSING from the database — migration may be tracked-applied ` +
        `without the table existing (mt#1641 shadow-failure class).`
    );
    suggestions.push(`Recreate "${t}" from its migration, or investigate why it was dropped.`);
  }
  for (const mc of schema.missingColumns) {
    issues.push(
      `Declared column "${mc.table}.${mc.column}" is MISSING from the database — likely a ` +
        `manual DROP COLUMN not captured by a migration (mt#2229 class).`
    );
  }
  for (const ec of schema.extraColumns) {
    issues.push(
      `Database column "${ec.table}.${ec.column}" exists but is NOT declared in the schema ` +
        `model (un-modeled column or a pending model update).`
    );
  }
  for (const a of ledger.anomalies) {
    issues.push(a);
    suggestions.push(
      `Reconcile drizzle.__drizzle_migrations against the journal (a deliberate prod write — see mt#1641).`
    );
  }

  return {
    clean: isSchemaDriftClean(schema) && isLedgerClean(ledger),
    issues,
    suggestions,
    schema,
    ledger,
  };
}
