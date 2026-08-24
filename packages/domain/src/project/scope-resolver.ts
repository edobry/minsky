/**
 * Slug→uuid scope resolver for project-scoped queries (ADR-021, mt#2416).
 *
 * Takes the output of `resolveProjectIdentity()` (a slug string) and looks up
 * the corresponding `projects` table uuid. When the identity is unidentified OR
 * no matching row exists, returns the `ALL_PROJECTS` sentinel so callers see
 * cross-project rows (the "unidentified→ALL" default from ADR-021 §Decision).
 *
 * ## Narrow DB interface
 * Uses the same `MinskyBackendDb` narrow-interface pattern as minskyTaskBackend
 * so tests can inject fakes without unsafe casts.
 *
 * ## Fail-open, but not fail-silent (mt#4509)
 * ADR-021 chose fail-open for ONE case: an unidentified project identity. Three other
 * outcomes reach the same `ALL_PROJECTS` return and are NOT that case — an expected miss,
 * a malformed db handle (a programming error), and a failed query (an infrastructure
 * problem). Every one of them used to render as the same warning.
 *
 * That is what made mt#4509 expensive. A `TypeError` ran unnoticed for two months across
 * every project-scoped memory and transcript read, because its log line was indistinguishable
 * from the routine "no such project" miss: 179 occurrences of a real defect looked exactly
 * like normal operation, and the task was ultimately filed against the wrong file on the
 * strength of that line.
 *
 * So the resolution is modelled as a {@link ScopeResolutionOutcome} and rendered by
 * {@link describeScopeResolution} — a pure function this module's tests assert directly,
 * rather than by capturing the logger (the mt#3628 pattern).
 */

import { eq } from "drizzle-orm";
import { ALL_PROJECTS, type ProjectScope } from "./scope";
import type { ProjectIdentity } from "./identity";
import { projectsTable } from "../storage/schemas/projects-schema";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Narrow DB interface
// ---------------------------------------------------------------------------

export interface ScopeResolverDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
}

/**
 * Does `value` actually carry the one method {@link resolveProjectScope} calls?
 *
 * Every call site acquires its handle from `PersistenceProvider.getDatabaseConnection()`,
 * typed `Promise<unknown>`, and asserts it into `ScopeResolverDb` with a cast. A cast
 * ASSERTS a capability rather than checking one, so this is where the checking happens.
 *
 * The failure it guards is neither hypothetical nor provider-shaped: two call sites copied
 * the handle with an object rest-spread (`const { type: _t, ...db } = rawDb`), which drops
 * `select` because drizzle defines it on the prototype rather than as an own enumerable
 * property. The copy keeps every data field and loses every method (mt#4509).
 */
export function isScopeResolverDb(value: unknown): value is ScopeResolverDb {
  return typeof (value as ScopeResolverDb | null | undefined)?.select === "function";
}

// ---------------------------------------------------------------------------
// Outcome model (the functional core)
// ---------------------------------------------------------------------------

/**
 * What actually happened during one resolution attempt.
 *
 * Four of the five variants return `ALL_PROJECTS` — that is ADR-021's fail-open posture and
 * it is preserved exactly. The variants exist so the three failure modes can be TOLD APART
 * by whoever reads the log, which is the half that was missing.
 */
export type ScopeResolutionOutcome =
  | { kind: "resolved"; slug: string; projectId: string }
  | { kind: "unidentified"; reason: string }
  | { kind: "no-row"; slug: string }
  | { kind: "invalid-db-handle"; slug: string; received: string }
  | { kind: "query-failed"; slug: string; error: string };

/** A log line, as data — so a test can assert it without a logger. */
export interface ScopeResolutionLogLine {
  level: "debug" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Every outcome except `resolved` yields `ALL_PROJECTS`.
 *
 * Extracted and exported so the fail-open contract ADR-021 committed to is asserted
 * directly, rather than inferred from the resolver's control flow.
 */
export function scopeFromOutcome(outcome: ScopeResolutionOutcome): ProjectScope {
  return outcome.kind === "resolved" ? outcome.projectId : ALL_PROJECTS;
}

/**
 * Render an outcome as a log line: level, message, and structured context.
 *
 * The three failure kinds get three different levels and three different `failureKind`
 * values. A programming error is not a warning about missing data, and an outage is not
 * either — collapsing them is the mt#4509 defect, so the split is asserted in this module's
 * tests rather than left to the reader of the call site.
 */
export function describeScopeResolution(
  outcome: ScopeResolutionOutcome,
  caller: string
): ScopeResolutionLogLine {
  switch (outcome.kind) {
    case "unidentified":
      return {
        level: "debug",
        message: `[project-scope] Unidentified project identity (${outcome.reason}); defaulting to ALL_PROJECTS`,
      };

    case "resolved":
      return {
        level: "debug",
        message: `[project-scope] Resolved slug "${outcome.slug}" to project id "${outcome.projectId}"`,
      };

    case "no-row":
      return {
        level: "debug",
        message: `[project-scope] No project row found for slug "${outcome.slug}"; defaulting to ALL_PROJECTS`,
      };

    case "invalid-db-handle":
      return {
        level: "error",
        message: `[project-scope] Invalid db handle from "${caller}": no .select() method; defaulting to ALL_PROJECTS`,
        context: {
          caller,
          slug: outcome.slug,
          failureKind: "invalid-db-handle",
          received: outcome.received,
        },
      };

    case "query-failed":
      return {
        level: "warn",
        message: `[project-scope] Query failed resolving slug "${outcome.slug}" from "${caller}"; defaulting to ALL_PROJECTS`,
        context: {
          caller,
          slug: outcome.slug,
          failureKind: "query-failed",
          error: outcome.error,
        },
      };
  }
}

/**
 * A shape-only description of a rejected handle, for the invalid-db-handle log.
 *
 * Constructor name plus the own-key list, and deliberately no values — a handle carries
 * connection config. The own-key list is the diagnostic that matters here: a drizzle handle
 * flattened by an object spread keeps its data keys (`query`, `dialect`, `session`, …) and
 * loses its methods, so seeing those keys beside a missing `select` names the defect outright.
 */
export function describeHandle(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  const ctor = (value as object).constructor?.name ?? "Object";
  return `${ctor} with own keys [${Object.keys(value as object).join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Slug → uuid lookup
// ---------------------------------------------------------------------------

/**
 * The lookup itself, as a function of (identity, db) with no logging.
 *
 * Exported so the guard above has an assertion that can actually FAIL when it is removed.
 * Through `resolveProjectScope` alone it cannot: a handle without `select` throws inside the
 * `try`, the catch converts it to `query-failed`, and the return value is `ALL_PROJECTS`
 * either way — so a return-value test passes with the guard deleted. The guard's whole
 * contribution is the CLASSIFICATION, so the classification is what has to be observable.
 */
export async function resolveScopeOutcome(
  identity: ProjectIdentity,
  db: ScopeResolverDb
): Promise<ScopeResolutionOutcome> {
  if (identity.kind === "unidentified") {
    return { kind: "unidentified", reason: identity.reason };
  }

  const { slug } = identity;

  if (!isScopeResolverDb(db)) {
    return { kind: "invalid-db-handle", slug, received: describeHandle(db) };
  }

  try {
    const rows = await db.select().from(projectsTable).where(eq(projectsTable.slug, slug)).limit(1);

    const row = rows[0];
    if (!row) return { kind: "no-row", slug };

    return { kind: "resolved", slug, projectId: row.id as string };
  } catch (err) {
    return { kind: "query-failed", slug, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve a `ProjectIdentity` to a `ProjectScope` suitable for domain read methods.
 *
 * - Resolved identity with a slug → query `projects` table for the uuid.
 *   - Found → return the uuid.
 *   - Not found → return `ALL_PROJECTS` (no matching project row; preserve today's behavior).
 * - Unidentified identity → return `ALL_PROJECTS` (fail-open per ADR-021).
 *
 * Never throws. All error paths return `ALL_PROJECTS` so callers get an
 * unscoped read rather than a crash.
 *
 * @param caller A short label for the call site, carried into every failure log. The resolver
 *   has a dozen production callers and its warning used to name none of them, which is how
 *   mt#4509 came to be filed against the wrong file on the strength of its own log line.
 */
export async function resolveProjectScope(
  identity: ProjectIdentity,
  db: ScopeResolverDb,
  caller = "unknown"
): Promise<ProjectScope> {
  const outcome = await resolveScopeOutcome(identity, db);
  const line = describeScopeResolution(outcome, caller);
  log[line.level](line.message, line.context);
  return scopeFromOutcome(outcome);
}
