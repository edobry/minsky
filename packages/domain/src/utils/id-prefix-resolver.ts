/**
 * UUID prefix resolution — shared helper for uuid-keyed single-record lookups.
 *
 * Session handoffs cite durable-artifact ids (memories, asks) by an 8-char
 * short prefix, git-short-SHA style (e.g. "memory d8591800"). The uuid-keyed
 * get/lookup tools (`memory.get`, `asks.respond`, `asks.edit`,
 * `asks.wait-for-response`, ...) historically passed that id straight to a
 * Postgres `uuid` column, which throws a raw
 * `invalid input syntax for type uuid` error for anything shorter than a
 * full UUID. This module resolves a prefix (or a full UUID, passed through
 * unchanged) to the target row's full id — unique match, clean not-found, or
 * an ambiguity error listing candidates — WITHOUT ever handing a malformed
 * or partial value to a `uuid`-typed column comparison.
 *
 * Safety invariant: malformed input never reaches a raw uuid cast. Full
 * UUIDs are recognized syntactically and passed through without a query
 * (the downstream `eq(idColumn, id)` comparison is safe because the value is
 * already known to be a well-formed UUID string). Everything else is
 * resolved via a `<column>::text LIKE '<prefix>%'` query — a text
 * comparison, never a uuid cast — so a short, malformed, or non-existent
 * value can only ever produce a "not found" / "ambiguous" / "invalid"
 * result, never a Postgres syntax error.
 *
 * @see mt#2696 — this module's originating task
 */

import { sql } from "drizzle-orm";

/** Minimum prefix length accepted for a prefix-resolution lookup. */
export const MIN_ID_PREFIX_LENGTH = 8;

/** Maximum number of candidates listed in an ambiguity error. */
const MAX_AMBIGUOUS_CANDIDATES = 10;

/** Canonical (lowercase, dashed) UUID shape — matched to detect full-UUID passthrough. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A hex-or-dash fragment — the only shape eligible for a prefix LIKE query. */
const HEX_FRAGMENT_RE = /^[0-9a-f-]+$/i;

// ---------------------------------------------------------------------------
// Pure classification helpers (unit-testable without a DB)
// ---------------------------------------------------------------------------

/** Outcome of classifying a raw id-input string, before any DB lookup. */
export type IdInputClassification =
  | { kind: "resolved"; id: string }
  | { kind: "invalid"; reason: string }
  | { kind: "prefix"; normalized: string };

/**
 * Classify a raw id-input string:
 *  - a full, well-formed UUID resolves immediately (no DB round-trip needed;
 *    downstream `eq()` comparisons against it are always cast-safe)
 *  - too-short or non-hex input is rejected as invalid before it can ever
 *    reach a query
 *  - everything else is a candidate prefix, normalized to lowercase, for the
 *    caller to run through `queryPrefixCandidates`
 */
export function classifyIdInput(
  input: string,
  minPrefixLength: number = MIN_ID_PREFIX_LENGTH
): IdInputClassification {
  const trimmed = (input ?? "").trim();

  if (!trimmed) {
    return { kind: "invalid", reason: "id must not be empty" };
  }

  if (UUID_RE.test(trimmed)) {
    return { kind: "resolved", id: trimmed.toLowerCase() };
  }

  if (trimmed.length < minPrefixLength) {
    return {
      kind: "invalid",
      reason:
        `id prefix must be at least ${minPrefixLength} characters (or a full UUID); ` +
        `got ${trimmed.length}`,
    };
  }

  if (!HEX_FRAGMENT_RE.test(trimmed)) {
    return {
      kind: "invalid",
      reason: `id prefix must be hexadecimal (0-9, a-f, with optional dashes); got "${trimmed}"`,
    };
  }

  return { kind: "prefix", normalized: trimmed.toLowerCase() };
}

/** A single candidate row surfaced when a prefix matches more than one record. */
export interface PrefixCandidate {
  id: string;
  /** Human-readable label (name/title) for disambiguation in error messages. */
  label?: string;
}

/** Outcome of resolving a set of prefix-matched candidate rows against the input. */
export type PrefixCandidateResolution =
  | { kind: "resolved"; id: string }
  | { kind: "not_found"; input: string }
  | {
      kind: "ambiguous";
      input: string;
      /** Candidates shown in the error, capped at `MAX_AMBIGUOUS_CANDIDATES`. */
      candidates: PrefixCandidate[];
      /**
       * TRUE total number of matching rows, which may exceed `candidates.length`
       * when the match count is truncated to `MAX_AMBIGUOUS_CANDIDATES`. Callers
       * MUST report this value (not `candidates.length`) as "how many records
       * match" — reporting the truncated length as the total is misleading
       * (e.g. "matches 10 records" when 23 actually matched).
       */
      totalCount: number;
    };

/**
 * Resolve a prefix-matched candidate list to a single id, given zero, one, or
 * many rows returned by the `<column>::text LIKE '<prefix>%'` query. Pure —
 * takes the already-fetched candidate list, does not perform I/O — so tests
 * can exercise the unique/ambiguous/not-found branches directly.
 */
export function resolveCandidates(
  candidates: PrefixCandidate[],
  input: string
): PrefixCandidateResolution {
  if (candidates.length === 0) {
    return { kind: "not_found", input };
  }
  if (candidates.length === 1) {
    // Non-null assertion avoided: length check above guarantees index 0 exists.
    const only = candidates[0];
    return { kind: "resolved", id: only ? only.id : input };
  }
  return {
    kind: "ambiguous",
    input,
    candidates: candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES),
    totalCount: candidates.length,
  };
}

// ---------------------------------------------------------------------------
// Overall resolution result + error shaping
// ---------------------------------------------------------------------------

export type IdPrefixResolution =
  | { kind: "resolved"; id: string }
  | { kind: "not_found"; input: string }
  | { kind: "ambiguous"; input: string; candidates: PrefixCandidate[]; totalCount: number }
  | { kind: "invalid"; input: string; reason: string };

/**
 * Render a non-"resolved" `IdPrefixResolution` as a clean, tool-level Error
 * (never a raw Postgres/Drizzle error). `entityName` is a lowercase noun
 * used in the message, e.g. "memory", "ask".
 */
export function idPrefixResolutionError(entityName: string, resolution: IdPrefixResolution): Error {
  switch (resolution.kind) {
    case "not_found":
      return new Error(`${capitalize(entityName)} not found: "${resolution.input}"`);
    case "invalid":
      return new Error(`Invalid ${entityName} id "${resolution.input}": ${resolution.reason}`);
    case "ambiguous": {
      const { candidates, totalCount, input } = resolution;
      const list = candidates.map((c) => `  - ${c.id}${c.label ? ` (${c.label})` : ""}`).join("\n");
      // Report the TRUE total, not the (possibly truncated) shown-candidate
      // count — "matches 10 records" when 23 actually matched is misleading.
      const summary =
        candidates.length < totalCount
          ? `${totalCount} ${entityName} records match id prefix "${input}" — showing first ${candidates.length}:`
          : `Ambiguous ${entityName} id prefix "${input}" matches ${totalCount} record(s):`;
      return new Error(`${summary}\n${list}\nUse a longer prefix or the full id.`);
    }
    case "resolved":
      // Programmer error: the caller already has a resolved id and should use
      // it directly instead of routing it through error-shaping. Reaching
      // this branch means `idPrefixResolutionError` was called without first
      // checking `.kind === "resolved"` on the resolution it was given.
      throw new Error(
        "idPrefixResolutionError: called with an already-resolved IdPrefixResolution " +
          `(id "${resolution.id}") — check \`.kind === "resolved"\` before calling ` +
          "idPrefixResolutionError; this function is only for non-resolved outcomes."
      );
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// DB-backed resolution
// ---------------------------------------------------------------------------

/**
 * Narrow Drizzle surface needed to run the prefix-candidate query. Matches
 * the same narrow-interface convention as `MemoryServiceDb` — avoids
 * `as unknown as PostgresJsDatabase` casts at call sites while still being
 * satisfied structurally by the real `PostgresJsDatabase`.
 */
export interface IdPrefixResolverDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
}

export interface ResolveIdPrefixOptions {
  db: IdPrefixResolverDb;
  /** The Drizzle table to query (passed to `.from()`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** The uuid primary-key column (e.g. `memoriesTable.id`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idColumn: any;
  /** Optional human-readable label column shown in ambiguity errors (e.g. `.name` / `.title`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  labelColumn?: any;
  /** Raw id or id-prefix input from the caller. */
  input: string;
  /** Lowercase entity noun used in error messages, e.g. "memory", "ask". */
  entityName: string;
  minPrefixLength?: number;
}

/**
 * Resolve a raw id-or-prefix input to a full uuid.
 *
 * - Full, well-formed UUID → passthrough, no query.
 * - Too-short / non-hex input → `{ kind: "invalid" }`, no query.
 * - Otherwise → `<idColumn>::text LIKE '<prefix>%'` (a TEXT comparison, never
 *   a uuid cast) → zero rows: not_found; one row: resolved; 2+ rows: ambiguous.
 */
export async function resolveIdPrefix(opts: ResolveIdPrefixOptions): Promise<IdPrefixResolution> {
  const classification = classifyIdInput(opts.input, opts.minPrefixLength);

  if (classification.kind === "resolved") {
    return { kind: "resolved", id: classification.id };
  }
  if (classification.kind === "invalid") {
    return { kind: "invalid", input: opts.input, reason: classification.reason };
  }

  const normalized = classification.normalized;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectShape: Record<string, any> = { id: opts.idColumn };
  if (opts.labelColumn) selectShape.label = opts.labelColumn;

  const rows = (await opts.db
    .select(selectShape)
    .from(opts.table)
    .where(sql`${opts.idColumn}::text LIKE ${`${normalized}%`}`)) as Array<{
    id: unknown;
    label?: unknown;
  }>;

  const candidates: PrefixCandidate[] = rows.map((row) => ({
    id: String(row.id),
    label: row.label !== undefined && row.label !== null ? String(row.label) : undefined,
  }));

  const candidateResolution = resolveCandidates(candidates, opts.input);
  if (candidateResolution.kind === "resolved") {
    return { kind: "resolved", id: candidateResolution.id };
  }
  return candidateResolution;
}

/**
 * Convenience wrapper: resolve and throw a clean tool-level error on any
 * non-"resolved" outcome. This is the call most command `execute()` bodies
 * want — resolve the caller-supplied id/prefix to a full uuid, or throw with
 * a message the MCP/CLI surface can render directly.
 */
export async function resolveIdPrefixOrThrow(opts: ResolveIdPrefixOptions): Promise<string> {
  const resolution = await resolveIdPrefix(opts);
  if (resolution.kind === "resolved") {
    return resolution.id;
  }
  throw idPrefixResolutionError(opts.entityName, resolution);
}
