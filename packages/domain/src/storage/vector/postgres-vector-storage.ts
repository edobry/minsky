import { injectable } from "tsyringe";
import postgres from "postgres";
import { sql as dsql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { VectorStorage, SearchResult, SearchOptions } from "./types";
import { log } from "@minsky/shared/logger";
import { withPgPoolRetry } from "../../persistence/postgres-retry";
import type { GuardedRawSql } from "../../persistence/raw-sql-pooler-guard";

export interface PostgresVectorStorageConfig {
  tableName: string;
  idColumn: string; // e.g., task_id
  embeddingColumn: string; // e.g., vector or embedding
  dimensionColumn?: string; // optional legacy column; most schemas dropped it
  lastIndexedAtColumn?: string; // e.g., indexed_at or last_indexed_at
  metadataColumn?: string; // e.g., metadata (JSONB)
  contentHashColumn?: string; // e.g., content_hash (TEXT)
}

/**
 * Translate a `SearchOptions.filters` bag into drizzle SQL predicates.
 *
 * Exported and free-standing so the translation can be asserted directly on its
 * return value, without a database or a spy on a collaborator this class
 * reaches itself (`testing-standards.mdc §Testable Design`).
 *
 * **Two key forms (mt#4944).** A bare identifier (`status`) targets a COLUMN. A
 * single-dotted key (`metadata.sourceName`) targets a JSONB member —
 * `metadata->>'sourceName'` — with the member name BOUND as a parameter rather
 * than interpolated, so only the column half is ever rendered as SQL text.
 * The dotted form exists because a value can be indexed under a JSONB key and
 * have no column of its own, which is exactly the shape that made
 * `knowledge search --sources` unusable: it filtered on `sourceName`, which
 * lives in `knowledge_embeddings.metadata` and is not a column, so Postgres
 * folded the identifier to `sourcename` and raised 42703 on every call.
 *
 * This stays domain-agnostic per ADR-013 — "it filters by whatever column is
 * named" — and simply widens "column" to "column or JSONB member". No
 * knowledge-specific concept enters this layer.
 *
 * **Array values do SET MEMBERSHIP, not equality.** `{ status: ["A", "B"] }`
 * renders `status IN ($1, $2)`. Before mt#4944 it rendered `status = $1` with
 * an array bound to a scalar comparison, which matches nothing and reports no
 * error — the silent-zero shape this task exists to remove.
 */
export function buildFilterConditions(filters: Record<string, unknown> | undefined): SQL[] {
  const conditions: SQL[] = [];
  if (!filters) return conditions;

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;

    // Exclusion filters (e.g., statusExclude: ['DONE', 'CLOSED'])
    if (key.endsWith("Exclude") && Array.isArray(value)) {
      // An empty exclusion list excludes NOTHING, so the correct rendering is
      // no predicate at all. The pre-mt#4937 code fell through to the equality
      // branch here and emitted `statusExclude = $1` — a predicate naming a
      // column that does not exist, against an array value. PR #3598 R1
      // (BLOCKING) caught that this rewrite carried the behavior forward, and
      // that the test written beside it asserted the fall-through as correct.
      if (value.length === 0) continue;

      // `slice`, not `replace("Exclude", "")`: replace strips the FIRST
      // occurrence anywhere in the key, so a hypothetical `excludeExclude`
      // would lose the wrong one. Only the suffix is the marker.
      const columnName = key.slice(0, -"Exclude".length);
      conditions.push(
        dsql`${filterTarget(columnName)} NOT IN (${dsql.join(
          value.map((v) => dsql`${v}`),
          dsql`, `
        )})`
      );
      continue;
    }

    // Set membership (e.g., sources: ['a', 'b']) — mt#4944.
    if (Array.isArray(value)) {
      // Symmetric with the exclusion branch above: an empty list is not a
      // renderable predicate (`IN ()` is a syntax error), and restricting to
      // nothing is not a request any caller can express through a CLI array
      // flag, which yields `undefined` rather than `[]` when omitted.
      if (value.length === 0) continue;
      conditions.push(
        dsql`${filterTarget(key)} IN (${dsql.join(
          value.map((v) => dsql`${v}`),
          dsql`, `
        )})`
      );
      continue;
    }

    // Regular equality filters (e.g., status: 'TODO')
    conditions.push(dsql`${filterTarget(key)} = ${value}`);
  }

  return conditions;
}

/**
 * The SQL expression a filter key targets: a column, or a JSONB member of one.
 *
 * `metadata.sourceName` becomes `metadata->>$n` with `"sourceName"` BOUND —
 * the member name never reaches the statement as text, so the only injection
 * surface is the column half, which {@link rawIdentifier} refuses unless it is
 * a plain identifier. A key with more than one dot is refused rather than
 * guessed at: nested JSONB access needs `#>>` and a path array, and inventing
 * a second syntax here without a caller for it is speculative.
 */
function filterTarget(key: string): SQL {
  const firstDot = key.indexOf(".");
  if (firstDot === -1) return rawIdentifier(key);

  const column = key.slice(0, firstDot);
  const member = key.slice(firstDot + 1);
  if (member.length === 0 || member.includes(".")) {
    throw new Error(
      `PostgresVectorStorage: refusing to render ${JSON.stringify(key)} as a filter target. ` +
        `A dotted key addresses exactly one JSONB member, as "<column>.<member>".`
    );
  }
  return dsql`${rawIdentifier(column)}->>${member}`;
}

/**
 * A filter key rendered as a bare SQL identifier, refused unless it looks like
 * one.
 *
 * Filter keys become SQL text, not bound parameters — a column name cannot be
 * a placeholder. The pre-mt#4937 code interpolated them into a template string
 * with no check at all; this rewrite preserved that and PR #3598 R1 flagged it
 * BLOCKING. The surface is real even though every key in the tree today is a
 * hard-coded literal (`status`, `backend`, `kind`, `sourceName`): `filters` is
 * a `Record<string, unknown>` on a public interface, so the type permits a
 * caller to forward user input as a KEY, and nothing between here and there
 * would notice.
 *
 * Refusing is the right response rather than quoting. Quoting with
 * `dsql.identifier()` would accept the injection attempt and turn it into a
 * lookup of an absurd column name. A key that is not an identifier is a
 * programming error at the call site, and it should fail loudly there.
 *
 * This function's unquoted rendering is now load-bearing for a second reason
 * (mt#4944): it applies to the COLUMN half of a dotted key, where the value
 * being addressed lives in a JSONB member rather than a column of its own.
 * Quoting the column would not help that case and would break every existing
 * caller whose column name is lowercase in the schema. The case-folding hazard
 * that motivated the original warning here — `sourceName` folding to
 * `sourcename` — is resolved at the CALLER (it now names `metadata.sourceName`
 * and the member is bound, not folded), not by changing this rendering.
 */
function rawIdentifier(name: string): SQL {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `PostgresVectorStorage: refusing to render ${JSON.stringify(name)} as a SQL identifier. ` +
        `Filter keys are interpolated as column names and must match /^[A-Za-z_][A-Za-z0-9_]*$/.`
    );
  }
  return dsql.raw(name);
}

@injectable()
export class PostgresVectorStorage implements VectorStorage {
  /**
   * Accepts the mt#2773 GUARDED instance as well as a raw postgres-js client
   * (mt#4298). Production wiring passes the guarded one — every query below
   * goes through `.unsafe()`, the surface that guard bounds. Tests and
   * one-off scripts still pass a raw client, which is why this stays a union
   * rather than narrowing to `GuardedRawSql`.
   */
  private readonly sql: ReturnType<typeof postgres> | GuardedRawSql;
  private readonly db: PostgresJsDatabase;

  constructor(
    sql: ReturnType<typeof postgres> | GuardedRawSql,
    db: PostgresJsDatabase,
    private readonly dimension: number,
    private readonly config: PostgresVectorStorageConfig
  ) {
    this.sql = sql;
    this.db = db;
  }

  async initialize(): Promise<void> {
    await withPgPoolRetry(
      () => this.sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector"),
      "postgres-vector-storage.initialize"
    );
    // Tables are managed by Drizzle migrations. No-op here to avoid drift.
  }

  async store(id: string, vector: number[], _metadata?: Record<string, unknown>): Promise<void> {
    return withPgPoolRetry(
      () => this.storeInternal(id, vector, _metadata),
      "postgres-vector-storage.store"
    );
  }

  private async storeInternal(
    id: string,
    vector: number[],
    _metadata?: Record<string, unknown>
  ): Promise<void> {
    const vectorLiteral = `[${vector.join(",")}]`;

    const cols: string[] = [this.config.idColumn, this.config.embeddingColumn];
    const placeholders: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js sql.unsafe() requires ParameterOrJSON<never>[] which doesn't accept unknown
    const values: any[] = [];
    let paramIndex = 1;

    // id
    placeholders.push(`$${paramIndex++}`);
    values.push(id);

    // optional dimension column (legacy schemas)
    if (this.config.dimensionColumn) {
      cols.splice(1, 0, this.config.dimensionColumn);
      placeholders.push(`$${paramIndex++}`);
      values.push(this.dimension);
    }

    // embedding (vector)
    placeholders.push(`$${paramIndex++}::vector`);
    values.push(vectorLiteral);

    // optional metadata JSONB
    if (this.config.metadataColumn) {
      cols.push(this.config.metadataColumn);
      placeholders.push(`$${paramIndex++}::jsonb`);
      values.push(_metadata ? JSON.stringify(_metadata) : JSON.stringify({}));
    }

    // optional content hash TEXT
    if (this.config.contentHashColumn) {
      cols.push(this.config.contentHashColumn);
      placeholders.push(`$${paramIndex++}`);
      values.push(_metadata?.contentHash || null);
    }

    // optional lastIndexedAt
    if (this.config.lastIndexedAtColumn) {
      cols.push(this.config.lastIndexedAtColumn);
      placeholders.push("NOW()");
    }

    const updateSets: string[] = [
      `${this.config.embeddingColumn} = EXCLUDED.${this.config.embeddingColumn}`,
    ];
    if (this.config.dimensionColumn) {
      updateSets.push(`${this.config.dimensionColumn} = EXCLUDED.${this.config.dimensionColumn}`);
    }
    if (this.config.metadataColumn) {
      updateSets.push(`${this.config.metadataColumn} = EXCLUDED.${this.config.metadataColumn}`);
    }
    if (this.config.contentHashColumn) {
      updateSets.push(
        `${this.config.contentHashColumn} = EXCLUDED.${this.config.contentHashColumn}`
      );
    }
    if (this.config.lastIndexedAtColumn) {
      updateSets.push(`${this.config.lastIndexedAtColumn} = NOW()`);
    }

    const sql = `INSERT INTO ${this.config.tableName} (${cols.join(", ")})
       VALUES (${placeholders.join(", ")})
       ON CONFLICT (${this.config.idColumn}) DO UPDATE SET ${updateSets.join(", ")}`;

    await this.sql.unsafe(sql, values);
  }

  async getMetadata(id: string): Promise<Record<string, unknown> | null> {
    return withPgPoolRetry(
      () => this.getMetadataInternal(id),
      "postgres-vector-storage.getMetadata"
    );
  }

  private async getMetadataInternal(id: string): Promise<Record<string, unknown> | null> {
    const cols: string[] = [this.config.idColumn];
    if (this.config.contentHashColumn) cols.push(this.config.contentHashColumn);
    if (this.config.lastIndexedAtColumn) cols.push(this.config.lastIndexedAtColumn);
    if (this.config.metadataColumn) cols.push(this.config.metadataColumn);

    const rows = await this.sql.unsafe(
      `SELECT ${cols.join(", ")} FROM ${this.config.tableName} WHERE ${this.config.idColumn} = $1 LIMIT 1`,
      [id]
    );
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const c of cols) out[c] = (row as Record<string, unknown>)[c];
    return out;
  }

  async search(queryVector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    return withPgPoolRetry(
      () => this.searchInternal(queryVector, options),
      "postgres-vector-storage.search"
    );
  }

  private async searchInternal(
    queryVector: number[],
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const { limit = 10, threshold, filters } = options;
    const vectorLiteral = `[${queryVector.join(",")}]`;

    try {
      log.debug("[vector.search] Using Postgres vector storage", {
        limit,
        threshold,
        filters,
        dimension: this.dimension,
        table: this.config.tableName,
      });
    } catch {
      // ignore debug logging errors
    }

    const conditions = buildFilterConditions(filters);

    const rows =
      conditions.length > 0
        ? await this.searchFiltered(vectorLiteral, limit, conditions)
        : await this.searchUnfiltered(vectorLiteral, limit);

    const results: SearchResult[] = (rows as Record<string, unknown>[]).map((r) => {
      const result: SearchResult = { id: String(r.id), score: Number(r.score) };
      // A row whose metadata column is SQL NULL carries no metadata, which is
      // `undefined` rather than `{}` — an empty object is a value someone
      // stored (`storeInternal` writes `{}` when handed none), and conflating
      // the two would make "never written" indistinguishable from "written
      // empty". Rows predating mt#1930 are the NULL population.
      if (this.config.metadataColumn && r.metadata != null) {
        result.metadata = r.metadata as Record<string, unknown>;
      }
      return result;
    });

    return results.filter((r) =>
      isFinite(threshold as number) ? r.score <= (threshold as number) : true
    );
  }

  /**
   * The metadata column's SELECT-list suffix, or `""` when the table has no
   * metadata column configured.
   *
   * **One method feeds BOTH query builders on purpose (mt#4948).** The metadata
   * column has been configured, written on `store`, and readable through
   * `getMetadata` since mt#1930 — and was in NEITHER builder's SELECT list, so
   * `SearchResult.metadata` came back empty for every caller of the shared
   * search path. `knowledge search` was the first consumer to read it directly
   * and rendered blank titles, blank urls, and an epoch `lastModified` that
   * made `classifyFreshness` mark every chunk stale.
   *
   * The builders are separate functions using separate drivers (`sql.unsafe`
   * vs drizzle inside a transaction), which is exactly the shape where a fix
   * lands on one path and not the other — so the decision about WHETHER and HOW
   * to project lives here, once, rather than being restated twice.
   *
   * Raw interpolation matches how every other identifier in these queries is
   * rendered (`idColumn`, `tableName`, `embeddingColumn`): a column name cannot
   * be a bind parameter, and this value comes from the construction config, not
   * from a caller.
   */
  private metadataProjection(): string {
    return this.config.metadataColumn ? `, ${this.config.metadataColumn} AS metadata` : "";
  }

  /**
   * The UNFILTERED nearest-neighbour query, deliberately still on
   * `this.sql.unsafe()`: with no `WHERE`, every row the HNSW scan yields is a
   * row the caller wanted, so the recall hazard the filtered sibling below
   * exists to fix cannot arise here. That property is why mt#4937 was a
   * low-risk change to a very hot code path, and it is unaffected by mt#4948's
   * addition of the metadata column to the projection — a wider SELECT list
   * changes which columns come back, never which rows.
   */
  private async searchUnfiltered(vectorLiteral: string, limit: number): Promise<unknown> {
    const query = `
      SELECT ${this.config.idColumn} AS id, (${this.config.embeddingColumn} <-> $1::vector) AS score${this.metadataProjection()}
      FROM ${this.config.tableName}
      ORDER BY ${this.config.embeddingColumn} <-> $1::vector
      LIMIT $2
    `;
    return this.sql.unsafe(query, [vectorLiteral, limit]);
  }

  /**
   * The FILTERED nearest-neighbour query, run under `hnsw.iterative_scan`.
   *
   * ## The defect this exists to prevent (mt#4919, generalized by mt#4937)
   *
   * pgvector applies a `WHERE` filter AFTER the HNSW index is scanned, and the
   * scan yields only `hnsw.ef_search` candidates (default 40). So `ORDER BY
   * <embedding> <-> $1 LIMIT $2` with a selective filter silently returns FEWER
   * rows than `LIMIT` asked for — no error, no warning, a short page that looks
   * like a small corpus. Measured on the transcripts path before mt#4919 fixed
   * it there: **10 of 20** requested at ~12.7% selectivity, **7 of 20** at ~6%,
   * deterministic, and non-monotonic in the limit (`[5,10,15,20,30,50]`
   * returned `[5,7,7,7,7,50]`). After: 20, 20, and the full page at every limit.
   *
   * ## Why this ships with no measurement on THIS path
   *
   * mt#4937 audited all five namespaces reached through this class and found
   * the defect **latent, not absent**: the construction is here and reachable,
   * but no caller today exercises it at a selectivity that trips it. The only
   * caller that passes `filters` at all is `knowledge search --sources`
   * (`src/adapters/shared/commands/knowledge/index.ts:202`), and
   * `knowledge_embeddings` carries exactly ONE distinct `sourceName` across 111
   * rows — 100% or 0% selectivity, neither of which can under-return. Every
   * other namespace (`tasks_`, `rules_`, `memories_`, `principal_corpus_`)
   * post-filters in the domain layer per ADR-013 and passes no `filters` here;
   * `SimilarityQuery.filters` is declared and forwarded but populated by
   * nobody.
   *
   * **The first caller to arm this is a known, planned one.** mt#2938's
   * recommended interim fix for rules project-scoping is, verbatim, "a project
   * tag in metadata + a search-time filter" — and `rules_embeddings` holds 71
   * rows against a default `ef_search` of 40, so a filter at roughly half
   * selectivity leaves ~20 rows for a page that asked for more. That is why the
   * fix ships ahead of a demonstration rather than waiting for one.
   *
   * ## Why iterative_scan and not a bigger ef_search
   *
   * Measured on the transcripts path (mt#4919): `ef_search = 100` returns the
   * full 20 at 12.7% selectivity but only **15** at 6%. A fixed budget is a
   * guess against an unknown selectivity, and this class serves five namespaces
   * whose filters are not known to it. `strict_order` rather than
   * `relaxed_order` because both returned the full page and strict preserves
   * exact distance ordering, which a ranked surface should not silently drop.
   *
   * ## Why this DEVIATES from ADR-013, deliberately
   *
   * ADR-013 prescribes an application-layer adaptive over-fetch, and its own
   * text calls that "the application-layer equivalent of pgvector 0.8's
   * bounded iterative scan" — an emulation of exactly this setting. It needed
   * the emulation because its filter was a MUTABLE DENORMALIZED column
   * (`tasks_embeddings.status`) that had drifted from its source of truth. No
   * such constraint applies to this generic path, and `pg_extension` reports
   * vector **0.8.0** (verified 2026-09-03), so the native mechanism is
   * available. **Do not "restore consistency" by reproducing ADR-013's widen
   * here** — and note ADR-013's own over-fetch still runs above this class in
   * `TaskSimilarityService`, so a future filtered tasks caller would get both.
   * mt#4937's Scope names resolving that overlap explicitly.
   *
   * ## Why drizzle, and NOT `this.sql.begin()`
   *
   * `SET LOCAL` needs a transaction, and there are two ways to get one here.
   * `sql.begin()` is the shorter path and is WRONG: `begin` forwards through
   * the mt#2773 pooler guard's Proxy untouched and runs on a connection the
   * guard never sees, so filtered searches would escape the in-flight bound.
   * That bound is not decorative — mt#4298 moved this exact class onto the
   * guarded instance because unguarded raw fan-out at the Supavisor transaction
   * pooler wedges it, leaving postgres-js promises permanently unsettled (hangs
   * with no error, ~45 minutes across three conversations on 2026-08-23).
   * drizzle issues every query through `.unsafe()` on the guarded instance
   * (mt#4473), so `this.db.transaction()` stays inside the bound. `SET LOCAL`
   * also reverts on commit, so it cannot leak to another caller sharing the
   * pooled connection the way a bare `SET` would, and it changes nothing for
   * the other vector searches a database- or role-level default would hit.
   */
  private async searchFiltered(
    vectorLiteral: string,
    limit: number,
    conditions: SQL[]
  ): Promise<unknown> {
    // `this.config.embeddingColumn` is written out in full at BOTH distance
    // expressions rather than hoisted to a local alias. That is not style:
    // `operator-class-alignment.ts` (mt#4344) attributes a `<->` to a namespace
    // by finding that exact token within 16 characters before the operator, and
    // its companion check FAILS on any distance expression no namespace claims.
    // An alias renders both expressions unattributable. Keep them literal.
    const query = dsql`
      SELECT
        ${dsql.raw(this.config.idColumn)} AS id,
        (${dsql.raw(this.config.embeddingColumn)} <-> ${vectorLiteral}::vector) AS score${dsql.raw(this.metadataProjection())}
      FROM ${dsql.raw(this.config.tableName)}
      WHERE ${dsql.join(conditions, dsql` AND `)}
      ORDER BY ${dsql.raw(this.config.embeddingColumn)} <-> ${vectorLiteral}::vector
      LIMIT ${limit}
    `;

    return this.db.transaction(async (tx) => {
      await tx.execute(dsql`SET LOCAL hnsw.iterative_scan = strict_order`);
      return tx.execute(query);
    });
  }

  async delete(id: string): Promise<void> {
    await withPgPoolRetry(
      () =>
        this.sql.unsafe(`DELETE FROM ${this.config.tableName} WHERE ${this.config.idColumn} = $1`, [
          id,
        ]),
      "postgres-vector-storage.delete"
    );
  }
}
