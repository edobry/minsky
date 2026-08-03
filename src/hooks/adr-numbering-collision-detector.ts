/**
 * Detector for duplicate ADR numbers under `docs/architecture/` (mt#3613).
 *
 * Two ADR files landed a day apart both numbered 031 — each individually
 * correct at authoring time (each was the next free number against the
 * corpus its author saw), but the corpus had no mechanism enforcing
 * uniqueness across the gap. An ADR number is a durable citation target
 * (`ADR-031`, `adr-031-...md`); a duplicate makes every existing and future
 * citation ambiguous. This check closes the gap the mt#3613 spec identified:
 * before this detector, NOTHING in pre-commit inspected `docs/architecture/`
 * at all — the sibling "immutable+collision" step (`runMigrationCollisionCheck`)
 * is exclusively about the SQL-migration journal and never touched ADRs.
 *
 * Scope: fires only when the staged diff touches `docs/architecture/adr-*.md`
 * (cheap early-out, same pattern as `duplicate-generated-content-detector.ts`).
 * When it does, reads the full POST-COMMIT file list from the git index
 * (`git ls-files --cached`) — not just the staged diff — because a collision
 * is a property of the whole corpus, not of what one commit touches: the
 * new/renamed file plus whatever already-committed file happens to share its
 * number.
 */

import { execGitWithTimeout } from "@minsky/domain/utils/git-exec";
import { log } from "@minsky/shared/logger";

export const ADR_NUMBERING_COLLISION_CHECK_OVERRIDE_ENV =
  "MINSKY_SKIP_ADR_NUMBERING_COLLISION_CHECK";

const ADR_GLOB = "docs/architecture/adr-*.md";
const ADR_FILENAME_RE = /^adr-(\d+)-/;

export interface AdrNumberCollision {
  /** The shared numeric prefix (as it appears in the filename, e.g. "031"). */
  number: string;
  /** Every path sharing that number, sorted for deterministic output. */
  paths: string[];
}

export function isAdrNumberingCollisionOverrideTruthy(envValue: string | undefined): boolean {
  if (!envValue) return false;
  const v = envValue.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Extract the numeric prefix from an ADR path's basename, or null if it doesn't match the convention. */
export function extractAdrNumber(filePath: string): string | null {
  const basename = filePath.split("/").pop() ?? filePath;
  const match = ADR_FILENAME_RE.exec(basename);
  return match?.[1] ?? null;
}

/**
 * Pure function: given the full set of `docs/architecture/adr-*.md` paths
 * that WILL exist after the commit, group by numeric prefix and flag any
 * number held by 2+ files.
 */
export function detectAdrNumberCollisions(adrPaths: readonly string[]): AdrNumberCollision[] {
  const byNumber = new Map<string, string[]>();
  for (const path of adrPaths) {
    const number = extractAdrNumber(path);
    if (number === null) continue; // not `adr-NNN-*.md` — not this check's concern
    const existing = byNumber.get(number);
    if (existing) {
      existing.push(path);
    } else {
      byNumber.set(number, [path]);
    }
  }

  const collisions: AdrNumberCollision[] = [];
  for (const [number, paths] of byNumber) {
    if (paths.length > 1) {
      collisions.push({ number, paths: [...paths].sort() });
    }
  }
  return collisions.sort((a, b) => a.number.localeCompare(b.number));
}

export interface AdrNumberingCollisionCheckResult {
  success: boolean;
  message: string;
  exitCode: number;
  overridden?: boolean;
}

/**
 * Pre-commit runner. Early-out when the staged diff doesn't touch any
 * `docs/architecture/adr-*.md` path; otherwise reads the post-commit file
 * list from the index and checks it for duplicate numbers.
 */
export async function runAdrNumberingCollisionCheck(
  projectRoot: string
): Promise<AdrNumberingCollisionCheckResult> {
  if (
    isAdrNumberingCollisionOverrideTruthy(process.env[ADR_NUMBERING_COLLISION_CHECK_OVERRIDE_ENV])
  ) {
    log.cli(
      `[pre-commit:adr-numbering-collision] override ${ADR_NUMBERING_COLLISION_CHECK_OVERRIDE_ENV} set — skipped`
    );
    return {
      success: true,
      message: "ADR-numbering-collision check skipped via override",
      exitCode: 0,
      overridden: true,
    };
  }

  try {
    const diffResult = await execGitWithTimeout(
      "diff",
      `diff --cached --name-only -z --diff-filter=ACMR -- '${ADR_GLOB}'`,
      { workdir: projectRoot, timeout: 5000 }
    );
    const stagedAdrTouched = diffResult.stdout
      .toString()
      .split("\0")
      .filter((p) => p.length > 0);
    if (stagedAdrTouched.length === 0) {
      return {
        success: true,
        message: "ADR-numbering-collision check passed (n/a)",
        exitCode: 0,
      };
    }

    const lsFilesResult = await execGitWithTimeout(
      "ls-files",
      `ls-files --cached -z -- '${ADR_GLOB}'`,
      { workdir: projectRoot, timeout: 5000 }
    );
    const allAdrPaths = lsFilesResult.stdout
      .toString()
      .split("\0")
      .filter((p) => p.length > 0);

    const collisions = detectAdrNumberCollisions(allAdrPaths);
    if (collisions.length === 0) {
      return { success: true, message: "ADR-numbering-collision check passed", exitCode: 0 };
    }

    log.cli(`${collisions.length} duplicated ADR number(s). Commit blocked.`);
    for (const c of collisions) {
      log.cli(`   ADR-${c.number}: ${c.paths.join(", ")}`);
    }
    log.cli(
      "Two ADR files share the same number, which makes every citation of that number " +
        "ambiguous. Renumber one to the next free number (check the whole corpus, not just " +
        `the highest existing one) and update its inbound references. Override: ${ADR_NUMBERING_COLLISION_CHECK_OVERRIDE_ENV}=1`
    );
    return {
      success: false,
      message: `ADR-numbering-collision check failed: ${collisions.length} duplicate number(s)`,
      exitCode: 1,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`ADR-numbering-collision check failed: ${errorMsg}`);
    return {
      success: false,
      message: `ADR-numbering-collision check failed: ${errorMsg}`,
      exitCode: 1,
    };
  }
}
