/**
 * Changeset (PR) identity — the ONE place the cockpit's changeset id format is
 * parsed and formatted (mt#4724).
 *
 * ## Why this module exists
 *
 * Every other routable cockpit entity (task, ask, session, memory,
 * conversation) has a genuinely GLOBAL id-space. `changeset` does not: its id
 * is a PR number, which is only unique **per repository**. With one project in
 * the database that difference was invisible; with two, `PR #1` names two
 * different pull requests and whichever one the server happened to find first
 * won.
 *
 * ## Two accepted forms
 *
 * - **Bare** — `"1"`. Resolves against the DEFAULT repo: the repository this
 *   cockpit's own Minsky config points at (`repository` / `repository.github`).
 *   This is exactly what a bare number already meant, so every already-emitted
 *   `minsky://changeset/<n>` link keeps resolving to the same PR it always did
 *   (ADR-029 fixes the emitted form; it cannot be re-pointed).
 * - **Qualified** — `"edobry/peezombie.me#1"`. Names the repo explicitly, so it
 *   is unambiguous across projects. The `owner/repo#N` spelling is mt#1207's
 *   proposed convention for exactly this collision class in the provenance
 *   subsystem; reusing it keeps one qualified-PR-key format in the system
 *   rather than two.
 *
 * A qualified id travels through the existing URI/path machinery unchanged:
 * `entityToPath`/`entityToMinskyUri` percent-encode it (`/` → `%2F`,
 * `#` → `%23`), `matchEntityRoute`'s `^/changeset/([^/]+)$` still matches the
 * single encoded segment, and `parseMinskyUri` decodes it back.
 *
 * ## Why it lives in `packages/shared`
 *
 * It is shared by the cockpit's express routes (Bun) and by its SPA
 * (`src/cockpit/web/lib/entity-codec.ts`, browser bundle), and TWO independent
 * constraints pin where such a module may live. `packages/shared/src` is the
 * only place that satisfies both — it is the browser-safe home mt#3239
 * established for exactly this purpose (`ask-closure.ts`, `ask-approval.ts` are
 * the precedents).
 *
 * **1. The image build's file set.** This started at
 * `src/cockpit/changeset-id.ts`, which resolves locally and FAILS in the image:
 * `services/cockpit/Dockerfile`'s builder stage copies each workspace's `src`
 * plus `src/cockpit/web` — not the rest of `src/cockpit` — so Rollup could not
 * resolve it (`docker-build-smoke`, PR #3455). Every other SPA import from
 * `src/cockpit/*` is an `import type`, which esbuild erases; this was the first
 * VALUE import across that boundary, and the Dockerfile states the rule
 * directly — value imports need the source present, type-only ones do not.
 *
 * **2. The browser-safety guard.** `packages/domain` also satisfies (1), and is
 * still wrong: `custom/no-node-import-in-cockpit-web` bans `@minsky/domain` as a
 * whole PREFIX from cockpit web files, because any domain submodule may reach
 * `@minsky/shared/logger` (whose top-level code touches Node) transitively. Its
 * allowlist exists but its own docblock warns that an allowlisted module which
 * LATER grows a Node import is not caught — so taking the escape hatch trades a
 * build-time failure for a runtime one.
 *
 * mt#1207 wants this same `owner/repo#N` convention for the provenance
 * subsystem's identical collision; that is domain code, and domain may import
 * from shared, so one source of truth still serves both.
 *
 * ## Purity contract
 *
 * This module has **no imports**, and must keep none: it is bundled into the
 * browser, so anything Node-only added here breaks the SPA build — which is the
 * very hazard constraint (2) exists to prevent.
 */

/** A GitHub repository coordinate. */
export interface ChangesetRepoRef {
  owner: string;
  repo: string;
}

/** The result of parsing a changeset id. */
export interface ParsedChangesetId {
  /**
   * The repository named by a QUALIFIED id, or `null` for the bare form —
   * `null` means "resolve against the default project", it does NOT mean
   * "any project".
   */
  repo: ChangesetRepoRef | null;
  /** PR number, always a positive integer. */
  prNumber: number;
  /** Canonical string form: `"1"` or `"edobry/peezombie.me#1"`. */
  canonical: string;
}

/**
 * Owner/repo segment charset. GitHub owners are `[A-Za-z0-9-]` and repo names
 * additionally allow `.` and `_`; both are matched with the wider set so a
 * legitimate repo like `peezombie.me` parses. Deliberately excludes `/` and `#`
 * — those are the delimiters.
 */
const SEGMENT = "[A-Za-z0-9._-]+";

const BARE_ID_RE = /^[0-9]+$/;
const QUALIFIED_ID_RE = new RegExp(`^(${SEGMENT})/(${SEGMENT})#([0-9]+)$`);

/** Is `raw` a syntactically valid changeset id (either form)? */
export function isChangesetId(raw: string): boolean {
  return parseChangesetId(raw) !== null;
}

/**
 * Parse a changeset id in either accepted form.
 *
 * Returns `null` for anything else — including `"0"` and negative/decimal
 * spellings, since a PR number is a positive integer. The route is the
 * authoritative gate (`matchEntityRoute` accepts any path segment as `:id`),
 * so this must reject rather than coerce.
 */
export function parseChangesetId(raw: string): ParsedChangesetId | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (BARE_ID_RE.test(trimmed)) {
    const prNumber = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
    return { repo: null, prNumber, canonical: String(prNumber) };
  }

  const qualified = QUALIFIED_ID_RE.exec(trimmed);
  if (!qualified) return null;
  const [, owner, repo, num] = qualified;
  if (!owner || !repo || !num) return null;
  const prNumber = Number.parseInt(num, 10);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return { repo: { owner, repo }, prNumber, canonical: `${owner}/${repo}#${prNumber}` };
}

/** Format a changeset id. A null `repo` produces the bare (default-project) form. */
export function formatChangesetId(repo: ChangesetRepoRef | null, prNumber: number): string {
  return repo ? `${repo.owner}/${repo.repo}#${prNumber}` : String(prNumber);
}

/**
 * Derive `{owner, repo}` from a git remote URL — https or ssh, with or without
 * a trailing `.git` or `/`.
 *
 * A local re-implementation rather than a call to the domain's
 * `extractGitHubInfoFromUrl` on purpose: this module is imported by the browser
 * bundle, and that one lives behind `@minsky/domain/session/*`. Kept
 * deliberately narrow — GitHub only, matching `GitHubChangesetAdapterFactory`'s
 * own `canHandle`.
 */
export function parseGitHubRepoRef(repoUrl: string | null | undefined): ChangesetRepoRef | null {
  if (!repoUrl) return null;
  const https = repoUrl.match(
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/
  );
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] };
  const ssh = repoUrl.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

/**
 * A project slug is `owner/repo` for GitHub-backed projects (see
 * `projects-schema.ts`). Parse one into a repo ref; returns null for a slug
 * that is not in that shape (a non-GitHub or free-form project slug).
 */
export function repoRefFromProjectSlug(slug: string | null | undefined): ChangesetRepoRef | null {
  if (!slug) return null;
  const m = new RegExp(`^(${SEGMENT})/(${SEGMENT})$`).exec(slug.trim());
  if (!m?.[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2] };
}

/** The canonical https clone URL for a repo ref. */
export function repoUrlFromRepoRef(repo: ChangesetRepoRef): string {
  return `https://github.com/${repo.owner}/${repo.repo}.git`;
}

/** `true` when both refs name the same repository (case-insensitive, as GitHub is). */
export function sameRepoRef(
  a: ChangesetRepoRef | null | undefined,
  b: ChangesetRepoRef | null | undefined
): boolean {
  if (!a || !b) return false;
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/**
 * Build the changeset id for a PR known to live in `repoUrl`, qualifying it
 * only when it does NOT belong to the default repo.
 *
 * This is the rule that keeps already-emitted links working while making new
 * ones unambiguous: the default project's PRs keep their bare ids (which is
 * what every stored `minsky://changeset/<n>` already says), and everything else
 * gets a qualified id.
 */
export function changesetIdFor(
  repoUrl: string | null | undefined,
  prNumber: number,
  defaultRepo: ChangesetRepoRef | null
): string {
  const ref = parseGitHubRepoRef(repoUrl);
  if (!ref || sameRepoRef(ref, defaultRepo)) return String(prNumber);
  return formatChangesetId(ref, prNumber);
}
