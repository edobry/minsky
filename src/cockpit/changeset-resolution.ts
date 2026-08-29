/**
 * Changeset resolution rules (mt#4724) — the decisions `GET /api/changeset/:id`
 * makes, extracted as pure functions so they can be asserted directly instead
 * of through a route with a session provider, a forge client and a db behind it.
 *
 * Two decisions live here:
 *
 *  1. {@link resolveChangesetRepoSource} — WHICH repository a request names.
 *  2. {@link selectSessionForChangeset} — WHICH session row (if any) enriches it.
 *
 * The second is where the original collision was: the route scanned an
 * UNSCOPED session list for `s.pullRequest?.number === prNumber` and took the
 * first hit, so with two projects open on PR #1 the answer was whichever row
 * the store happened to return first.
 */
import type { SessionRecord } from "@minsky/domain/session/types";
import {
  parseChangesetId,
  parseGitHubRepoRef,
  sameRepoRef,
  type ChangesetRepoRef,
} from "@minsky/shared/changeset-id";

/** How the repository for a changeset request was determined. */
export type ChangesetRepoSource = "qualified-id" | "project-param" | "default";

/** A parsed changeset request: which PR, in which repo, and how we know. */
export interface ChangesetRequest {
  prNumber: number;
  /**
   * The repository, when it could be determined. `null` means UNKNOWN, not
   * "any" — callers degrade to the legacy unscoped behavior in that case
   * rather than picking arbitrarily.
   */
  repo: ChangesetRepoRef | null;
  source: ChangesetRepoSource;
}

/**
 * Look up the repository a request names, given the two qualifiers a caller can
 * supply and the default.
 *
 * Precedence, most specific first:
 *  1. A QUALIFIED id (`owner/repo#N`) — the id names its own repo, so nothing
 *     else can override it.
 *  2. The `?project=<slug>` query param — how the cockpit's own list→detail
 *     navigation carries scope.
 *  3. The DEFAULT project — the repo this cockpit's Minsky config points at.
 *     This is what a bare `minsky://changeset/<n>` has always meant, and
 *     ADR-029 fixes that emitted form, so it is the rule that keeps every
 *     already-emitted link resolving to the PR it always did.
 *
 * Pure: the two lookups are passed in as already-resolved values, so this
 * function is the RULE and the callers own the IO.
 */
export function resolveChangesetRepoSource(input: {
  changesetId: string;
  projectRepo: ChangesetRepoRef | null;
  defaultRepo: ChangesetRepoRef | null;
}): ChangesetRequest | null {
  const parsed = parseChangesetId(input.changesetId);
  if (!parsed) return null;

  if (parsed.repo) {
    return { prNumber: parsed.prNumber, repo: parsed.repo, source: "qualified-id" };
  }
  if (input.projectRepo) {
    return { prNumber: parsed.prNumber, repo: input.projectRepo, source: "project-param" };
  }
  return { prNumber: parsed.prNumber, repo: input.defaultRepo, source: "default" };
}

/**
 * Pick the session record that enriches a changeset, or null.
 *
 * The rule, in order:
 *
 *  - Candidates are sessions whose `pullRequest.number` matches.
 *  - When the repo is KNOWN, a candidate whose `repoUrl` resolves to that repo
 *    wins outright. This is the fix: PR #1 in two projects yields two
 *    candidates and the repo picks between them.
 *  - When no candidate matches the repo but NONE of them has a parseable GitHub
 *    remote either, the repo cannot discriminate at all — a session cloned from
 *    a local path is the ordinary case. A SINGLE such candidate is returned
 *    (there is no ambiguity to resolve, and dropping it would silently regress
 *    enrichment); several are treated as ambiguous.
 *  - When some candidates ARE parseable and none matches, the answer is
 *    "not in this repo" — null, never an arbitrary other project's row.
 *  - When the repo is UNKNOWN (no default configured), the pre-mt#4724
 *    first-match behavior is preserved, since there is nothing to scope by.
 */
export function selectSessionForChangeset(
  sessions: readonly SessionRecord[],
  prNumber: number,
  repo: ChangesetRepoRef | null
): SessionRecord | null {
  const candidates = sessions.filter((s) => s.pullRequest?.number === prNumber);
  if (candidates.length === 0) return null;
  if (!repo) return candidates[0] ?? null;

  const exact = candidates.find((s) => sameRepoRef(parseGitHubRepoRef(s.repoUrl), repo));
  if (exact) return exact;

  const anyParseable = candidates.some((s) => parseGitHubRepoRef(s.repoUrl) !== null);
  if (!anyParseable && candidates.length === 1) return candidates[0] ?? null;

  return null;
}
