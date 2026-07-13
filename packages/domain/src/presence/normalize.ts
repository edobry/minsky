/**
 * Presence subject-id normalization — mt#2562 (PR #1755 R1 fix).
 *
 * The presence write path (server.writeTaskClaim) and the read path
 * (tasks.claims.list) MUST key on the SAME canonical subject_id, or claims
 * fragment: a tool call passing `mt#2562` and another passing `2562` would
 * create two distinct rows and the read would only ever see one of them.
 *
 * Reviewer-flagged (PR #1755 R1): `writeTaskClaim` stored the raw task id
 * without normalization. This helper is the single canonicalizer both sides
 * call.
 */

import { normalizeTaskId } from "../session/task-correspondence";

/**
 * Canonicalize a task identifier for use as a presence-claim `subject_id`.
 *
 * Collapses every surface form of the SAME task to one key so the write and
 * read paths cannot fragment:
 *   "mt#2562" / "MT#2562" / "mt-2562" / "mt2562" / "#2562" / "2562"  → "mt2562"
 *   "md#160"  / "md-160"                                             → "md160"
 *
 * A bare numeric id (or a leading-`#` numeric id) is defaulted to the `mt`
 * backend — Minsky's global `mt#N` numbering — which collapses the
 * reviewer-flagged `mt#2562` == `2562` case. Backend prefixes (mt / md / gh)
 * are preserved so different-backend tasks with the same number stay distinct.
 * Separator stripping + lowercasing is delegated to the existing, tested
 * `normalizeTaskId` (packages/domain/src/session/task-correspondence.ts).
 *
 * Returns "" for a non-string / empty id — callers should skip the write/read.
 */
export function normalizeTaskSubjectId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Strip a leading "#" then default a bare numeric id to the mt backend,
  // BEFORE separator-stripping, so "2562" and "#2562" canonicalize the same
  // way as "mt#2562".
  const stripped = trimmed.replace(/^#/, "");
  const withBackend = /^\d+$/.test(stripped) ? `mt${stripped}` : stripped;
  return normalizeTaskId(withBackend);
}
