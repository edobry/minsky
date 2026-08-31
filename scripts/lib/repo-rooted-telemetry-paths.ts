/**
 * mt#4816 SC5 — the family's one BEHAVIOUR-scoped check.
 *
 * Four tasks in a row (mt#4752, mt#4778, mt#4811, mt#4816) each found "one more writer" that
 * still resolved a telemetry path against the repo root — depositing files into whatever
 * Minsky-managed project the agent happened to be in, the condition mt#4748's SC2 forbids. The
 * reason each sweep missed the next one is that all three prior sweeps were scoped by
 * DIRECTORY (`.minsky/hooks/**`), while the population is defined by BEHAVIOUR. mt#4811's
 * `ask-form-lint-calibration.ts` lives in `src/adapters/shared/commands/`, so no
 * `.minsky/hooks` sweep could ever have seen it.
 *
 * So this scans for the behaviour instead: **a path expression rooted at the repo whose target
 * is telemetry.** It deliberately does NOT key on the fs write call. Keying on
 * `appendFileSync`/`writeFileSync` was tried and rejected during implementation, with a
 * measurement: both `calibration-review-cadence-detector.ts` and `calibration.ts` write through
 * a one-hop helper (`writeLastWarnedStore`, `writeFileMkdir`), so a write-keyed scan finds
 * neither. Computing a repo-rooted telemetry path at all is the smell; whether the consumer
 * reads or writes is what the allowlist reason records.
 *
 * ## What it cannot see
 *
 * A text scan over single-line assignments. It misses a path assembled across statements, one
 * built by string concatenation, and one whose root arrives through a parameter with no local
 * assignment. It is a floor under a class that currently has NO mechanical check at all, not a
 * proof of absence — state that bound rather than reading a clean run as "there are none."
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";

export interface ScannedFile {
  /** Repo-relative path, e.g. `.minsky/hooks/foo.ts`. */
  path: string;
  source: string;
}

export interface RepoRootedTelemetryFinding {
  path: string;
  /** The offending expression, normalized to one line for a readable failure message. */
  expression: string;
}

/**
 * Roots scanned. `scripts/` is deliberately absent: a one-shot script that reads or consolidates
 * the OLD location is doing its job, and `scripts/consolidate-evaluation-stream-logs.ts` is
 * exactly that. Same reasoning the execution-evidence guard uses to exclude `scripts/`.
 */
export const SCAN_ROOTS = [".minsky/hooks", "src", "packages"] as const;

/** `const x = join(<root>, ...)` / `resolve(...)` on one line — the shape this scan can see. */
const PATH_ASSIGNMENT =
  /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:join|resolve)\(\s*([^,]+),([^;]*);/g;

/** First argument denotes the repository the agent is working in, rather than the state dir. */
const REPO_ROOTED =
  /findRepoRoot\(|deriveHookRepoRoot\(|repoRoot|workspacePath|process\.cwd\(\)|\bcwd\b/;

/**
 * Target is telemetry rather than config, build output, or a user-requested artifact. Without
 * this conjunct the scan also returns `.minsky/config.yaml` (project config, correctly
 * repo-local), a graphviz render the operator asked for by path, and a generated Dockerfile —
 * all measured, none of them this class.
 */
const TELEMETRY_TARGET =
  /log|calibration|evaluation|baseline|watermark|claims|mismatch|observations|\.jsonl/i;

/**
 * Files exempt from the rule, each with the reason and — where the exemption is temporary — the
 * task that retires it. An entry without a reason is not an exemption, it is a silent hole.
 */
export const ALLOWLIST: Record<string, string> = {
  ".minsky/hooks/require-execution-evidence-before-merge.ts":
    "TRACKED, NOT ACCEPTED — mt#4755 owns re-rooting the execution-evidence five-tier ladder's " +
    "writers. Four of its five streams were observed still writing into the repo tree on " +
    "2026-08-31. Remove this entry when mt#4755 lands.",
  ".minsky/hooks/calibration-review-cadence-detector.ts":
    "DELIBERATE, AND UNDECIDED — the watermark / last-warned stores are a different producer " +
    "from the calibration logs themselves and were explicitly out of mt#4748's scope (see that " +
    "file's mt#4748-R1 docblock). Their stated justification is 'still correctly gitignored', " +
    "which is a minsky-repo-only property and therefore the premise mt#4748 exists to retire. " +
    "Recorded in mt#4816's Context as a boundary case someone must decide, not close silently.",
  "src/adapters/shared/commands/calibration.ts":
    "DELIBERATE, AND UNDECIDED — same watermark store as above plus mt#4164's claim store, " +
    "written under the same lock. See the entry above for why this exemption is provisional.",
};

/** Every repo-rooted telemetry path expression in the given files, allowlist NOT applied. */
export function findRepoRootedTelemetryPaths(files: ScannedFile[]): RepoRootedTelemetryFinding[] {
  const findings: RepoRootedTelemetryFinding[] = [];
  for (const file of files) {
    const seen = new Set<string>();
    for (const match of file.source.matchAll(PATH_ASSIGNMENT)) {
      const [, name, root, rest] = match;
      if (!root || !REPO_ROOTED.test(root)) continue;
      if (!TELEMETRY_TARGET.test(`${name} ${rest}`)) continue;
      const expression = safeTruncate(
        `${name} = join(${root.trim()},${rest?.trim() ?? ""}`.replace(/\s+/g, " "),
        120,
        "head"
      );
      if (seen.has(expression)) continue;
      seen.add(expression);
      findings.push({ path: file.path, expression });
    }
  }
  return findings;
}

/** The findings that should FAIL the check: everything the allowlist does not excuse. */
export function findUnallowedRepoRootedTelemetryPaths(
  files: ScannedFile[],
  allowlist: Record<string, string> = ALLOWLIST
): RepoRootedTelemetryFinding[] {
  return findRepoRootedTelemetryPaths(files).filter((f) => !(f.path in allowlist));
}

/** Allowlist entries that no longer match anything — a fixed writer whose exemption outlived it. */
export function findStaleAllowlistEntries(
  files: ScannedFile[],
  allowlist: Record<string, string> = ALLOWLIST
): string[] {
  const flagged = new Set(findRepoRootedTelemetryPaths(files).map((f) => f.path));
  return Object.keys(allowlist).filter((p) => !flagged.has(p));
}
