/**
 * Unit tests for `createSessionPrChecksCommand`'s catch-block ordering
 * (mt#2888, PR #2018 R1 regression fix).
 *
 * `getDeps` is `await`-ed first inside the command's `try` block, so a
 * throwing `getDeps` reaches the SAME `catch` block a throwing domain call
 * would — the simplest injection point available without mocking the
 * `sessionPrChecks` module import.
 */
import { describe, expect, test } from "bun:test";
import {
  createSessionPrChecksCommand,
  formatChecksStatusLine,
  shapeChecksResultForStructuredOutput,
} from "./pr-checks-command";
import { ResourceNotFoundError, ValidationError } from "@minsky/domain/errors/index";
import type { ChecksResult } from "@minsky/domain/repository/github-pr-checks";

describe("createSessionPrChecksCommand — error-classification ordering (mt#2888)", () => {
  const CTX = { interface: "cli" } as any;

  test("REGRESSION: a ResourceNotFoundError whose message contains 'rate limit' passes through with its ORIGINAL type, not reclassified", async () => {
    const err = new ResourceNotFoundError(
      "Session 'my-session' not found (internal rate limit tracker had no entry)"
    );
    const command = createSessionPrChecksCommand(async () => {
      throw err;
    });
    await expect(command.execute({ sessionId: "my-session" }, CTX)).rejects.toBe(err);
  });

  test("REGRESSION: a ValidationError whose message contains '(HTTP 5' passes through with its ORIGINAL type, not reclassified", async () => {
    const err = new ValidationError("Invalid timeoutSeconds: '(HTTP 500-ish looking value)'");
    const command = createSessionPrChecksCommand(async () => {
      throw err;
    });
    await expect(command.execute({ sessionId: "my-session" }, CTX)).rejects.toBe(err);
  });

  test("a genuine GitHub-degraded MinskyError (handleOctokitError's exact headline) IS classified as SERVICE_DEGRADED", async () => {
    const command = createSessionPrChecksCommand(async () => {
      throw new Error(
        "GitHub API degraded/unavailable (HTTP 503)\n\nGitHub's API returned a server error for this request."
      );
    });
    try {
      await command.execute({ sessionId: "my-session" }, CTX);
      throw new Error("expected command.execute to throw");
    } catch (err) {
      expect((err as { payload?: { code?: string } })?.payload?.code).toBe("SERVICE_DEGRADED");
    }
  });

  test("an unrelated generic error still falls through to the original 'Failed to get session PR checks' wrap", async () => {
    const command = createSessionPrChecksCommand(async () => {
      throw new Error("network cable unplugged");
    });
    await expect(command.execute({ sessionId: "my-session" }, CTX)).rejects.toThrow(
      "Failed to get session PR checks: network cable unplugged"
    );
  });
});

describe("formatChecksStatusLine — the mergeBlocked branch exists (mt#4182, PR #3042 R1)", () => {
  test("REGRESSION: a merge-blocked result renders the REASON, not '0 check(s) pending'", () => {
    // The exact shape mt#4182 produces: allPassed false, no timeout, and both
    // counts zero because CI never dispatched. Before R1 no branch matched it,
    // so it landed on the fallthrough and rendered "⏳ 0 check(s) pending" —
    // "CI is still starting" for a PR whose CI can never start.
    //
    // What this pins is the branch's EXISTENCE, not its position: a control
    // that demoted it to just above the fallthrough left every test green, and
    // only removing it entirely turns this red.
    const line = formatChecksStatusLine({
      allPassed: false,
      mergeBlocked: "PR has merge conflicts, so GitHub could not build the merge ref",
      summary: { failed: 0, pending: 0 },
    });
    expect(line).toContain("merge conflicts");
    expect(line).not.toContain("pending");
  });

  test("the other branches are unchanged when mergeBlocked is absent", () => {
    expect(
      formatChecksStatusLine({ allPassed: true, summary: { failed: 0, pending: 0 } })
    ).toContain("All checks passed");
    expect(
      formatChecksStatusLine({
        allPassed: false,
        timedOut: true,
        summary: { failed: 0, pending: 2 },
      })
    ).toContain("Timed out");
    expect(
      formatChecksStatusLine({ allPassed: false, summary: { failed: 3, pending: 0 } })
    ).toContain("3 check(s) failed");
    expect(
      formatChecksStatusLine({ allPassed: false, summary: { failed: 0, pending: 1 } })
    ).toContain("1 check(s) pending");
  });
});

describe("shapeChecksResultForStructuredOutput — the mt#4657 projection", () => {
  /** A realistic all-green result: 16 checks, the corpus average. */
  function greenResult(): ChecksResult {
    const checks = Array.from({ length: 16 }, (_, i) => ({
      name: `job-with-a-realistic-name-${i}`,
      status: "completed",
      conclusion: "success",
      url: `https://github.com/edobry/minsky/actions/runs/33031927106/job/9838616644${i}`,
    }));
    return {
      allPassed: true,
      summary: { total: 16, passed: 16, failed: 0, pending: 0 },
      checks,
    };
  }

  test("green: the per-check array is dropped entirely — no `checks`, no `failingChecks`", () => {
    const shaped = shapeChecksResultForStructuredOutput(greenResult(), undefined);
    expect(shaped.allPassed).toBe(true);
    expect(shaped.summary).toEqual({ total: 16, passed: 16, failed: 0, pending: 0 });
    expect("checks" in shaped).toBe(false);
    expect("failingChecks" in shaped).toBe(false);
  });

  test("green: `fullBody: true` restores the complete breakdown unchanged", () => {
    const full = greenResult();
    const shaped = shapeChecksResultForStructuredOutput(full, true);
    expect(shaped).toEqual(full);
    expect((shaped as ChecksResult).checks).toHaveLength(16);
  });

  test("AT2: the green payload is materially smaller, and CONSTANT in the check count", () => {
    const sixteen = JSON.stringify(shapeChecksResultForStructuredOutput(greenResult(), undefined));

    // Same result with four times the checks — the trimmed payload must not grow.
    const many = greenResult();
    many.checks = [...many.checks, ...many.checks, ...many.checks, ...many.checks];
    many.summary = { total: 64, passed: 64, failed: 0, pending: 0 };
    const sixtyFour = JSON.stringify(shapeChecksResultForStructuredOutput(many, undefined));

    expect(sixteen.length).toBeLessThan(200);
    expect(sixtyFour.length).toBe(sixteen.length);
    // ...against a full payload that is an order of magnitude larger.
    expect(JSON.stringify(greenResult()).length).toBeGreaterThan(1500);
  });

  test("AT3: a failing check keeps name, conclusion AND url — the url is the drill-down's only runId source", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 3, passed: 2, failed: 1, pending: 0 },
      checks: [
        {
          name: "typecheck-infra",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/edobry/minsky/actions/runs/33031927106/job/1",
        },
        {
          name: "build",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/edobry/minsky/actions/runs/33031927106/job/2",
        },
        {
          name: "minsky-reviewer/findings",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/edobry/minsky/runs/98386421542",
        },
      ],
    };

    const shaped = shapeChecksResultForStructuredOutput(result, undefined) as {
      failingChecks: typeof result.checks;
    };

    expect(shaped.failingChecks).toHaveLength(1);
    expect(shaped.failingChecks[0]).toEqual({
      name: "build",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/edobry/minsky/actions/runs/33031927106/job/2",
    });
    // The workflow-run id `forge_ci_run_view_log` needs survives the trim.
    expect(shaped.failingChecks[0]?.url).toContain("/runs/33031927106/");
    // ...and the two passing entries are gone.
    expect(JSON.stringify(shaped)).not.toContain("typecheck-infra");
    expect(JSON.stringify(shaped)).not.toContain("minsky-reviewer/findings");
  });

  test("a still-PENDING check is not-passing and is retained — a red build stays diagnosable", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 2, passed: 1, failed: 0, pending: 1 },
      checks: [
        { name: "lint", status: "completed", conclusion: "success", url: "https://x/1" },
        { name: "test", status: "in_progress", conclusion: null, url: "https://x/2" },
      ],
    };
    const shaped = shapeChecksResultForStructuredOutput(result, undefined) as {
      failingChecks: typeof result.checks;
    };
    expect(shaped.failingChecks.map((c) => c.name)).toEqual(["test"]);
  });

  test("`neutral` and `skipped` count as passing and are dropped", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 3, passed: 2, failed: 1, pending: 0 },
      checks: [
        { name: "neutral-one", status: "completed", conclusion: "neutral", url: null },
        { name: "skipped-one", status: "completed", conclusion: "skipped", url: null },
        { name: "cancelled-one", status: "completed", conclusion: "cancelled", url: null },
      ],
    };
    const shaped = shapeChecksResultForStructuredOutput(result, undefined) as {
      failingChecks: typeof result.checks;
    };
    expect(shaped.failingChecks.map((c) => c.name)).toEqual(["cancelled-one"]);
  });

  test("`mergeBlocked` and `timedOut` survive the trim (mt#4182 / mt#4020 reasons are not per-check detail)", () => {
    const shaped = shapeChecksResultForStructuredOutput(
      {
        allPassed: false,
        timedOut: true,
        mergeBlocked: "PR has merge conflicts, so GitHub could not build the merge ref",
        summary: { total: 0, passed: 0, failed: 0, pending: 0 },
        checks: [],
      },
      undefined
    );
    expect(shaped.timedOut).toBe(true);
    expect((shaped as { mergeBlocked?: string }).mergeBlocked).toContain("merge conflicts");
  });
});
