// Replay a diff-shaped guard over merged commits (mt#4134).
//
// A diff-shaped guard is one whose trigger is the SHAPE of a diff rather than a
// token to grep for: `stale-signal-sweep` (an operator-facing label a branch
// stopped emitting) and `unrendered-result-field-scan` (a `*Result` counter no
// output site renders) are the two in the family today. Both register on
// `session_pr_create`, and neither can be measured from live calibration records
// until enough real PRs have accumulated — which is slow and biased toward
// whatever the repo happened to be doing that week.
//
// This module replays them over history instead. It owns the commit walking, the
// diff fetching, the window accounting, and the reporting; a guard supplies only
// its pure-core evaluation via `DiffGuardAdapter`.
//
// ## What this measures, and what it cannot
//
// The DIFF half is faithful: a merged diff is immutable, so the guard sees
// exactly what it would have seen. Any CORPUS half a guard consults is read as it
// stands TODAY, so a match is evidence the token is quoted somewhere durable now,
// not proof the guard would have reported that same artifact at merge time. Each
// adapter states its own bound via `confidence`.
//
// ## Why the window is reported rather than echoed
//
// `--days` and `--limit` are both CEILINGS, and git applies `--max-count` after
// the date filter, newest-first — so the effective window is whichever binds
// FIRST. The predecessor script echoed the requested `--days` value into its
// header regardless, which is how "60-day backtest — 400 commits, 4 fires"
// entered three durable artifacts describing a sample that spanned 12 days
// (1148 first-parent commits fell inside 60 days, so the 400 cap bound first).
// A window label that does not match the commits walked is precisely what
// `stale-signal-sweep` exists to catch, so this harness reports the span it
// actually walked and names the ceiling that bound it.

/** One commit the replay walked. */
export interface BacktestCommit {
  readonly hash: string;
  readonly committedAt: string;
  readonly subject: string;
}

/** What a guard reports for one commit. */
export interface GuardVerdict<F> {
  readonly findings: readonly F[];
  /**
   * Optional intermediate signal, counted and reported separately — e.g. for
   * `stale-signal-sweep`, "this diff dropped an output label" is the stage
   * BEFORE the corpus query, and the gap between the two counts is the guard's
   * own filter doing its job.
   */
  readonly candidate?: boolean;
}

/** The guard-specific half: everything this harness does not own. */
export interface DiffGuardAdapter<F> {
  readonly name: string;
  /** Header for the intermediate counter; omit when the guard has no stage. */
  readonly candidateLabel?: string;
  /** This guard's replay confidence bound, printed with the report. */
  readonly confidence: string;
  /** Run once before the walk — DB init, config resolution, etc. */
  setup?(): Promise<void>;
  evaluate(diff: string, commit: BacktestCommit): GuardVerdict<F> | Promise<GuardVerdict<F>>;
  /** Sample lines for one commit's findings, for hand-classification. */
  describe(findings: readonly F[]): readonly string[];
}

/** Which commits to walk. `revRange` wins when present. */
export interface CommitSelection {
  readonly revRange?: string;
  readonly days: number;
  readonly limit: number;
}

/**
 * Which ceiling actually bound the walk.
 *
 * `limit` is the one that matters: it means the requested `--days` window was
 * NOT covered, and any figure taken from this run must not be described by it.
 *
 * `unknown` exists because the alternative is the bug this module was written to
 * prevent (PR #3001 R1). Deciding between `limit` and `days` requires the
 * within-days count; when that count could not be obtained, defaulting either
 * way states a bound the run has no evidence for — which is the same shape as
 * printing a requested window over a sample that does not match it.
 */
export type WindowBound = "rev-range" | "limit" | "days" | "unknown" | "empty";

export interface WalkedWindow {
  readonly commitCount: number;
  readonly oldest?: BacktestCommit;
  readonly newest?: BacktestCommit;
  /**
   * Undefined when a commit timestamp could not be parsed.
   *
   * Not zero: `0` is a legitimate span (every commit on the same day), so
   * coercing an unparseable date to it would print a confident, wrong figure —
   * the same defect as `unknown` above, one field over.
   */
  readonly spanDays?: number;
  readonly boundBy: WindowBound;
  readonly requested: CommitSelection;
  /** First-parent commits inside `--days`, for the `limit`-bound comparison. */
  readonly commitsWithinDays?: number;
}

export interface Fire<F> {
  readonly commit: string;
  readonly subject: string;
  /**
   * Every finding, uncapped — this is what `--json` carries.
   *
   * `lines` beside it is the DISPLAY rendering, which an adapter may truncate
   * for the terminal sample. Capping the machine-readable half too would make a
   * hand-classification pass silently incomplete.
   */
  readonly findings: readonly F[];
  readonly lines: readonly string[];
}

export interface BacktestReport<F> {
  readonly guard: string;
  readonly window: WalkedWindow;
  readonly commitsEvaluated: number;
  readonly candidateCommits: number;
  readonly candidateLabel?: string;
  readonly commitsThatWouldFire: number;
  readonly fireRatePercent: number;
  readonly confidence: string;
  readonly fires: readonly Fire<F>[];
}

export interface BacktestDeps {
  readonly runGit: (args: readonly string[]) => Promise<string>;
}

const COMMIT_FORMAT = "--format=%H%x1f%cI%x1f%s";
const SUBJECT_WIDTH = 90;
const SHORT_HASH_WIDTH = 9;
const SAMPLE_SIZE = 15;

/** The `git log` argv for a selection. Pure, so the two paths are testable. */
export function buildLogArgs(selection: CommitSelection): string[] {
  const base = ["log", "--first-parent", COMMIT_FORMAT];
  if (selection.revRange) return [...base, selection.revRange];
  return [...base, `--since=${selection.days} days ago`, `--max-count=${selection.limit}`];
}

export function parseCommitLines(stdout: string): BacktestCommit[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, committedAt, subject] = line.split("\x1f");
      return { hash: hash ?? "", committedAt: committedAt ?? "", subject: subject ?? "" };
    })
    .filter((c) => c.hash);
}

function daysBetween(olderIso: string, newerIso: string): number | undefined {
  const older = Date.parse(olderIso);
  const newer = Date.parse(newerIso);
  if (Number.isNaN(older) || Number.isNaN(newer)) return undefined;
  return Math.round(((newer - older) / 86_400_000) * 10) / 10;
}

/**
 * Describe the window actually walked.
 *
 * `commitsWithinDays` is what discriminates a `limit`-bound walk from a
 * `days`-bound one: when more first-parent commits fall inside the requested
 * day window than were returned, the count ceiling bound and the day figure is
 * not a description of this sample.
 */
export function computeWalkedWindow(
  commits: readonly BacktestCommit[],
  selection: CommitSelection,
  commitsWithinDays?: number
): WalkedWindow {
  if (commits.length === 0) {
    return { commitCount: 0, boundBy: "empty", requested: selection };
  }
  const newest = commits[0] as BacktestCommit;
  const oldest = commits[commits.length - 1] as BacktestCommit;
  const boundBy: WindowBound = selection.revRange
    ? "rev-range"
    : commitsWithinDays === undefined
      ? "unknown"
      : commitsWithinDays > commits.length
        ? "limit"
        : "days";
  return {
    commitCount: commits.length,
    oldest,
    newest,
    spanDays: daysBetween(oldest.committedAt, newest.committedAt),
    boundBy,
    requested: selection,
    commitsWithinDays,
  };
}

export async function runDiffGuardBacktest<F>(
  adapter: DiffGuardAdapter<F>,
  selection: CommitSelection,
  deps: BacktestDeps
): Promise<BacktestReport<F>> {
  const commits = parseCommitLines(await deps.runGit(buildLogArgs(selection)));

  let commitsWithinDays: number | undefined;
  if (!selection.revRange) {
    const counted = await deps.runGit([
      "rev-list",
      "--first-parent",
      "--count",
      `--since=${selection.days} days ago`,
      "HEAD",
    ]);
    const parsed = Number.parseInt(counted.trim(), 10);
    commitsWithinDays = Number.isNaN(parsed) ? undefined : parsed;
  }

  const window = computeWalkedWindow(commits, selection, commitsWithinDays);
  await adapter.setup?.();

  const fires: Fire<F>[] = [];
  let candidateCommits = 0;
  for (const commit of commits) {
    const diff = await deps.runGit(["show", "--first-parent", "--unified=3", commit.hash]);
    const verdict = await adapter.evaluate(diff, commit);
    if (verdict.candidate) candidateCommits++;
    if (verdict.findings.length === 0) continue;
    fires.push({
      commit: commit.hash.slice(0, SHORT_HASH_WIDTH),
      subject: commit.subject.slice(0, SUBJECT_WIDTH),
      findings: verdict.findings,
      lines: adapter.describe(verdict.findings),
    });
  }

  return {
    guard: adapter.name,
    window,
    commitsEvaluated: commits.length,
    candidateCommits,
    candidateLabel: adapter.candidateLabel,
    commitsThatWouldFire: fires.length,
    fireRatePercent:
      commits.length === 0 ? 0 : Math.round((fires.length / commits.length) * 1000) / 10,
    confidence: adapter.confidence,
    fires,
  };
}

/** One line naming the span walked — never the span requested. */
export function describeWindow(window: WalkedWindow): string {
  if (window.boundBy === "empty") return "no commits in range";
  const oldest = (window.oldest as BacktestCommit).committedAt.slice(0, 10);
  const newest = (window.newest as BacktestCommit).committedAt.slice(0, 10);
  const span =
    window.spanDays === undefined ? "span unknown — unparseable date" : `${window.spanDays} days`;
  return `${window.commitCount} commits, ${oldest} -> ${newest} (${span})`;
}

/**
 * One line naming the ceiling that bound the walk.
 *
 * The `limit` branch is the whole point: it says out loud that the requested
 * day window was not covered, so a reader cannot take the `--days` value as a
 * description of the sample.
 */
export function describeBound(window: WalkedWindow): string {
  switch (window.boundBy) {
    case "rev-range":
      return `--rev-range ${window.requested.revRange} (pinned, reproducible)`;
    case "limit":
      return (
        `--limit ${window.requested.limit} — ${window.commitsWithinDays} first-parent commits ` +
        `fall inside --days ${window.requested.days}, so that window is NOT covered by this sample`
      );
    case "days":
      return `--days ${window.requested.days} (the --limit ${window.requested.limit} ceiling was not reached)`;
    case "unknown":
      return (
        "UNKNOWN — the within-days commit count could not be read, so which ceiling bound this " +
        `walk is unverified. Do not describe this sample by --days ${window.requested.days}.`
      );
    default:
      return "nothing walked";
  }
}

// Takes `unknown` rather than a type parameter: the caller picks an adapter at
// runtime, so `report` is a union of concrete report types there, and a generic
// parameter cannot unify them. `findings` is read-only, so every concrete
// report is assignable to this one.
export function formatReport(report: BacktestReport<unknown>): string {
  const out: string[] = [
    "",
    `Backtest — ${report.guard}`,
    "",
    `  window walked:            ${describeWindow(report.window)}`,
    `  bound by:                 ${describeBound(report.window)}`,
  ];
  if (report.candidateLabel) {
    out.push(`  ${report.candidateLabel.padEnd(25)} ${report.candidateCommits}`);
  }
  out.push(
    `  would have FIRED:         ${report.commitsThatWouldFire}`,
    `  fire rate:                ${report.fireRatePercent}%`,
    `  confidence:               ${report.confidence}`,
    ""
  );
  if (report.fires.length > 0) {
    out.push("Sample (hand-classify these):", "");
    for (const fire of report.fires.slice(0, SAMPLE_SIZE)) {
      out.push(`  ${fire.commit}  ${fire.subject}`);
      for (const line of fire.lines) out.push(`      ${line}`);
      out.push("");
    }
    if (report.fires.length > SAMPLE_SIZE) {
      out.push(`  ... and ${report.fires.length - SAMPLE_SIZE} more (use --json)`, "");
    }
  }
  return out.join("\n");
}
