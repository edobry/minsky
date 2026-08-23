/**
 * Vector operator-class alignment check (mt#4344)
 *
 * pgvector can only use an index whose **operator class** matches the
 * **operator** in the query's `ORDER BY`. `vector_l2_ops` serves `<->`,
 * `vector_cosine_ops` serves `<=>`, `vector_ip_ops` serves `<#>`. Query with
 * the wrong one and nothing fails: the planner silently falls back to a
 * sequential scan, the results are still correct, and the index is dead weight
 * that is nonetheless maintained on every write and cleaned on every vacuum.
 *
 * That is not hypothetical. `idx_agent_transcript_turns_embedding` — 1,044 MB
 * of HNSW, a third of its table's total size — served **zero** queries across
 * the table's entire lifetime (`pg_stat_user_indexes.idx_scan = 0`, with
 * `pg_stat_database.stats_reset IS NULL`, so the counter is lifetime and the
 * zero is real). It was built `vector_l2_ops` while
 * `transcript-similarity-service.ts` hand-wrote `<=>`. There was no error, no
 * warning, and no failing test, because **nothing in this codebase tied an
 * index's operator class to the operator its query path uses.** That is the
 * gap this module closes.
 *
 * ## What it checks
 *
 * For every vector namespace: locate each site where the namespace's vector
 * column is used in a distance expression, read the operator actually written
 * there, and compare it against the operator implied by the index's declared
 * operator class. Also re-read the declaring schema file, so the registry below
 * cannot go stale against a schema someone changed.
 *
 * ## What it deliberately does NOT check
 *
 * The LIVE database. This is a static check over the repo's own declarations —
 * it catches the mismatch at authoring time, in the test suite, with no DB
 * connection. A live check (reading `pg_indexes.indexdef`) would catch a
 * hand-applied production DDL that diverged from the migrations; that is a
 * different guard with a different substrate and it is not this one.
 *
 * ## Why a registry rather than whole-repo inference
 *
 * "Find every vector query" is not statically decidable in a codebase that
 * builds SQL from template literals. An explicit registry is checkable in both
 * directions instead: each entry's query site must still exist and still carry
 * a distance operator (a moved or renamed call site FAILS the check rather
 * than silently passing), and each entry's declared opclass must still match
 * its schema file. A new namespace that nobody registers is the one case this
 * cannot see — which is why {@link VECTOR_NAMESPACES} is asserted complete
 * against `EMBEDDINGS_CONFIGS` in the companion test.
 */

// ── Operators and operator classes ────────────────────────────────────────────

/** The three pgvector distance operators. */
export type VectorDistanceOperator = "<->" | "<=>" | "<#>";

/** The three pgvector index operator classes. */
export type VectorOpClass = "vector_l2_ops" | "vector_cosine_ops" | "vector_ip_ops";

/**
 * The correspondence this whole module exists to enforce. An index built with
 * the key's opclass can only serve a query ordered by the value's operator.
 */
export const OPCLASS_OPERATOR: Readonly<Record<VectorOpClass, VectorDistanceOperator>> = {
  vector_l2_ops: "<->",
  vector_cosine_ops: "<=>",
  vector_ip_ops: "<#>",
};

/** Every opclass name, for scanning schema sources. */
export const ALL_OPCLASSES = Object.keys(OPCLASS_OPERATOR) as VectorOpClass[];

// ── The registry ──────────────────────────────────────────────────────────────

/** Where an index's operator class is declared in this repo. */
export interface VectorIndexDeclaration {
  /** The index name as it exists in Postgres. Templated in the factory case. */
  indexName: string;
  /** The operator class the declaration site sets. */
  opClass: VectorOpClass;
  /** Repo-relative path of the file that declares it. */
  declaredIn: string;
}

/** A file to scan, plus the token that names the vector column inside it. */
export interface VectorQuerySite {
  /** Repo-relative path of the file containing the distance expression. */
  file: string;
  /**
   * The exact source token naming the vector column at the query site — e.g.
   * `agentTranscriptTurnsTable.embedding` for a Drizzle table reference, or
   * `this.config.embeddingColumn` for the shared layer's interpolated column
   * name. Occurrences of this token that are NOT followed by a distance
   * operator (`IS NOT NULL` predicates, INSERT column lists) are ignored.
   */
  columnToken: string;
}

/** One vector column, its index (if any), and the query paths that read it. */
export interface VectorNamespace {
  /** Stable identifier used in findings. */
  name: string;
  table: string;
  column: string;
  /** The HNSW index over this column, or null when the column has none. */
  index: VectorIndexDeclaration | null;
  /**
   * Required when `index` is null: with no opclass to match, the expected
   * operator is a deliberate choice and must be stated rather than inferred.
   */
  unindexed?: { reason: string; expectedOperator: VectorDistanceOperator };
  querySites: VectorQuerySite[];
}

const SHARED_VECTOR_LAYER = "packages/domain/src/storage/vector/postgres-vector-storage.ts";
const EMBEDDINGS_FACTORY = "packages/domain/src/storage/schemas/embeddings-schema-factory.ts";
const TRANSCRIPT_SIMILARITY = "packages/domain/src/transcripts/transcript-similarity-service.ts";

/**
 * The shared layer builds one query shape for every domain in
 * `EMBEDDINGS_CONFIGS`, and the factory declares one index shape for all of
 * them — so these six entries differ only in which table they name. They are
 * still enumerated one-per-namespace rather than collapsed: the check's job is
 * to answer "is namespace X aligned?", and a shared implementation is a fact
 * about today's code, not a guarantee about tomorrow's.
 */
function sharedLayerNamespace(name: string, table: string): VectorNamespace {
  return {
    name,
    table,
    column: "vector",
    index: {
      indexName: `idx_${table}_hnsw`,
      opClass: "vector_l2_ops",
      declaredIn: EMBEDDINGS_FACTORY,
    },
    querySites: [{ file: SHARED_VECTOR_LAYER, columnToken: "this.config.embeddingColumn" }],
  };
}

export const VECTOR_NAMESPACES: readonly VectorNamespace[] = [
  // The outlier: the only vector path that bypasses the shared layer and
  // hand-writes its own SQL, and the one that diverged (mt#4344).
  {
    name: "agent_transcript_turns",
    table: "agent_transcript_turns",
    column: "embedding",
    index: {
      indexName: "idx_agent_transcript_turns_embedding",
      opClass: "vector_l2_ops",
      declaredIn: "packages/domain/src/storage/schemas/agent-transcript-turns-schema.ts",
    },
    querySites: [
      { file: TRANSCRIPT_SIMILARITY, columnToken: "agentTranscriptTurnsTable.embedding" },
    ],
  },
  {
    name: "agent_transcripts.summary_embedding",
    table: "agent_transcripts",
    column: "summary_embedding",
    index: null,
    unindexed: {
      reason:
        "No HNSW index is declared over agent_transcripts.summary_embedding, so " +
        "findSimilarSession is a sequential scan whichever operator it uses. Noted as " +
        "out of scope by mt#4344; registered here so the absence is asserted rather " +
        "than merely unnoticed.",
      // Same operator as its sibling column so the file speaks one metric, and
      // so an index added later is aligned by default rather than by luck.
      expectedOperator: "<->",
    },
    querySites: [
      { file: TRANSCRIPT_SIMILARITY, columnToken: "agentTranscriptsTable.summaryEmbedding" },
    ],
  },
  sharedLayerNamespace("tasks", "tasks_embeddings"),
  sharedLayerNamespace("rules", "rules_embeddings"),
  sharedLayerNamespace("memory", "memories_embeddings"),
  sharedLayerNamespace("knowledge", "knowledge_embeddings"),
  sharedLayerNamespace("principal-corpus", "principal_corpus_embeddings"),
  sharedLayerNamespace("tools", "tool_embeddings"),
];

// ── Scanning ──────────────────────────────────────────────────────────────────

/**
 * How far past the column token to look for a distance operator. The operator
 * follows the token almost immediately in every real form —
 * `${col} <-> $1::vector`, `${col} <=> ${literal}::vector` — while a
 * non-distance use (`${col} IS NOT NULL`, an INSERT column list) has none
 * within reach. Scanning to end-of-line instead would attribute an operator
 * from a later expression on the same line.
 */
const OPERATOR_LOOKAHEAD_CHARS = 16;

const OPERATOR_PATTERN = /<->|<=>|<#>/;

/** One distance expression found at a query site. */
export interface OperatorUsage {
  file: string;
  /** 1-indexed. */
  line: number;
  /** 0-indexed offset of the operator within its line; the attribution key. */
  operatorIndex: number;
  operator: VectorDistanceOperator;
  /** The trimmed source line, for a finding a reader can act on. */
  snippet: string;
}

/**
 * Every distance expression in a file, regardless of which column it is over.
 *
 * The counterpart to {@link scanOperatorUsages}, which only sees the columns
 * the registry knows to ask about. Comparing the two answers the question a
 * token-driven scan cannot answer on its own — "is there a distance expression
 * here that no registered namespace claims?" — which is the false-negative half
 * of relying on a registry at all (PR #3179 review, NON-BLOCKING).
 *
 * Keyed on `}` + operator: every distance expression in this codebase is built
 * by interpolating a column into a template literal, so the operator always
 * follows an interpolation close. Prose mentions of the operators (this file
 * and the transcript service's header both discuss `<=>` at length) are written
 * inside backticks and never follow a `}`, so they are not matched — which is
 * what lets the check live in the same files it describes.
 */
export function scanDistanceExpressions(source: string, file: string): OperatorUsage[] {
  const found: OperatorUsage[] = [];

  source.split("\n").forEach((lineText, index) => {
    const pattern = /\}\s*(<->|<=>|<#>)/g;
    let match = pattern.exec(lineText);
    while (match) {
      const operator = match[1] as VectorDistanceOperator;
      found.push({
        file,
        line: index + 1,
        operatorIndex: match.index + match[0].length - operator.length,
        operator,
        snippet: lineText.trim(),
      });
      match = pattern.exec(lineText);
    }
  });

  return found;
}

/**
 * Find every distance expression over `columnToken` in `source`.
 *
 * Pure and string-in/string-out so the companion test can feed it a fixture
 * without touching the filesystem or patching a reader.
 */
export function scanOperatorUsages(
  source: string,
  columnToken: string,
  file: string
): OperatorUsage[] {
  const usages: OperatorUsage[] = [];
  const lines = source.split("\n");

  lines.forEach((lineText, index) => {
    let searchFrom = 0;
    for (;;) {
      const tokenAt = lineText.indexOf(columnToken, searchFrom);
      if (tokenAt === -1) break;
      searchFrom = tokenAt + columnToken.length;

      const lookahead = lineText.slice(searchFrom, searchFrom + OPERATOR_LOOKAHEAD_CHARS);
      const match = OPERATOR_PATTERN.exec(lookahead);
      if (match) {
        usages.push({
          file,
          line: index + 1,
          operatorIndex: searchFrom + match.index,
          operator: match[0] as VectorDistanceOperator,
          snippet: lineText.trim(),
        });
      }
    }
  });

  return usages;
}

/** Every opclass name literally present in a schema source. */
export function scanOpClasses(source: string): VectorOpClass[] {
  return ALL_OPCLASSES.filter((opClass) => source.includes(opClass));
}

// ── Checking ──────────────────────────────────────────────────────────────────

export type AlignmentFindingKind =
  /** The query path's operator cannot use the index's operator class. */
  | "operator-opclass-mismatch"
  /** A registered query site no longer contains a distance expression. */
  | "query-site-not-found"
  /** The schema no longer declares the opclass this registry claims. */
  | "opclass-declaration-drift"
  /** A distance expression in a covered file belongs to no registered namespace. */
  | "unattributed-distance-expression";

export interface AlignmentFinding {
  namespace: string;
  kind: AlignmentFindingKind;
  message: string;
}

/** Reads a repo-relative path and returns its contents. */
export type ReadRepoFile = (relativePath: string) => string;

/**
 * The operator a namespace's query paths must use, **as the registry records
 * it**. {@link checkNamespace} prefers the schema file's actual declaration
 * over this when the two disagree — the schema is what Postgres builds the
 * index from, so it is authoritative and the registry is a claim about it.
 */
export function expectedOperatorFor(namespace: VectorNamespace): VectorDistanceOperator {
  if (namespace.index) return OPCLASS_OPERATOR[namespace.index.opClass];
  if (namespace.unindexed) return namespace.unindexed.expectedOperator;
  throw new Error(
    `Vector namespace "${namespace.name}" declares neither an index nor an unindexed rationale. ` +
      "One is required: with no index there is no opclass to derive the expected operator from."
  );
}

/** Check one namespace. Returns an empty array when it is aligned. */
export function checkNamespace(
  namespace: VectorNamespace,
  readFile: ReadRepoFile
): AlignmentFinding[] {
  const findings: AlignmentFinding[] = [];

  // (1) The registry's claim about the schema must still hold — and where the
  //     two disagree, the SCHEMA wins. Deriving the expectation from the
  //     registry instead would let a schema-side opclass change pass every
  //     query-path check as long as nobody updated the registry, which is the
  //     same "nothing ties them together" failure one level up.
  let effectiveOpClass = namespace.index?.opClass;
  if (namespace.index) {
    const declared = scanOpClasses(readFile(namespace.index.declaredIn));
    if (declared.length !== 1 || declared[0] !== namespace.index.opClass) {
      findings.push({
        namespace: namespace.name,
        kind: "opclass-declaration-drift",
        message:
          `${namespace.index.declaredIn} declares [${declared.join(", ") || "no opclass"}], but ` +
          `the registry records ${namespace.index.opClass} for ${namespace.name}. ` +
          "Update VECTOR_NAMESPACES together with the schema, and re-check every query path.",
      });
    }
    if (declared.length === 1 && declared[0]) effectiveOpClass = declared[0];
  }

  const expected = effectiveOpClass
    ? OPCLASS_OPERATOR[effectiveOpClass]
    : expectedOperatorFor(namespace);

  // (2) Each query site must still exist, and must use the expected operator.
  for (const site of namespace.querySites) {
    const usages = scanOperatorUsages(readFile(site.file), site.columnToken, site.file);

    if (usages.length === 0) {
      findings.push({
        namespace: namespace.name,
        kind: "query-site-not-found",
        message:
          `No distance expression over \`${site.columnToken}\` found in ${site.file}. ` +
          "The query path moved or was renamed; update VECTOR_NAMESPACES so this check " +
          "keeps covering it. (Failing here is deliberate — a check that silently stops " +
          "looking is the failure it exists to prevent.)",
      });
      continue;
    }

    for (const usage of usages) {
      if (usage.operator === expected) continue;
      findings.push({
        namespace: namespace.name,
        kind: "operator-opclass-mismatch",
        message:
          `${usage.file}:${usage.line} queries ${namespace.table}.${namespace.column} with ` +
          `\`${usage.operator}\`, but ${describeExpectation(namespace, effectiveOpClass, expected)}. ` +
          "pgvector cannot use the index, so this query silently sequential-scans. " +
          `Source: ${usage.snippet}`,
      });
    }
  }

  return findings;
}

function describeExpectation(
  namespace: VectorNamespace,
  opClass: VectorOpClass | undefined,
  expected: VectorDistanceOperator
): string {
  return namespace.index && opClass
    ? `${namespace.index.indexName} is ${opClass}, which serves \`${expected}\``
    : `this unindexed column is declared to use \`${expected}\``;
}

/**
 * Every distance expression in a registered query file must belong to some
 * registered namespace.
 *
 * Without this, adding a new vector query over an UNREGISTERED column inside an
 * already-covered file is invisible: the per-namespace scan asks only about the
 * column tokens it already knows, so a new one is not "unmatched", it is
 * unasked-about. That is the same silence this whole module exists to break,
 * one level in — so it fails rather than passing quietly.
 */
export function checkQueryFileCoverage(
  file: string,
  columnTokens: readonly string[],
  readFile: ReadRepoFile
): AlignmentFinding[] {
  const source = readFile(file);
  const attributed = new Set(
    columnTokens
      .flatMap((token) => scanOperatorUsages(source, token, file))
      .map((usage) => `${usage.line}:${usage.operatorIndex}`)
  );

  return scanDistanceExpressions(source, file)
    .filter((expr) => !attributed.has(`${expr.line}:${expr.operatorIndex}`))
    .map((expr) => ({
      namespace: file,
      kind: "unattributed-distance-expression" as const,
      message:
        `${expr.file}:${expr.line} contains a \`${expr.operator}\` distance expression that no ` +
        "registered vector namespace claims. Either register the column it queries in " +
        "VECTOR_NAMESPACES, or the operator here is unchecked against any index. " +
        `Source: ${expr.snippet}`,
    }));
}

/** Check every namespace. An empty array means every vector index is usable. */
export function checkVectorOperatorAlignment(
  readFile: ReadRepoFile,
  namespaces: readonly VectorNamespace[] = VECTOR_NAMESPACES
): AlignmentFinding[] {
  const namespaceFindings = namespaces.flatMap((namespace) => checkNamespace(namespace, readFile));

  // One sweep per distinct query file, with the union of every token any
  // namespace registers for it — several namespaces can share a file.
  const tokensByFile = new Map<string, Set<string>>();
  for (const namespace of namespaces) {
    for (const site of namespace.querySites) {
      const tokens = tokensByFile.get(site.file) ?? new Set<string>();
      tokens.add(site.columnToken);
      tokensByFile.set(site.file, tokens);
    }
  }

  const coverageFindings = [...tokensByFile].flatMap(([file, tokens]) =>
    checkQueryFileCoverage(file, [...tokens], readFile)
  );

  return [...namespaceFindings, ...coverageFindings];
}

/** Render findings for a test failure message or a CLI report. */
export function formatFindings(findings: readonly AlignmentFinding[]): string {
  if (findings.length === 0) return "All vector namespaces aligned.";
  return findings
    .map((finding) => `- [${finding.kind}] ${finding.namespace}: ${finding.message}`)
    .join("\n");
}
