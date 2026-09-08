/**
 * pgvector migration preflight (mt#5016).
 *
 * Minsky's schema declares `vector(1536)` columns in six embeddings tables and
 * six HNSW indexes over them, so **the migration tree cannot be applied to a
 * Postgres server that cannot load pgvector.** Nothing said so until it failed:
 * `minsky setup db`'s Docker one-liner pinned a plain `postgres:NN` image, which
 * does not ship the extension, and the resulting error was the raw SQLSTATE
 * `0A000` from `CREATE EXTENSION`.
 *
 * This module answers a DIFFERENT question from its sibling
 * `vector-capability-probe.ts`, and the distinction is the whole point:
 *
 * - `vector-capability-probe.ts` reads `pg_extension` — *is the extension
 *   INSTALLED in this database?* That decides which provider gets constructed
 *   at runtime, and "no" is a legitimate answer meaning "degrade".
 * - This module reads `pg_available_extensions` — *could the extension be
 *   installed at all, i.e. did the server operator put its control file on
 *   disk?* That decides whether a migration can even run, and "no" is fatal.
 *
 * The two are independent: a database can have pgvector available but not yet
 * created (the ordinary fresh-container case, which migrates fine because the
 * bootstrap snapshot's first statement is `CREATE EXTENSION IF NOT EXISTS
 * vector`).
 *
 * ## Both migration entry points call this, because they fail differently
 *
 * 1. **Fresh database → bootstrap snapshot.** `bootstrap/full-schema.sql`'s
 *    first statement is the `CREATE EXTENSION`, so the failure is immediate and
 *    at least names the extension.
 * 2. **Non-fresh database → numbered-migration replay.** NO numbered migration
 *    creates the extension — verified by grep over the whole
 *    `migrations/pg/*.sql` tree, and stated in
 *    `scripts/generate-bootstrap-snapshot.ts`'s own comment: production
 *    (Supabase) pre-enables it and the runtime vector layer runs its own
 *    `CREATE EXTENSION` on init. So this path dies later, at `0005`'s
 *    `vector(1536)` column, with a *type "vector" does not exist* error that
 *    names neither the extension nor a remedy.
 *
 * ## Fail-OPEN on an unreadable probe, unlike the sibling
 *
 * `vector-capability-probe.ts` THROWS on an inconclusive read, because there its
 * three-way collapse silently downgraded a provider that was then memoized for
 * the process lifetime (mt#3833). Here the calculus is inverted: this is a
 * message-quality preflight in front of DDL that will produce its own error
 * anyway, so refusing to migrate on a catalog query we could not parse would
 * invent a NEW way to break migrations in exchange for nothing. An inconclusive
 * read therefore proceeds — the underlying `CREATE EXTENSION` remains the
 * backstop, exactly as before this module existed.
 */

import { log } from "@minsky/shared/logger";

/** The image `minsky setup db` prints, and the remedy this preflight names. */
export const PGVECTOR_DOCKER_IMAGE = "pgvector/pgvector:pg17";

/** What the availability probe actually told us. */
export type PgvectorAvailability =
  /** The extension is already created in this database. Nothing to check. */
  | "installed"
  /** Not created, but the server has it available — `CREATE EXTENSION` will work. */
  | "available"
  /** The server cannot load it at all. Migrations cannot run here. */
  | "unavailable"
  /**
   * The probe returned something we cannot read either way. NOT "unavailable":
   * a server without pgvector answers with explicit `false`s, which is a fact;
   * this is the absence of one. Callers proceed on this (see the module docblock).
   */
  | "inconclusive";

/**
 * The catalog query behind {@link probePgvectorAvailability}.
 *
 * `pg_available_extensions` lists what the server COULD install (one row per
 * control file on disk); `pg_extension` lists what this database HAS installed.
 * Both are readable by an unprivileged role.
 */
export const PGVECTOR_AVAILABILITY_QUERY = `
  SELECT
    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed,
    EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available
`;

/**
 * Classify the probe's result set.
 *
 * Deliberately strict about the booleans, for the reason
 * `vector-capability-probe.ts` spells out: a driver returning `"f"`, `0`, `null`
 * or nothing is not asserting that pgvector is missing, and reading any of those
 * as `false` is the collapse both modules exist to prevent.
 */
export function classifyPgvectorAvailability(rows: unknown): PgvectorAvailability {
  if (!Array.isArray(rows)) return "inconclusive";
  const first: unknown = rows[0];
  if (typeof first !== "object" || first === null) return "inconclusive";
  const installed: unknown = (first as { installed?: unknown }).installed;
  const available: unknown = (first as { available?: unknown }).available;
  if (installed === true) return "installed";
  if (installed !== false) return "inconclusive";
  if (available === true) return "available";
  if (available === false) return "unavailable";
  return "inconclusive";
}

/**
 * The single line that survives a `throw`.
 *
 * `handleCliError`'s default branch (`src/adapters/cli/utils/error-handler.ts`)
 * renders `msg.split("\n")[0]` capped at 300 characters — deliberately, to keep
 * stack-shaped errors out of CLI output. So a multi-line thrown message loses
 * everything after its first line, which is exactly where a remedy naturally
 * goes. Verified live 2026-09-08 against a plain `postgres:17`: the full message
 * below was authored first, and the terminal showed only its opening clause.
 *
 * This summary therefore carries the cause AND the remedy on ONE line, under the
 * 300-character cap, so the fix reaches the operator even when nothing but the
 * thrown message does. {@link pgvectorUnavailableMessage} is the fuller version,
 * emitted through `log.cli` before the throw.
 */
export const PGVECTOR_UNAVAILABLE_SUMMARY =
  "pgvector is not available on this Postgres server, so Minsky's migrations cannot be " +
  `applied. Use the ${PGVECTOR_DOCKER_IMAGE} image instead of plain postgres:17, or enable ` +
  "the extension on your server — see the detail above.";

/**
 * The operator-facing failure detail: what is wrong, and what to do about it.
 *
 * Names the REMEDY, not just the cause. Postgres's own hint ("The extension must
 * first be installed on the system where PostgreSQL is running") is accurate and
 * useless to someone who followed Minsky's own instructions to get here — it
 * cannot know which image Minsky should have told them to run.
 */
export function pgvectorUnavailableMessage(): string {
  return [
    "This Postgres server does not have the pgvector extension available, so Minsky's",
    "migrations cannot be applied to it.",
    "",
    "Minsky's schema stores embeddings in `vector` columns (tasks, rules, memories,",
    "tools, knowledge, transcripts), which require pgvector. The plain `postgres:NN`",
    "Docker images do NOT ship it.",
    "",
    "Remedies:",
    `  - Local Docker: use \`${PGVECTOR_DOCKER_IMAGE}\` instead of \`postgres:17\`.`,
    "    `minsky setup db` prints the full command.",
    "  - Existing container you want to keep: install it in place, e.g.",
    "    `docker exec <container> sh -c 'apt-get update && apt-get install -y postgresql-17-pgvector'`",
    "  - Hosted Postgres (Supabase, RDS, Cloud SQL): pgvector is generally available —",
    "    enable it in the provider's console, or run `CREATE EXTENSION vector;` as a",
    "    privileged role.",
  ].join("\n");
}

/**
 * Raised when the server cannot load pgvector at all.
 *
 * Carries {@link PGVECTOR_UNAVAILABLE_SUMMARY}, not the multi-line detail — see
 * that constant for why a thrown multi-line message loses its remedy.
 */
export class PgvectorUnavailableError extends Error {
  constructor() {
    super(PGVECTOR_UNAVAILABLE_SUMMARY);
    this.name = "PgvectorUnavailableError";
  }
}

/** Minimal postgres.js-shaped surface this probe needs. */
export interface PgvectorProbeClient {
  unsafe(query: string): PromiseLike<unknown>;
}

/**
 * Run the availability probe. A probe that THROWS (connection dropped, catalog
 * unreadable) is `inconclusive` for the same reason an unparseable result is:
 * this preflight must never be the reason a migration fails.
 */
export async function probePgvectorAvailability(
  sql: PgvectorProbeClient
): Promise<PgvectorAvailability> {
  try {
    return classifyPgvectorAvailability(await sql.unsafe(PGVECTOR_AVAILABILITY_QUERY));
  } catch {
    // intentional-swallow: an unreadable probe must not block a migration that
    // would otherwise succeed. `CREATE EXTENSION` is still the backstop.
    return "inconclusive";
  }
}

/**
 * Preflight both migration entry points: throw {@link PgvectorUnavailableError}
 * only when the server has explicitly told us it cannot load pgvector.
 *
 * Emits the multi-line detail through `log.cli` BEFORE throwing. That is not
 * belt-and-braces — it is the only channel that carries the remedy, because the
 * CLI error handler renders a thrown message's first line and nothing else.
 */
export async function assertPgvectorAvailableForMigration(sql: PgvectorProbeClient): Promise<void> {
  if ((await probePgvectorAvailability(sql)) === "unavailable") {
    log.cli("");
    log.cli(pgvectorUnavailableMessage());
    log.cli("");
    throw new PgvectorUnavailableError();
  }
}
