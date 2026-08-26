/**
 * mt#4418 — the bound changes the wire contract of four named commands, and nothing else.
 *
 * Fixtures are shaped from the tools the corpus measurement actually named
 * (`session_pr_create`, `session_pr_wait-for-review`, `session_pr_checks`,
 * `tasks_list`), not invented, so the thresholds are exercised against the
 * payloads they were chosen for.
 */
import { describe, expect, test } from "bun:test";
import {
  ARRAY_BOUNDING_BUDGET_BYTES,
  BOUNDED_COMMANDS,
  ECHO_ELISION_MIN_CHARS,
  MAX_WIRE_ARRAY,
  boundWireResult,
} from "./bound-wire-result";

/** An enrolled command — the one the task was originally filed on. */
const ENROLLED = "session.pr.checks";
/** Not enrolled, and must stay untouched. */
const UNENROLLED = "tasks.list";

/** A PR body, the shape `session_pr_create` echoes back (measured avg 6,297 chars). */
const PR_BODY = "## Summary\n\n".concat("Some substantial body prose. ".repeat(300));

function bigChecks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `check-${i}`,
    status: "completed",
    conclusion: "success",
    url: `https://github.com/edobry/minsky/actions/runs/32543137590/job/9695681499${i}`,
  }));
}

describe("boundWireResult — only enrolled commands have their contract changed", () => {
  test("an unenrolled command is returned by the SAME reference, whatever its payload", () => {
    const result = { success: true, body: PR_BODY, checks: bigChecks(200) };

    expect(boundWireResult(result, { body: PR_BODY }, UNENROLLED)).toBe(result);
  });

  test("the enrollment list is exactly the four commands the corpus measured", () => {
    expect([...BOUNDED_COMMANDS].sort()).toEqual([
      "session.commit",
      "session.pr.checks",
      "session.pr.create",
      "session.pr.wait-for-review",
    ]);
  });

  test("an enrolled command with a small result is still returned by the same reference", () => {
    const result = { success: true, commitHash: "abc1234", pushed: true };

    expect(boundWireResult(result, { task: "mt#4418" }, ENROLLED)).toBe(result);
  });

  test("a non-object result passes straight through", () => {
    expect(boundWireResult("plain text", {}, ENROLLED)).toBe("plain text");
    expect(boundWireResult(null, {}, ENROLLED)).toBe(null);
  });

  test("no caller params means nothing to elide", () => {
    const result = { success: true, body: PR_BODY };

    expect(boundWireResult(result, {}, ENROLLED)).toBe(result);
  });
});

describe("boundWireResult — echo elision runs regardless of size", () => {
  test("a field byte-identical to a long caller string is dropped and marked", () => {
    const shaped = boundWireResult(
      { success: true, body: PR_BODY },
      { body: PR_BODY },
      ENROLLED
    ) as Record<string, unknown>;

    expect("body" in shaped).toBe(false);
    expect(shaped.bodyOmitted).toBe("echoed-caller-input");
  });

  test("it matches on VALUE, so a differently-named field is still caught", () => {
    const shaped = boundWireResult(
      { success: true, pullRequest: { number: 3390, description: PR_BODY } },
      { body: PR_BODY },
      ENROLLED
    ) as Record<string, unknown>;

    const pr = shaped.pullRequest as Record<string, unknown>;
    expect("description" in pr).toBe(false);
    expect(pr.descriptionOmitted).toBe("echoed-caller-input");
  });

  test("a SHORT caller string is left alone — ids and branches stay readable", () => {
    const result = { success: true, task: "mt#4418", branch: "task/mt-4418" };

    expect(boundWireResult(result, { task: "mt#4418", branch: "task/mt-4418" }, ENROLLED)).toBe(
      result
    );
  });

  test("a string the command TRANSFORMED is not an echo and survives", () => {
    const transformed = `${PR_BODY}\n\nAppended by the command.`;
    const shaped = boundWireResult(
      { success: true, body: transformed },
      { body: PR_BODY },
      ENROLLED
    ) as Record<string, unknown>;

    expect(shaped.body).toBe(transformed);
    expect("bodyOmitted" in shaped).toBe(false);
  });

  test("elision alone can bring a result back under budget, leaving arrays whole", () => {
    const shaped = boundWireResult(
      { success: true, body: PR_BODY, checks: bigChecks(3) },
      { body: PR_BODY },
      ENROLLED
    ) as Record<string, unknown>;

    expect(shaped.checks).toHaveLength(3);
    expect("checksTruncation" in shaped).toBe(false);
  });
});

describe("boundWireResult — arrays are capped only when the payload is large", () => {
  test("a big array UNDER the byte budget is returned whole", () => {
    const result = { success: true, ids: Array.from({ length: 60 }, (_, i) => i) };

    const shaped = boundWireResult(result, {}, ENROLLED) as Record<string, unknown>;

    expect(shaped.ids).toHaveLength(60);
    expect("idsTruncation" in shaped).toBe(false);
  });

  test("an over-budget array is capped and reports mt#2817's triple", () => {
    const checks = bigChecks(200);
    const result = { success: true, allPassed: true, checks };

    expect(JSON.stringify(result).length).toBeGreaterThan(ARRAY_BOUNDING_BUDGET_BYTES);

    const shaped = boundWireResult(result, {}, ENROLLED) as Record<string, unknown>;

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

    const shaped = boundWireResult(result, {}, "session.pr.wait-for-review") as Record<
      string,
      unknown
    >;
    const review = shaped.review as Record<string, unknown>;

    expect(review.findings).toHaveLength(MAX_WIRE_ARRAY);
    expect(review.findingsTruncation).toMatchObject({ total: 200, truncated: true });
    expect(review.state).toBe("CHANGES_REQUESTED");
  });
});

describe("boundWireResult — self-bounded arrays are protected per ARRAY, not per node", () => {
  const selfBoundedRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `mt#${i}`,
      title: `A task title long enough to matter for payload size, number ${i}`,
      status: "TODO",
    }));

  test("the array its own `returned` describes is left intact", () => {
    const tasks = selfBoundedRows(500);
    const result = { success: true, tasks, returned: 500, total: 900, truncated: true };

    expect(JSON.stringify(result).length).toBeGreaterThan(ARRAY_BOUNDING_BUDGET_BYTES);

    const shaped = boundWireResult(result, {}, ENROLLED) as Record<string, unknown>;

    expect(shaped.tasks).toHaveLength(500);
    expect("tasksTruncation" in shaped).toBe(false);
    expect(shaped.total).toBe(900);
  });

  test("a SIBLING array on the same node is still capped — PR #3390 R1", () => {
    // The first version returned early from the whole node on any `truncated`
    // key, so this second array escaped the bound entirely.
    const tasks = selfBoundedRows(500);
    const unrelated = bigChecks(200);
    const result = { success: true, tasks, returned: 500, total: 900, truncated: true, unrelated };

    const shaped = boundWireResult(result, {}, ENROLLED) as Record<string, unknown>;

    expect(shaped.tasks).toHaveLength(500);
    expect(shaped.unrelated).toHaveLength(MAX_WIRE_ARRAY);
    expect(shaped.unrelatedTruncation).toMatchObject({ total: 200, truncated: true });
  });

  test("the walk continues BENEATH a self-bounded node — PR #3390 R1", () => {
    // The early return also stopped recursion, so anything nested under a
    // self-bounded node was unreachable.
    const result = {
      success: true,
      tasks: selfBoundedRows(500),
      returned: 500,
      total: 900,
      truncated: true,
      review: { findings: bigChecks(200) },
    };

    const shaped = boundWireResult(result, {}, ENROLLED) as Record<string, unknown>;
    const review = shaped.review as Record<string, unknown>;

    expect(review.findings).toHaveLength(MAX_WIRE_ARRAY);
    expect(review.findingsTruncation).toMatchObject({ total: 200, truncated: true });
  });

  test("a `truncated` flag whose `returned` does NOT match the array protects nothing", () => {
    // Stale or unrelated metadata must not be readable as a licence.
    const unrelated = bigChecks(200);
    const result = { success: true, unrelated, returned: 7, total: 9, truncated: true };

    const shaped = boundWireResult(result, {}, ENROLLED) as Record<string, unknown>;

    expect(shaped.unrelated).toHaveLength(MAX_WIRE_ARRAY);
  });
});

describe("boundWireResult — threshold constants are the ones the corpus justified", () => {
  test("the elision floor sits between caller scalars and caller bodies", () => {
    expect(ECHO_ELISION_MIN_CHARS).toBe(200);
    expect("task/mt-4418".length).toBeLessThan(ECHO_ELISION_MIN_CHARS);
    expect(PR_BODY.length).toBeGreaterThan(ECHO_ELISION_MIN_CHARS);
  });

  test("the array budget clears session_pr_checks' measured maximum", () => {
    expect(ARRAY_BOUNDING_BUDGET_BYTES).toBeGreaterThan(4_860);
  });
});
