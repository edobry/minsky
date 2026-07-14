/**
 * session-link-writer — populates `minsky_session_links` with `cwd_match`
 * links (mt#2441).
 *
 * `minsky_session_links` (mt#1313 design, mt#1324 migration) models the
 * agent-transcript <-> Minsky-workspace-session many-to-many join, but had
 * zero writers until this module: nothing populated it, so consumers (e.g.
 * mt#1919's `/api/agents/:id`) resolved the join at read time via a `cwd`
 * LIKE query instead. This module detects the `cwd_match` link class — a
 * transcript's captured `cwd` equal to, or nested under, a Minsky workspace
 * session's directory (`<stateDir>/sessions/<id>`) — and writes it once, with
 * provenance, so later reads consult the table instead of recomputing.
 *
 * Runs from the SHARED ingest core (`AgentTranscriptIngestService.ingestSession`)
 * so every ingest path — `transcripts_ingest`, the MCP boot sweep, the
 * SessionEnd hook, and the cadence sweep — writes the same link with no
 * per-consumer duplication (all four funnel through `ingestSession`).
 *
 * Expected yield is LOW for the dominant fleet shape (mt#2749 finding:
 * subagents don't chdir into the session workspace) — that is expected and
 * does NOT indicate a bug in the matcher. This module is the writer/backfill
 * infrastructure that mt#2756's higher-yield `subagent_spawn` link class will
 * flow through next; do not loosen this heuristic to chase yield.
 *
 * Cross-platform note: Minsky's state dir is always POSIX-separated (XDG
 * layout under $HOME on macOS/Linux). A transcript captured with a
 * backslash-separated `cwd` (hypothetical Windows deployment) will not match
 * this detector — that's a missed link, not a wrong one, and is an accepted
 * gap until a Windows deployment exists.
 *
 * No FK to the sessions table by design (mt#2441 SC4): the link is a computed
 * relationship recorded at ingest time, not a live reference, so it survives
 * session-record deletion — historical linkage is the point.
 *
 * @see mt#1313 / mt#1324 — minsky_session_links schema
 * @see mt#1919 — the read-time cwd LIKE consumer this table replaces
 * @see mt#2749 — low cwd_match yield finding (subagents don't chdir)
 * @see mt#2756 — the follow-on high-yield `subagent_spawn` link class
 * @see mt#2441 — this file
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { getSessionsDir } from "@minsky/shared/paths";
import { log } from "@minsky/shared/logger";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import { getErrorMessage } from "../errors/index";

/** Confidence assigned to an exact `<stateDir>/sessions/<id>` cwd match. */
export const CWD_MATCH_EXACT_CONFIDENCE = 1.0;
/** Confidence assigned to a cwd nested under (but not equal to) the session dir. */
export const CWD_MATCH_DESCENDANT_CONFIDENCE = 0.8;

/** Link-type value written by this module (mt#1313's `cwd_match` class). */
export const CWD_MATCH_LINK_TYPE = "cwd_match";

export interface CwdMatchDetection {
  minskySessionId: string;
  confidence: number;
}

/**
 * Pure detector: given a transcript's captured `cwd`, determine whether it
 * falls under `<stateDir>/sessions/<id>` and, if so, extract the Minsky
 * workspace session id and a confidence score.
 *
 * - `cwd === <sessionsDir>/<id>` (no further path segments) -> exact, 1.0.
 * - `cwd` nested further under `<sessionsDir>/<id>/...` -> descendant, 0.8.
 * - `cwd` absent, or not under `sessionsDir` at all -> `null` (no match; the
 *   expected common case per mt#2749 — not an error).
 *
 * `sessionsDir` is injectable for tests; defaults to the live
 * `getSessionsDir()` (`<stateDir>/sessions`).
 */
export function detectCwdMatch(
  cwd: string | null | undefined,
  sessionsDir: string = getSessionsDir()
): CwdMatchDetection | null {
  if (!cwd) return null;

  const normalizedRoot = sessionsDir.endsWith("/") ? sessionsDir.slice(0, -1) : sessionsDir;
  const prefix = `${normalizedRoot}/`;
  if (!cwd.startsWith(prefix)) return null;

  const rest = cwd.slice(prefix.length);
  if (rest.length === 0) return null; // cwd === sessionsDir itself; no session-id segment

  const firstSlash = rest.indexOf("/");
  const minskySessionId = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
  if (!minskySessionId) return null;

  const confidence =
    firstSlash === -1 ? CWD_MATCH_EXACT_CONFIDENCE : CWD_MATCH_DESCENDANT_CONFIDENCE;
  return { minskySessionId, confidence };
}

/**
 * Write the `cwd_match` link for one transcript, given its `agentSessionId`
 * and captured `cwd`. No-ops (no DB call at all) when `cwd` does not resolve
 * to a session workspace path — the common case.
 *
 * Idempotent: the table's primary key is `(agent_session_id,
 * minsky_session_id)`, so re-running ingest (or the backfill sweep) over an
 * already-linked transcript is a safe no-op via `ON CONFLICT DO NOTHING`.
 *
 * Never throws — a DB failure is logged and swallowed so link-writing can
 * never block the ingest it rides alongside (matches the turn-writer and
 * attachment-writer error-swallowing convention in this same pipeline).
 *
 * @returns `true` when a link was written or already existed for this pair;
 *   `false` when no cwd match was detected, or the write failed.
 */
export async function writeCwdMatchLink(
  db: PostgresJsDatabase,
  agentSessionId: string,
  cwd: string | null | undefined,
  sessionsDir?: string
): Promise<boolean> {
  const detected = detectCwdMatch(cwd, sessionsDir ?? getSessionsDir());
  if (!detected) return false;

  try {
    await db
      .insert(minskySessionLinksTable)
      .values({
        agentSessionId,
        minskySessionId: detected.minskySessionId,
        linkType: CWD_MATCH_LINK_TYPE,
        confidence: detected.confidence,
      })
      .onConflictDoNothing();
    return true;
  } catch (err) {
    log.warn(`writeCwdMatchLink: failed to upsert link for session ${agentSessionId}`, {
      error: getErrorMessage(err),
      minskySessionId: detected.minskySessionId,
    });
    return false;
  }
}

export interface BackfillCwdMatchLinksResult {
  transcriptsScanned: number;
  linksWritten: number;
  linksSkippedNoMatch: number;
  linksErrored: number;
}

/**
 * Backfill sweep: walk every already-ingested `agent_transcripts` row and
 * write its `cwd_match` link (mt#2441 SC2). Idempotent — safe to re-run;
 * already-linked pairs are no-ops via `ON CONFLICT DO NOTHING` inside
 * {@link writeCwdMatchLink}.
 *
 * As of 2026-06-10, ~29 rows were expected to match the session-cwd pattern
 * across the corpus (mt#2441 spec); the mt#2749 finding (subagents don't
 * chdir) means the true yield may be lower — that's expected, not a bug.
 */
export async function backfillCwdMatchLinks(
  db: PostgresJsDatabase,
  sessionsDir?: string
): Promise<BackfillCwdMatchLinksResult> {
  const result: BackfillCwdMatchLinksResult = {
    transcriptsScanned: 0,
    linksWritten: 0,
    linksSkippedNoMatch: 0,
    linksErrored: 0,
  };

  let rows: Array<{ agentSessionId: string; cwd: string | null }>;
  try {
    rows = await db
      .select({
        agentSessionId: agentTranscriptsTable.agentSessionId,
        cwd: agentTranscriptsTable.cwd,
      })
      .from(agentTranscriptsTable);
  } catch (err) {
    log.error("backfillCwdMatchLinks: failed to load transcripts", {
      error: getErrorMessage(err),
    });
    return result;
  }

  result.transcriptsScanned = rows.length;
  const resolvedSessionsDir = sessionsDir ?? getSessionsDir();

  for (const row of rows) {
    const detected = detectCwdMatch(row.cwd, resolvedSessionsDir);
    if (!detected) {
      result.linksSkippedNoMatch++;
      continue;
    }
    try {
      const written = await writeCwdMatchLink(db, row.agentSessionId, row.cwd, resolvedSessionsDir);
      if (written) {
        result.linksWritten++;
      } else {
        result.linksErrored++;
      }
    } catch (err) {
      result.linksErrored++;
      log.warn(`backfillCwdMatchLinks: failed for ${row.agentSessionId}`, {
        error: getErrorMessage(err),
      });
    }
  }

  log.info("backfillCwdMatchLinks: complete", { ...result });
  return result;
}
