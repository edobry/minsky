/**
 * Tests for the mt#4134 diff-shaped-guard replay harness
 * (`scripts/lib/diff-guard-backtest.ts`).
 *
 * The window accounting carries the regression this task exists for: the
 * predecessor script echoed its requested `--days` value into the report while
 * the `--limit` ceiling bound first, which put a 12-day sample into three
 * durable artifacts under the label "60-day backtest". The numbers in
 * `describeBound` below are that real case (1148 first-parent commits inside 60
 * days, 400 walked, observed 2026-08-14), not invented ones.
 */

import { describe, test, expect } from "bun:test";
import {
  buildLogArgs,
  computeWalkedWindow,
  describeBound,
  describeWindow,
  formatReport,
  parseCommitLines,
  runDiffGuardBacktest,
  type BacktestCommit,
  type CommitSelection,
  type DiffGuardAdapter,
} from "./diff-guard-backtest";

/**
 * The unit separator `git log --format=%H%x1f...` emits between fields.
 *
 * Built by code point rather than written as a literal: a raw 0x1F byte in
 * source is invisible in every diff and review surface this file passes through.
 */
const US = String.fromCharCode(31);

function logLine(hash: string, committedAt: string, subject: string): string {
  return [hash, committedAt, subject].join(US);
}

function commit(overrides: Partial<BacktestCommit> = {}): BacktestCommit {
  return {
    hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    committedAt: "2026-08-14T00:00:00-04:00",
    subject: "some subject",
    ...overrides,
  };
}

/** The 400-commit range mt#4134 measured over — pinned so it stays reproducible. */
const PINNED_RANGE = "1efacf82d^..285927521";

const RELATIVE: CommitSelection = { days: 60, limit: 400 };
const PINNED: CommitSelection = { revRange: PINNED_RANGE, days: 60, limit: 400 };

describe("buildLogArgs", () => {
  test("a rev-range is passed through and the ceilings are dropped", () => {
    const args = buildLogArgs(PINNED);
    expect(args).toContain(PINNED_RANGE);
    expect(args.some((a) => a.startsWith("--since="))).toBe(false);
    expect(args.some((a) => a.startsWith("--max-count="))).toBe(false);
  });

  test("without a rev-range both ceilings are applied", () => {
    const args = buildLogArgs(RELATIVE);
    expect(args).toContain("--since=60 days ago");
    expect(args).toContain("--max-count=400");
  });
});

describe("parseCommitLines", () => {
  test("splits hash / date / subject and drops blank lines", () => {
    const stdout = [logLine("abc123", "2026-08-01T10:00:00-04:00", "fix: one"), "", ""].join("\n");
    expect(parseCommitLines(stdout)).toEqual([
      { hash: "abc123", committedAt: "2026-08-01T10:00:00-04:00", subject: "fix: one" },
    ]);
  });

  test("a subject carrying colons and parens survives intact", () => {
    const stdout = logLine("abc123", "2026-08-01T10:00:00-04:00", "fix(mt#1): a: subject");
    expect(parseCommitLines(stdout)[0]?.subject).toBe("fix(mt#1): a: subject");
  });
});

describe("computeWalkedWindow", () => {
  const walked = [
    commit({ hash: "newest", committedAt: "2026-08-14T00:00:00-04:00" }),
    commit({ hash: "oldest", committedAt: "2026-08-01T18:43:39-04:00" }),
  ];

  test("reports the span actually walked, not the span requested", () => {
    const window = computeWalkedWindow(walked, RELATIVE, 1148);
    expect(window.commitCount).toBe(2);
    expect(window.oldest?.hash).toBe("oldest");
    expect(window.newest?.hash).toBe("newest");
    expect(window.spanDays).toBeLessThan(13);
    expect(window.spanDays).toBeGreaterThan(11);
  });

  test("the count ceiling binding is recognized as such", () => {
    // More commits fall inside --days than were returned: --limit bound.
    expect(computeWalkedWindow(walked, RELATIVE, 1148).boundBy).toBe("limit");
  });

  test("the day ceiling binding is recognized as such", () => {
    // Everything inside --days was returned: the count ceiling was not reached.
    expect(computeWalkedWindow(walked, RELATIVE, 2).boundBy).toBe("days");
  });

  test("a pinned range is neither", () => {
    expect(computeWalkedWindow(walked, PINNED).boundBy).toBe("rev-range");
  });

  test("an unreadable within-days count is 'unknown', not silently 'days'", () => {
    // PR #3001 R1: coalescing undefined to 0 made this compare 0 > 2 and answer
    // "days" — asserting a bound with no evidence, which is the same defect
    // class this module exists to prevent.
    expect(computeWalkedWindow(walked, RELATIVE, undefined).boundBy).toBe("unknown");
  });

  test("an unparseable commit date leaves the span undefined rather than 0", () => {
    // 0 is a legitimate span (all commits same day), so coercing to it would
    // print a confident wrong figure instead of an absent one.
    const broken = [commit({ committedAt: "not-a-date" }), commit({ committedAt: "also-not" })];
    const window = computeWalkedWindow(broken, PINNED);
    expect(window.spanDays).toBeUndefined();
    expect(describeWindow(window)).toContain("span unknown");
  });

  test("an empty walk is representable rather than a crash", () => {
    const window = computeWalkedWindow([], RELATIVE, 1148);
    expect(window.boundBy).toBe("empty");
    expect(window.commitCount).toBe(0);
    expect(describeWindow(window)).toBe("no commits in range");
  });
});

describe("describeBound", () => {
  test("a limit-bound walk says the requested day window is NOT covered", () => {
    const text = describeBound(computeWalkedWindow([commit(), commit()], RELATIVE, 1148));
    expect(text).toContain("--limit 400");
    expect(text).toContain("1148");
    expect(text).toContain("NOT covered");
  });

  test("a day-bound walk does not claim the count ceiling bound it", () => {
    const text = describeBound(computeWalkedWindow([commit(), commit()], RELATIVE, 2));
    expect(text).toContain("--days 60");
    expect(text).not.toContain("NOT covered");
  });

  test("a pinned range advertises its reproducibility", () => {
    const text = describeBound(computeWalkedWindow([commit()], PINNED));
    expect(text).toContain(PINNED_RANGE);
    expect(text).toContain("reproducible");
  });

  test("an unknown bound says so and warns off the --days figure", () => {
    const text = describeBound(computeWalkedWindow([commit(), commit()], RELATIVE, undefined));
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("Do not describe this sample by --days 60");
  });
});

/** A guard that fires on any diff containing its trigger token. */
function fakeAdapter(trigger: string): DiffGuardAdapter<string> {
  return {
    name: "fake-guard",
    candidateLabel: "saw a candidate:",
    confidence: "test fixture",
    evaluate(diff) {
      const candidate = diff.includes("candidate");
      return { findings: diff.includes(trigger) ? [trigger] : [], candidate };
    },
    describe: (findings) => findings.map((f) => `found ${f}`),
  };
}

function fakeGit(diffs: Record<string, string>, commitsWithinDays = "2\n") {
  return {
    runGit: async (args: readonly string[]) => {
      if (args[0] === "log") {
        return [
          logLine("c1", "2026-08-14T00:00:00-04:00", "first"),
          logLine("c2", "2026-08-13T00:00:00-04:00", "second"),
        ].join("\n");
      }
      if (args[0] === "rev-list") return commitsWithinDays;
      return diffs[args[args.length - 1] as string] ?? "";
    },
  };
}

describe("runDiffGuardBacktest", () => {
  test("counts fires, candidates, and the rate over the walked commits", async () => {
    const report = await runDiffGuardBacktest(
      fakeAdapter("BOOM"),
      RELATIVE,
      fakeGit({ c1: "candidate BOOM here", c2: "candidate but quiet" })
    );
    expect(report.commitsEvaluated).toBe(2);
    expect(report.candidateCommits).toBe(2);
    expect(report.commitsThatWouldFire).toBe(1);
    expect(report.fireRatePercent).toBe(50);
    expect(report.fires[0]?.commit).toBe("c1");
    expect(report.fires[0]?.lines).toEqual(["found BOOM"]);
  });

  test("a commit the guard declines is not counted as a candidate", async () => {
    const report = await runDiffGuardBacktest(
      fakeAdapter("BOOM"),
      RELATIVE,
      fakeGit({ c1: "nothing", c2: "nothing" })
    );
    expect(report.candidateCommits).toBe(0);
    expect(report.commitsThatWouldFire).toBe(0);
    expect(report.fireRatePercent).toBe(0);
  });

  test("setup runs once, before any diff is evaluated", async () => {
    const order: string[] = [];
    const adapter: DiffGuardAdapter<string> = {
      ...fakeAdapter("BOOM"),
      setup: async () => {
        order.push("setup");
      },
      evaluate: (diff) => {
        order.push("evaluate");
        return { findings: diff.includes("BOOM") ? ["BOOM"] : [] };
      },
    };
    await runDiffGuardBacktest(adapter, RELATIVE, fakeGit({ c1: "BOOM", c2: "BOOM" }));
    expect(order).toEqual(["setup", "evaluate", "evaluate"]);
  });

  test("findings are carried uncapped even when the display rendering truncates", async () => {
    // The machine-readable half must not inherit the terminal's sample cap —
    // a hand-classification pass reading --json would silently see less than
    // the guard found.
    const capping: DiffGuardAdapter<string> = {
      name: "capping-guard",
      confidence: "test fixture",
      evaluate: () => ({ findings: ["a", "b", "c", "d", "e"] }),
      describe: (findings) => findings.slice(0, 2).map((f) => `found ${f}`),
    };
    const report = await runDiffGuardBacktest(capping, RELATIVE, fakeGit({ c1: "x", c2: "x" }));
    expect(report.fires[0]?.lines).toHaveLength(2);
    expect(report.fires[0]?.findings).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("a git failure propagates instead of becoming an empty walk", async () => {
    // The harness reports an empty walk as "No commits in range" — a statement
    // about the repo. A swallowed git error would be rendered as exactly that.
    const failing = {
      runGit: async () => {
        throw new Error("fatal: bad revision 'nope^..nope'");
      },
    };
    await expect(runDiffGuardBacktest(fakeAdapter("BOOM"), PINNED, failing)).rejects.toThrow(
      "bad revision"
    );
  });

  test("an unparseable within-days count reaches the report as 'unknown'", async () => {
    const report = await runDiffGuardBacktest(
      fakeAdapter("BOOM"),
      RELATIVE,
      fakeGit({ c1: "BOOM", c2: "BOOM" }, "not-a-number\n")
    );
    expect(report.window.boundBy).toBe("unknown");
    expect(formatReport(report)).toContain("UNKNOWN");
  });

  test("a pinned range skips the within-days count entirely", async () => {
    const seen: string[][] = [];
    const deps = {
      runGit: async (args: readonly string[]) => {
        seen.push([...args]);
        if (args[0] === "log") return logLine("c1", "2026-08-14T00:00:00-04:00", "first");
        return "BOOM";
      },
    };
    const report = await runDiffGuardBacktest(fakeAdapter("BOOM"), PINNED, deps);
    expect(seen.some((a) => a[0] === "rev-list")).toBe(false);
    expect(report.window.boundBy).toBe("rev-range");
  });
});

describe("formatReport", () => {
  test("the printed window is the walked one and the bound is named", async () => {
    const report = await runDiffGuardBacktest(
      fakeAdapter("BOOM"),
      RELATIVE,
      fakeGit({ c1: "candidate BOOM", c2: "quiet" }, "1148\n")
    );
    const text = formatReport(report);
    expect(text).toContain("2 commits, 2026-08-13 -> 2026-08-14 (1 days)");
    expect(text).toContain("NOT covered");
    expect(text).toContain("saw a candidate:");
    expect(text).toContain("found BOOM");
  });
});
