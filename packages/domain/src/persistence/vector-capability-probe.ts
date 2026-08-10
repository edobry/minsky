/**
 * Reading the pgvector capability probe's answer (mt#3833).
 *
 * `PostgresProviderFactory` asks the catalog whether the `vector` extension is
 * installed and picks a provider from the answer. That question has THREE
 * answers, and the factory collapsed them into two:
 *
 *     const hasVectorExtension = result[0]?.exists ?? false;
 *
 * `?? false` turns "the probe did not answer" into "the extension is absent" —
 * absence of evidence rendered as evidence of absence. The resulting provider is
 * a perfectly ordinary `PostgresPersistenceProvider`, constructed successfully,
 * which the container then memoizes for the process's whole lifetime. Nothing
 * retries it, because nothing failed.
 *
 * That is the same defect ADR-035 records
 * (`adr-035-failed-initializer-must-not-be-memoized-as-a-value.md`, whose
 * Instance 3 is this very subsystem) one level down. ADR-035's rules are keyed
 * on an initialization FAILURE, and its container retry is "populated only on a
 * throw" — so this path, which throws nothing, sits just outside their reach.
 * Observed 2026-08-07/08: the MCP server booted during a Supabase-pooler outage
 * and served a non-vector provider for its entire life, including long after the
 * pooler recovered; `tasks_search`, `tasks_similar` and `memory_search` all
 * failed with `does not support vector storage` until someone restarted it.
 *
 * Naming follows `connection-failure.ts`: the outcomes are named for the
 * OBSERVATION, not for a remedy, and the third is deliberately distinct from a
 * guess rather than folded into the negative.
 */

/** What the catalog probe actually told us. */
export type VectorProbeOutcome =
  /** The catalog reported the extension present. */
  | "present"
  /** The catalog reported, explicitly, that the extension is not installed. */
  | "absent"
  /**
   * The probe returned something we cannot read as either answer — no row, or a
   * row whose `exists` is missing or not a boolean.
   *
   * This is NOT "absent". A database without pgvector answers `[{exists: false}]`,
   * which is a fact; this is the absence of a fact, and the two must not share a
   * branch.
   */
  | "inconclusive";

/**
 * Classify the probe's result set.
 *
 * Deliberately strict about the boolean: a driver returning `"f"`, `0`, `null`,
 * or nothing at all is not asserting that pgvector is missing, and reading any
 * of those as `false` is precisely the collapse this module exists to prevent.
 */
export function classifyVectorProbe(rows: unknown): VectorProbeOutcome {
  if (!Array.isArray(rows)) return "inconclusive";
  const first: unknown = rows[0];
  if (typeof first !== "object" || first === null) return "inconclusive";
  const value: unknown = (first as { exists?: unknown }).exists;
  if (value === true) return "present";
  if (value === false) return "absent";
  return "inconclusive";
}

/**
 * Raised when the probe could not be read either way.
 *
 * Throwing is the FIRST remedy ADR-035 rule 1 names — "propagate the failure, so
 * the container's existing `bootDeferrable` path memoizes it _as a failure_ and
 * `get()` re-attempts" — and it is the one that needs no new retry machinery.
 * The alternative the rule permits (register the degraded provider AND arm its
 * retry in the same act) would mean re-deriving a retry the container already
 * implements, which the ADR names as the symptom it exists to retire.
 *
 * The message names the PROBE, not the database. `Persistence provider Zf does
 * not support vector storage` — the error callers actually saw for a day — reads
 * as a statement about the database's capabilities and was a statement about one
 * unanswered query.
 */
export class VectorCapabilityProbeInconclusiveError extends Error {
  constructor(rowsDescription: string) {
    super(
      "pgvector capability probe was inconclusive: the catalog query returned " +
        `${rowsDescription}, which asserts neither that the extension is present nor ` +
        "that it is absent. Refusing to construct a provider whose vector capability " +
        "would be a guess cached for the process lifetime (mt#3833). This is retryable — " +
        "the container re-attempts initialization rather than serving a silently " +
        "downgraded provider."
    );
    this.name = "VectorCapabilityProbeInconclusiveError";
  }
}

/**
 * A short, non-leaking description of what came back, for the error message.
 *
 * Row CONTENTS are deliberately excluded — this runs against the production
 * database and the message lands in logs and health payloads.
 */
export function describeProbeRows(rows: unknown): string {
  if (!Array.isArray(rows)) return `a non-array result (${typeof rows})`;
  if (rows.length === 0) return "zero rows";
  const first: unknown = rows[0];
  if (typeof first !== "object" || first === null) {
    return `${rows.length} row(s) whose first element is ${typeof first}`;
  }
  const value: unknown = (first as { exists?: unknown }).exists;
  return value === undefined
    ? `${rows.length} row(s) with no 'exists' column`
    : `${rows.length} row(s) whose 'exists' is ${typeof value}, not boolean`;
}
