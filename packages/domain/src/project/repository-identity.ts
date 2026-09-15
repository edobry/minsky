/**
 * The one place repository identity is resolved (mt#5159).
 *
 * `.minsky/config.yaml`'s `repository.{backend,url,github}` and `project.slug`
 * are derived from `git remote get-url origin` by `init` once (mt#2414) and
 * never re-read. flowtato's `init` ran before its remote existed and froze
 * `repository.backend: local`; the config stayed wrong until a manual
 * `init --overwrite` (mt#5152, 2026-09-14). Two defects behind that:
 *
 *   1. Nothing re-derives or validates the recorded identity against the live
 *      `origin`, so a value written at the wrong moment is permanent.
 *   2. Two readers resolved the BACKEND from two different keys — session start
 *      read `repository.default_repo_backend` (user config,
 *      `repository-backend-detection.ts:resolveRepositoryAndBackend`) while
 *      `getRepositoryBackendFromConfig` read `repository.backend` (project
 *      config) — so they could disagree with nothing reporting it.
 *
 * This resolver is ADR-003 EXTENDED, not replaced (mt#5159 gate (p)): the
 * backend stays a project-level property `init` writes; this adds one function
 * that (a) fixes the backend-key precedence in ONE place — project
 * `repository.backend` wins over user `repository.default_repo_backend`, then a
 * value derived from `origin` — and (b) validates the recorded identity against
 * `origin` and reports drift (via mt#5154's `compareRepositoryIdentity`) so a
 * frozen-wrong value is surfaced rather than silently trusted. It does NOT move
 * to read-at-use-time; config remains the recorded source, `origin` the check.
 *
 * Pure over injected reads; never throws.
 */

import { compareRepositoryIdentity, type RepositoryDriftResult } from "./repository-drift";

/** The recorded backend values, from the two config layers. */
export interface RecordedBackendConfig {
  /** `repository.backend` — the project-level value `init` writes (ADR-003). */
  projectBackend?: string;
  /** `repository.default_repo_backend` — the user-level fallback. */
  userDefaultBackend?: string;
}

/** The full recorded repository identity, as the merged config exposes it. */
export interface RecordedRepositoryConfig extends RecordedBackendConfig {
  url?: string;
  github?: { owner?: string; repo?: string };
  slug?: string;
}

export type BackendSource = "project-config" | "user-default" | "origin-derived" | "none";

export interface RepositoryIdentityResolution {
  /** The effective backend, by the precedence below. */
  backend: string;
  /** Which layer supplied `backend` — the answer to SC3's precedence question. */
  backendSource: BackendSource;
  /** The live `origin` URL, or null when there is no remote. */
  originUrl: string | null;
  /** Recorded identity vs `origin` (mt#5154). `match` / `drift` / `no-origin` / `unparseable-origin`. */
  drift: RepositoryDriftResult;
}

export interface ResolveRepositoryIdentityDeps {
  /** The recorded config identity. */
  recorded: RecordedRepositoryConfig;
  /** The live `origin` URL for the workspace, or null. Injected so this stays pure. */
  originUrl: string | null;
}

/**
 * Backend precedence (SC3), resolved in ONE place so session start,
 * `workspace_info`, and PR creation cannot disagree:
 *
 *   1. `repository.backend` (project config, ADR-003's set-once value) — wins.
 *   2. `repository.default_repo_backend` (user config) — the fallback session
 *      start historically read on its own.
 *   3. the backend `origin` derives to (`github` / `gitlab` / `local`) — when
 *      neither is recorded (a project `init` never stamped).
 *
 * The project value winning is the fix: a project that recorded `backend:
 * github` is not overridden by a user default, and a user default is used only
 * when the project said nothing.
 */
export function resolveBackend(
  recorded: RecordedBackendConfig,
  originBackend: string | undefined
): { backend: string; backendSource: BackendSource } {
  if (recorded.projectBackend) {
    return { backend: recorded.projectBackend, backendSource: "project-config" };
  }
  if (recorded.userDefaultBackend) {
    return { backend: recorded.userDefaultBackend, backendSource: "user-default" };
  }
  if (originBackend) {
    return { backend: originBackend, backendSource: "origin-derived" };
  }
  return { backend: "local", backendSource: "none" };
}

/** The backend an `origin` URL implies, for the precedence fallback. */
export function backendFromOriginUrl(originUrl: string | null): string | undefined {
  if (!originUrl) return undefined;
  if (originUrl.includes("github.com")) return "github";
  if (originUrl.includes("gitlab.com")) return "gitlab";
  return "local";
}

export function resolveRepositoryIdentity(
  deps: ResolveRepositoryIdentityDeps
): RepositoryIdentityResolution {
  const { recorded, originUrl } = deps;
  const { backend, backendSource } = resolveBackend(recorded, backendFromOriginUrl(originUrl));
  const drift = compareRepositoryIdentity(
    {
      backend: recorded.projectBackend,
      url: recorded.url,
      github: recorded.github,
      slug: recorded.slug,
    },
    originUrl
  );
  return { backend, backendSource, originUrl, drift };
}

/** A one-line, operator-facing summary of a drift result, or null when there is nothing to say. */
export function describeRepositoryDrift(drift: RepositoryDriftResult): string | null {
  switch (drift.kind) {
    case "match":
      return null;
    case "no-origin":
      return "no `origin` remote — repository identity cannot be validated against git; add a GitHub remote and re-run `minsky init --overwrite`.";
    case "unparseable-origin":
      // GitHub is the only forge Minsky resolves identity for today
      // (`extractOwnerRepo`), so a non-parseable origin is usually a non-GitHub
      // remote (GitLab, Bitbucket, a local path) or a malformed URL — name that
      // rather than implying the URL is simply wrong.
      return `origin (${drift.originUrl}) is not an owner/name URL Minsky can compare against — it is a non-GitHub remote or a local/other URL, and repository identity is only validated for GitHub today.`;
    case "drift":
      return `recorded repository identity disagrees with origin (${drift.slug}): ${drift.findings
        .map((f) => `${f.field} is "${f.recorded}", origin says "${f.expected}"`)
        .join("; ")}; re-run \`minsky init --overwrite\` to re-derive it from origin.`;
  }
}
