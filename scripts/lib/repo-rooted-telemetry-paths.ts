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
 * A text scan. It handles `path.join(...)` and multi-line argument lists (PR #3528 R1) but still
 * misses: an ALIASED import (`import { join as j }` — undetectable by name), a wrapper helper
 * around `join`/`resolve`, a path assembled across statements or by string concatenation, and one
 * whose root arrives through a parameter with no local assignment. It is a floor under a class
 * that had NO mechanical check at all, not a proof of absence — state that bound rather than
 * reading a clean run as "there are none."
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
  /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:[\w$]+\.)?(?:join|resolve)\(([\s\S]{0,400}?)\)\s*;/g;

/** First argument denotes the repository the agent is working in, rather than the state dir. */
const REPO_ROOTED =
  /findRepoRoot\(|deriveHookRepoRoot\(|repoRoot|workspacePath|process\.cwd\(\)|\bcwd\b/;

/**
 * Telemetry-ish word STEMS, compared against whole identifier segments rather than substrings.
 *
 * PR #3528 R1: a substring match on `log` also matches `cataLOGPath` and `LOGgerConfig`. Word
 * boundaries alone do not fix that, because the names this must CATCH are camelCase — `\blog\b`
 * matches neither `logPath` nor `mainLog`. So the candidate text is SEGMENTED on case and
 * non-alphanumeric boundaries first, and these stems are compared against whole segments.
 */
const TELEMETRY_STEMS = new Set([
  "log",
  "logs",
  "calibration",
  "evaluation",
  "evaluations",
  "baseline",
  "watermark",
  "watermarks",
  "claims",
  "mismatch",
  "observations",
  "jsonl",
]);

/** `WATERMARK_STORE_PATH` -> ["watermark","store","path"]; `catalogPath` -> ["catalog","path"]. */
function segments(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/**
 * Target is telemetry rather than config, build output, or a user-requested artifact. Without
 * this conjunct the scan also returns `.minsky/config.yaml` (project config, correctly
 * repo-local), a graphviz render the operator asked for by path, and a generated Dockerfile —
 * all measured, none of them this class.
 */
function isTelemetryTarget(text: string): boolean {
  return segments(text).some((s) => TELEMETRY_STEMS.has(s));
}

/**
 * Files exempt from the rule, each with the reason and — where the exemption is temporary — the
 * task that retires it. An entry without a reason is not an exemption, it is a silent hole.
 */
// mt#4880 RETIRED all three entries that stood here. They covered the
// `.minsky/calibration-review-*.json` state stores — the watermark store, its lock,
// mt#4164's claim store, and the cadence detector's last-warned store — and every one
// of them opened with `DELIBERATE, AND UNDECIDED`, because the justification they had
// inherited ("still correctly gitignored") is a minsky-repo-only property and therefore
// the exact premise mt#4748 exists to retire.
//
// The decision is now made and implemented: all three stores resolve through
// `@minsky/shared/calibration-review-store-paths` into
// `getMinskyStateDir()/projects/<key>/`, so the scan finds no repo-rooted expression to
// exempt. `findStaleAllowlistEntries` is what would have caught a fixed writer whose
// exemption outlived it; removing the entries in the same change is what keeps it quiet.
//
// An empty allowlist is the correct state, not an oversight — every scanned module now
// resolves telemetry through a shared resolver. A new entry needs a reason AND, if the
// exemption is temporary, the task that retires it.
export const ALLOWLIST: Record<string, string> = {};

/** Every repo-rooted telemetry path expression in the given files, allowlist NOT applied. */
export function findRepoRootedTelemetryPaths(files: ScannedFile[]): RepoRootedTelemetryFinding[] {
  const findings: RepoRootedTelemetryFinding[] = [];
  for (const file of files) {
    const seen = new Set<string>();
    for (const match of file.source.matchAll(PATH_ASSIGNMENT)) {
      const [, name, args] = match;
      if (!name || args === undefined) continue;
      // The ROOT is the first argument; everything after it is the path tail. Splitting on the
      // first comma is approximate for a nested call in argument one, and that is the safe
      // direction: a nested call leaves MORE text in `root`, so `REPO_ROOTED` can only over-match.
      const comma = args.indexOf(",");
      const root = comma === -1 ? args : args.slice(0, comma);
      const rest = comma === -1 ? "" : args.slice(comma + 1);
      if (!REPO_ROOTED.test(root)) continue;
      if (!isTelemetryTarget(`${name} ${rest}`)) continue;
      const expression = safeTruncate(
        `${name} = join(${root.trim()},${rest.trim()}`.replace(/\s+/g, " "),
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
