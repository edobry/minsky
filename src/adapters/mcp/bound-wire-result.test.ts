/**
 * mt#4418 — every MCP result passes one bound, and the bound leaves most of them alone.
 *
 * Fixtures are shaped from the tools the corpus measurement actually named
 * (`session_pr_create`, `session_pr_wait-for-review`, `session_pr_checks`,
 * `tasks_list`), not invented, so the thresholds are exercised against the
 * payloads they were chosen for.
 */
import { describe, expect, test } from "bun:test";
import {
  ARRAY_BOUNDING_BUDGET_BYTES,
  ECHO_ELISION_MIN_CHARS,
  MAX_WIRE_ARRAY,
  boundWireResult,
} from "./bound-wire-result";

/** A PR body, the shape `session_pr_create` echoes back (measured avg 6,297 chars). */
const PR_BODY = "## Summary\n\n".concat("Some substantial body prose. ".repeat(300));

/** Big enough to push a result past the array-capping budget. */
function bigChecks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `check-${i}`,
    status: "completed",
    conclusion: "success",
    url: `https://github.com/edobry/minsky/actions/runs/32543137590/job/9695681499${i}`,
  }));
}

describe("boundWireResult — the common case is untouched", () => {
  test("a small result is returned by the SAME reference, not a copy", () => {
    const result = { success: true, commitHash: "abc1234", pushed: true };

    expect(boundWireResult(result, { task: "mt#4418" })).toBe(result);
  });

  test("a non-object result passes straight through", () => {
    expect(boundWireResult("plain text", {})).toBe("plain text");
    expect(boundWireResult(null, {})).toBe(null);
  });

  test("no caller params means nothing to elide", () => {
    const result = { success: true, body: PR_BODY };

    expect(boundWireResult(result, {})).toBe(result);
  });
});

describe("boundWireResult — echo elision runs regardless of size", () => {
  test("a field byte-identical to a long caller string is dropped and marked", () => {
    const shaped = boundWireResult({ success: true, body: PR_BODY }, { body: PR_BODY }) as Record<
      string,
      unknown
    >;

    expect("body" in shaped).toBe(false);
    expect(shaped.bodyOmitted).toBe("echoed-caller-input");
  });

  test("it matches on VALUE, so a differently-named field is still caught", () => {
    // `session_pr_create` takes `body` and returns it inside the PR object.
    const shaped = boundWireResult(
      { success: true, pullRequest: { number: 3239, description: PR_BODY } },
      { body: PR_BODY }
    ) as Record<string, unknown>;

    const pr = shaped.pullRequest as Record<string, unknown>;
    expect("description" in pr).toBe(false);
    expect(pr.descriptionOmitted).toBe("echoed-caller-input");
  });

  test("a SHORT caller string is left alone — ids and branches stay readable", () => {
    const result = { success: true, task: "mt#4418", branch: "task/mt-4418" };

    expect(boundWireResult(result, { task: "mt#4418", branch: "task/mt-4418" })).toBe(result);
  });

  test("a string the command TRANSFORMED is not an echo and survives", () => {
    const transformed = `${PR_BODY}\n\nAppended by the command.`;
    const shaped = boundWireResult(
      { success: true, body: transformed },
      { body: PR_BODY }
    ) as Record<string, unknown>;

    expect(shaped.body).toBe(transformed);
    expect("bodyOmitted" in shaped).toBe(false);
  });

  test("elision alone can bring a result back under budget, leaving arrays whole", () => {
    // The echoed body is the bulk; once gone, the 3 checks need no capping.
    const shaped = boundWireResult(
      { success: true, body: PR_BODY, checks: bigChecks(3) },
      { body: PR_BODY }
    ) as Record<string, unknown>;

    expect(shaped.checks).toHaveLength(3);
    expect("checksTruncation" in shaped).toBe(false);
  });
});

describe("boundWireResult — arrays are capped only when the payload is large", () => {
  test("a big array UNDER the byte budget is returned whole", () => {
    // 60 tiny elements: over MAX_WIRE_ARRAY by count, well under budget by size.
    const result = { success: true, ids: Array.from({ length: 60 }, (_, i) => i) };

    const shaped = boundWireResult(result, {}) as Record<string, unknown>;

    expect(shaped.ids).toHaveLength(60);
    expect("idsTruncation" in shaped).toBe(false);
  });

  test("an over-budget array is capped and reports mt#2817's triple", () => {
    const checks = bigChecks(200);
    const result = { success: true, allPassed: true, checks };

    expect(JSON.stringify(result).length).toBeGreaterThan(ARRAY_BOUNDING_BUDGET_BYTES);

    const shaped = boundWireResult(result, {}) as Record<string, unknown>;

    expect(shaped.checks).toHaveLength(MAX_WIRE_ARRAY);
    expect(shaped.checksTruncation).toEqual({
      returned: MAX_WIRE_ARRAY,
      total: 200,
      truncated: true,
    });
    // The scalar verdict — the thing a caller actually branches on — survives.
    expect(shaped.allPassed).toBe(true);
  });

  test("a NESTED over-budget array is capped — session_pr_wait-for-review's shape", () => {
    const result = {
      success: true,
      matched: true,
      review: { state: "CHANGES_REQUESTED", findings: bigChecks(200) },
    };

    const shaped = boundWireResult(result, {}) as Record<string, unknown>;
    const review = shaped.review as Record<string, unknown>;

    expect(review.findings).toHaveLength(MAX_WIRE_ARRAY);
    expect(review.findingsTruncation).toMatchObject({ total: 200, truncated: true });
    expect(review.state).toBe("CHANGES_REQUESTED");
  });
});

describe("boundWireResult — a self-bounded list tool is never re-capped", () => {
  test("a tasks_list-shaped result keeps every row it chose to return", () => {
    // mt#2817's list tools cap at DEFAULT_LIST_CAP (500) and say so. 500 rows is
    // far over this module's byte budget, and re-capping to 50 would defeat the
    // tool — the array IS what the caller asked for.
    const tasks = Array.from({ length: 500 }, (_, i) => ({
      id: `mt#${i}`,
      title: `A task title long enough to matter for payload size, number ${i}`,
      status: "TODO",
    }));
    const result = { success: true, tasks, returned: 500, total: 900, truncated: true };

    expect(JSON.stringify(result).length).toBeGreaterThan(ARRAY_BOUNDING_BUDGET_BYTES);

    const shaped = boundWireResult(result, {}) as Record<string, unknown>;

    expect(shaped.tasks).toHaveLength(500);
    expect("tasksTruncation" in shaped).toBe(false);
    // Its own metadata is untouched, so the caller still learns 400 were dropped.
    expect(shaped.total).toBe(900);
  });

  test("`truncated: false` also marks a self-bounded result — the flag's presence is the signal", () => {
    const tasks = Array.from({ length: 300 }, (_, i) => ({
      id: `mt#${i}`,
      title: `Another sufficiently long task title for payload size, number ${i}`,
    }));
    const result = { success: true, tasks, returned: 300, total: 300, truncated: false };

    const shaped = boundWireResult(result, {}) as Record<string, unknown>;

    expect(shaped.tasks).toHaveLength(300);
  });
});

describe("boundWireResult — threshold constants are the ones the corpus justified", () => {
  test("the elision floor sits between caller scalars and caller bodies", () => {
    expect(ECHO_ELISION_MIN_CHARS).toBe(200);
    expect("task/mt-4418".length).toBeLessThan(ECHO_ELISION_MIN_CHARS);
    expect(PR_BODY.length).toBeGreaterThan(ECHO_ELISION_MIN_CHARS);
  });

  test("the array budget clears session_pr_checks' measured maximum", () => {
    // 4,860 chars was the largest session_pr_checks payload in the corpus;
    // routine CI polling must never trip the array pass.
    expect(ARRAY_BOUNDING_BUDGET_BYTES).toBeGreaterThan(4_860);
  });
});
