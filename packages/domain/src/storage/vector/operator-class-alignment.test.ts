/**
 * Tests for the vector operator-class alignment check (mt#4344).
 *
 * The check reads the repo's own source, so these tests do two distinct jobs
 * and both are load-bearing:
 *
 * 1. **Real binding** — run the check over the ACTUAL working tree and assert
 *    zero findings. This is the regression test: reintroduce `<=>` against an
 *    `vector_l2_ops` index anywhere registered, and this fails.
 * 2. **The check can fail** — feed it deliberately mismatched sources and
 *    assert it fires. A guard that cannot fail is decoration (mt#4344's own
 *    acceptance test says so). These use an injected reader rather than
 *    mutating the tree, so the "revert" is structural instead of remembered.
 */

/* eslint-disable custom/no-real-fs-in-tests --
 * This suite's SUBJECT is the real source tree. The check under test answers
 * "does the operator written in THIS repo's source match the opclass declared
 * in THIS repo's schema"; served from an in-memory fixture it would assert only
 * that the scanner works on strings someone typed — which is exactly the shape
 * of check that passes while a 1,044 MB index sits unusable (mt#4344).
 *
 * The rule's actual targets are absent: nothing is written, no `tmpdir()`, no
 * timestamp-unique paths, so none of the parallel-test races it exists to
 * prevent are reachable. This is a read-only walk over tracked files, the same
 * disposition `tests/unit/hook-tree-import-boundary.test.ts` records.
 *
 * The failure cases below DO use an injected reader — the fs reads are confined
 * to the real-binding assertions, where nothing else can stand in.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import {
  VECTOR_NAMESPACES,
  OPCLASS_OPERATOR,
  checkNamespace,
  checkQueryFileCoverage,
  checkVectorOperatorAlignment,
  scanDistanceExpressions,
  expectedOperatorFor,
  formatFindings,
  scanOperatorUsages,
  scanOpClasses,
  type AlignmentFindingKind,
  type ReadRepoFile,
  type VectorNamespace,
} from "./operator-class-alignment";
import { EMBEDDINGS_CONFIGS } from "../schemas/embeddings-schema-factory";

// packages/domain/src/storage/vector -> repo root
const REPO_ROOT = resolve(import.meta.dir, "../../../../..");

const readRepoFile: ReadRepoFile = (relativePath) =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8");

/** A reader that rewrites one registered file's contents on the way through. */
function readerWithRewrite(file: string, rewrite: (source: string) => string): ReadRepoFile {
  return (relativePath) => {
    const source = readRepoFile(relativePath);
    return relativePath === file ? rewrite(source) : source;
  };
}

function namespaceNamed(name: string): VectorNamespace {
  const found = VECTOR_NAMESPACES.find((ns) => ns.name === name);
  if (!found) throw new Error(`No registered vector namespace named "${name}"`);
  return found;
}

const TRANSCRIPT_SIMILARITY = "packages/domain/src/transcripts/transcript-similarity-service.ts";
const SHARED_VECTOR_LAYER = "packages/domain/src/storage/vector/postgres-vector-storage.ts";
const TURNS_NAMESPACE = "agent_transcript_turns";
const TURNS_COLUMN_TOKEN = "agentTranscriptTurnsTable.embedding";
const SUMMARY_COLUMN_TOKEN = "agentTranscriptsTable.summaryEmbedding";
const MISMATCH: AlignmentFindingKind = "operator-opclass-mismatch";

// ── 1. Real binding: the working tree is aligned ─────────────────────────────

describe("checkVectorOperatorAlignment — against the real working tree", () => {
  test("every registered vector namespace's query operator matches its index opclass", () => {
    const findings = checkVectorOperatorAlignment(readRepoFile);
    expect(formatFindings(findings)).toBe("All vector namespaces aligned.");
    expect(findings).toEqual([]);
  });

  test("counter-case: tasks_embeddings is L2-indexed and L2-queried, and does NOT fire", () => {
    // mt#4344's acceptance test names this explicitly: a guard that flags the
    // working namespaces is mis-tuned. tasks_embeddings had 3,594 lifetime
    // index scans — it is the proof that L2/L2 is the healthy state, not a
    // symptom to be "fixed".
    const findings = checkNamespace(namespaceNamed("tasks"), readRepoFile);
    expect(findings).toEqual([]);
  });

  test("counter-case: every shared-layer namespace passes, not just tasks", () => {
    const sharedLayerNamespaces = VECTOR_NAMESPACES.filter((ns) =>
      ns.querySites.some((site) => site.file === SHARED_VECTOR_LAYER)
    );
    expect(sharedLayerNamespaces.length).toBe(6);
    for (const ns of sharedLayerNamespaces) {
      expect(checkNamespace(ns, readRepoFile)).toEqual([]);
    }
  });

  test("the transcript path — the one that diverged — now uses <-> at every site", () => {
    const source = readRepoFile(TRANSCRIPT_SIMILARITY);
    const turnUsages = scanOperatorUsages(source, TURNS_COLUMN_TOKEN, TRANSCRIPT_SIMILARITY);
    const summaryUsages = scanOperatorUsages(source, SUMMARY_COLUMN_TOKEN, TRANSCRIPT_SIMILARITY);

    // search() + findSimilarTurn() over the turns column; findSimilarSession()
    // over the session summary column. Three distance expressions in all —
    // the exact three sites mt#4344 names.
    expect(turnUsages.map((u) => u.operator)).toEqual(["<->", "<->"]);
    expect(summaryUsages.map((u) => u.operator)).toEqual(["<->"]);
  });
});

// ── 2. The check can fail ────────────────────────────────────────────────────

describe("checkVectorOperatorAlignment — fires on a deliberate mismatch", () => {
  test("reintroducing the mt#4344 defect (<=> on the L2-indexed turns column) fires", () => {
    // This reader reproduces the pre-fix source exactly: cosine operator,
    // vector_l2_ops index. That state shipped and sat undetected for the
    // table's whole lifetime.
    const reader = readerWithRewrite(TRANSCRIPT_SIMILARITY, (source) =>
      source.replaceAll(
        "agentTranscriptTurnsTable.embedding} <->",
        "agentTranscriptTurnsTable.embedding} <=>"
      )
    );

    const findings = checkNamespace(namespaceNamed(TURNS_NAMESPACE), reader);

    expect(findings.length).toBe(2); // both turn-column sites
    for (const finding of findings) {
      expect(finding.kind).toBe(MISMATCH);
      expect(finding.namespace).toBe(TURNS_NAMESPACE);
      expect(finding.message).toContain("idx_agent_transcript_turns_embedding");
      expect(finding.message).toContain("vector_l2_ops");
      expect(finding.message).toContain("`<=>`");
    }
  });

  test("a mismatch in the SHARED layer fires for all six namespaces that use it", () => {
    const reader = readerWithRewrite(SHARED_VECTOR_LAYER, (source) =>
      source.replaceAll("this.config.embeddingColumn} <->", "this.config.embeddingColumn} <=>")
    );

    const findings = checkVectorOperatorAlignment(reader);
    const affected = new Set(findings.map((f) => f.namespace));

    // The blast radius is the point: one hardcoded operator in the shared
    // layer governs every domain routed through it.
    expect(affected).toEqual(
      new Set(["tasks", "rules", "memory", "knowledge", "principal-corpus", "tools"])
    );
    expect(findings.every((f) => f.kind === MISMATCH)).toBe(true);
  });

  test("flipping the schema's opclass without touching the query fires as drift", () => {
    const reader = readerWithRewrite(
      "packages/domain/src/storage/schemas/agent-transcript-turns-schema.ts",
      (source) => source.replaceAll("vector_l2_ops", "vector_cosine_ops")
    );

    const findings = checkNamespace(namespaceNamed(TURNS_NAMESPACE), reader);
    const kinds = findings.map((f) => f.kind);

    // Both halves fire: the registry no longer describes the schema, AND the
    // query path no longer matches the schema's new opclass.
    expect(kinds).toContain("opclass-declaration-drift");
    expect(kinds).toContain("operator-opclass-mismatch");
  });

  test("a query site that moved or was renamed fires rather than silently passing", () => {
    const reader = readerWithRewrite(TRANSCRIPT_SIMILARITY, (source) =>
      source.replaceAll("agentTranscriptTurnsTable.embedding", "renamedTurnsTable.vec")
    );

    const findings = checkNamespace(namespaceNamed(TURNS_NAMESPACE), reader);

    expect(findings.length).toBe(1);
    expect(findings[0]?.kind).toBe("query-site-not-found");
  });
});

// ── 3. The registry cannot silently under-cover ──────────────────────────────

describe("VECTOR_NAMESPACES coverage", () => {
  test("every embeddings table in EMBEDDINGS_CONFIGS is registered", () => {
    const registered = new Set(VECTOR_NAMESPACES.map((ns) => ns.table));
    for (const config of Object.values(EMBEDDINGS_CONFIGS)) {
      expect(registered.has(config.tableName)).toBe(true);
    }
  });

  test("covers the six shared-layer tables plus both transcript vector columns", () => {
    // mt#4344 names six namespaces; `tool_embeddings` is a seventh that the
    // shared layer serves identically, and agent_transcripts.summary_embedding
    // is an eighth vector column with no index at all. Covering more than the
    // spec enumerated is deliberate — the enumeration was of what prod had
    // indexes for, not of what the code can query.
    expect(VECTOR_NAMESPACES.length).toBe(Object.keys(EMBEDDINGS_CONFIGS).length + 2);
  });

  test("each namespace declares either an index or an explicit unindexed rationale", () => {
    for (const ns of VECTOR_NAMESPACES) {
      // Throws when neither is declared — which is the assertion.
      expect(Object.values(OPCLASS_OPERATOR)).toContain(expectedOperatorFor(ns));
      if (!ns.index) {
        expect(ns.unindexed?.reason.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test("exactly one registered column is unindexed, and it is the session summary", () => {
    const unindexed = VECTOR_NAMESPACES.filter((ns) => ns.index === null);
    expect(unindexed.map((ns) => ns.name)).toEqual(["agent_transcripts.summary_embedding"]);
  });
});

// ── 4. Scanner behavior ──────────────────────────────────────────────────────

describe("scanOperatorUsages", () => {
  test("ignores column references that are not distance expressions", () => {
    const source = [
      "conditions.push(sql`${table.embedding} IS NOT NULL`);",
      "const expr = sql`${table.embedding} <-> ${literal}::vector`;",
      "const cols = `${table.embedding}, ${table.metadata}`;",
    ].join("\n");

    const usages = scanOperatorUsages(source, "table.embedding", "fixture.ts");

    expect(usages.map((u) => u.operator)).toEqual(["<->"]);
    expect(usages[0]?.line).toBe(2);
  });

  test("does not attribute an operator from a later expression on the same line", () => {
    // The lookahead window is what keeps `IS NOT NULL` from borrowing the
    // operator of a distance expression further along the line.
    const source = "sql`${a.embedding} IS NOT NULL AND ${b.embedding} <=> $1::vector`";

    expect(scanOperatorUsages(source, "a.embedding", "fixture.ts")).toEqual([]);
    expect(scanOperatorUsages(source, "b.embedding", "fixture.ts").map((u) => u.operator)).toEqual([
      "<=>",
    ]);
  });

  test("finds every occurrence when one line carries several", () => {
    const source = "ORDER BY ${c.vec} <-> $1::vector, ${c.vec} <-> $2::vector";
    expect(scanOperatorUsages(source, "c.vec", "fixture.ts").length).toBe(2);
  });
});

// ── 5. Unattributed-expression sweep (PR #3179 review, NON-BLOCKING) ─────────

describe("checkQueryFileCoverage", () => {
  test("every distance expression in the real query files is claimed by a namespace", () => {
    // The complement of the per-namespace scan: that one can only see columns
    // the registry knows to ask about, so a NEW query over an unregistered
    // column in a covered file would be unasked-about rather than unmatched.
    const findings = checkVectorOperatorAlignment(readRepoFile).filter(
      (f) => f.kind === "unattributed-distance-expression"
    );
    expect(findings).toEqual([]);
  });

  test("prose discussing the operators is not mistaken for a query", () => {
    // Both real files discuss `<=>` at length in their headers. Backticked
    // prose never follows an interpolation close, which is what lets the check
    // live in the files it describes.
    const proseHeavy = [
      " * Why these queries use `<->` (L2) and not `<=>` (cosine).",
      " * Ranking by `<->` and by `<=>` gives an identical top-10.",
    ].join("\n");
    expect(scanDistanceExpressions(proseHeavy, "fixture.ts")).toEqual([]);
  });

  test("a new distance expression over an UNREGISTERED column fires", () => {
    const reader = readerWithRewrite(
      TRANSCRIPT_SIMILARITY,
      (source) =>
        `${source}\n// added later:\nconst d = sql\`\${someOtherTable.newVector} <=> \${lit}::vector\`;\n`
    );

    const findings = checkQueryFileCoverage(
      TRANSCRIPT_SIMILARITY,
      [TURNS_COLUMN_TOKEN, SUMMARY_COLUMN_TOKEN],
      reader
    );

    expect(findings.length).toBe(1);
    expect(findings[0]?.kind).toBe("unattributed-distance-expression");
    expect(findings[0]?.message).toContain("someOtherTable.newVector");
  });

  test("attribution is positional, so two expressions on one line are told apart", () => {
    const source = "sql`${a.vec} <-> $1::vector, ${b.vec} <=> $2::vector`";
    const findings = checkQueryFileCoverage("fixture.ts", ["a.vec"], () => source);

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain("`<=>`");
  });
});

describe("scanOpClasses", () => {
  test("reports only the opclasses literally present", () => {
    expect(scanOpClasses('table.vector.op("vector_l2_ops")')).toEqual(["vector_l2_ops"]);
    expect(scanOpClasses("no opclass here")).toEqual([]);
  });
});
