/**
 * Does the project's recorded repository identity still match `origin`?
 *
 * `init` derives `repository.{backend,url,github}` and `project.slug` from
 * `git remote get-url origin` once (`config-content.ts`, mt#2414) and nothing
 * re-reads them. flowtato's `init` ran before its remote existed and recorded
 * `repository.backend: local`; the remote arrived six minutes later and the
 * config stayed wrong until a manual `init --overwrite` (mt#5152, 2026-09-14).
 *
 * This is the DETECTION half, pure so `config doctor` (mt#5154) can render it
 * and mt#5159's single identity helper can absorb it — that task owns the
 * re-derivation. Nothing here reads a file or runs git: the caller supplies
 * both sides.
 */

import { extractOwnerRepo } from "./slug";

/** The identity fields `init` writes, as the merged project config exposes them. */
export interface RecordedRepositoryIdentity {
  backend?: string;
  url?: string;
  github?: { owner?: string; repo?: string };
  slug?: string;
}

export interface RepositoryDriftFinding {
  /** Which recorded field disagrees with `origin`. */
  field: "repository.backend" | "repository.url" | "repository.github" | "project.slug";
  recorded: string;
  expected: string;
}

export type RepositoryDriftResult =
  /** Every recorded field agrees with `origin`. `slug` is what origin derives to. */
  | { kind: "match"; slug: string }
  | { kind: "drift"; slug: string; findings: RepositoryDriftFinding[] }
  /** The workspace has no `origin` remote; nothing to compare against. */
  | { kind: "no-origin" }
  /** `origin` exists but is not a GitHub `owner/name` URL Minsky can parse. */
  | { kind: "unparseable-origin"; originUrl: string };

/** Strip a trailing `.git` and normalise case for URL comparison. */
function canonicalUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * Compare the recorded identity against the live `origin` URL.
 *
 * A field that is simply ABSENT from the record is not drift on its own — a
 * project may legitimately record only `repository.url` — except `backend`:
 * a GitHub origin with `backend: local` (or none) is exactly the flowtato
 * defect, so that one is reported when absent as well.
 */
export function compareRepositoryIdentity(
  recorded: RecordedRepositoryIdentity,
  originUrl: string | null
): RepositoryDriftResult {
  if (!originUrl || originUrl.trim().length === 0) return { kind: "no-origin" };
  const slug = extractOwnerRepo(originUrl.trim());
  if (!slug) return { kind: "unparseable-origin", originUrl };

  const findings: RepositoryDriftFinding[] = [];
  const [owner, repo] = slug.split("/") as [string, string];

  if (recorded.backend !== "github") {
    findings.push({
      field: "repository.backend",
      recorded: recorded.backend ?? "(unset)",
      expected: "github",
    });
  }
  if (recorded.url && canonicalUrl(recorded.url) !== canonicalUrl(originUrl)) {
    findings.push({ field: "repository.url", recorded: recorded.url, expected: originUrl.trim() });
  }
  if (recorded.github?.owner || recorded.github?.repo) {
    const recordedOwnerRepo = `${recorded.github.owner ?? ""}/${recorded.github.repo ?? ""}`;
    if (recordedOwnerRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      findings.push({ field: "repository.github", recorded: recordedOwnerRepo, expected: slug });
    }
  }
  if (recorded.slug && recorded.slug.toLowerCase() !== slug.toLowerCase()) {
    findings.push({ field: "project.slug", recorded: recorded.slug, expected: slug });
  }

  return findings.length === 0 ? { kind: "match", slug } : { kind: "drift", slug, findings };
}
