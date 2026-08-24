/**
 * Tests for the normalization planner (mt#4448).
 *
 * `planRecord` is a pure function over one record precisely so the preserve/drop decision —
 * the part where a wrong answer destroys data — is testable without a database. The fixtures
 * reproduce the real record shapes measured on prod 2026-08-24.
 */

/* eslint-disable custom/no-real-fs-in-tests -- the unit under test IS filesystem behaviour:
   `writeSnapshotExclusive` exists to rely on the OS honouring O_EXCL. A mocked fs would test
   the mock's `wx` semantics rather than the filesystem's, which is precisely the probe-that-
   cannot-fail trap (mem#704) this test was written to close. Race-free by construction: each
   case gets its own `mkdtempSync` directory and removes it. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CROSSREF_MARKER,
  buildBodyAddition,
  buildSnapshotPath,
  planRecord,
  writeSnapshotExclusive,
} from "./normalize-memory-associations";

const DROP = "drop-recoverable";

/** Plan a record, failing the test if the planner declined it. Narrows away `plan!`. */
function mustPlan(r: Parameters<typeof planRecord>[0]) {
  const plan = planRecord(r);
  if (!plan) throw new Error("expected planRecord to return a plan, got null");
  return plan;
}

function record(over: Partial<Parameters<typeof planRecord>[0]> = {}) {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "a_memory",
    content: "body text",
    description: null,
    tags: [] as string[],
    associations: {} as Record<string, string[]>,
    ...over,
  };
}

describe("planRecord — the preserve/drop decision", () => {
  test("a record with only vocabulary keys is left alone entirely", () => {
    expect(
      planRecord(record({ associations: { tracksTask: ["mt#1709"], relatedTask: ["mt#4386"] } }))
    ).toBeNull();
  });

  test("a record with no associations is left alone", () => {
    expect(planRecord(record())).toBeNull();
  });

  test("a value cited in the BODY is dropped, not preserved", () => {
    const plan = mustPlan(
      record({
        content: "This relates to mt#4317 in passing.",
        associations: { tasks: ["mt#4317"] },
      })
    );
    expect(plan.values).toHaveLength(1);
    expect(plan.values.map((v) => v.disposition)).toEqual([DROP]);
    expect(plan.relatedTaskAdditions).toEqual([]);
    expect(plan.bodyAdditions).toEqual([]);
  });

  test("a value cited only in TAGS is dropped — tags count as recoverable", () => {
    // This is the real `88f953fe` shape: the task id is in the tag list, not the prose.
    const plan = mustPlan(
      record({
        content: "unrelated prose",
        tags: ["mt#4317"],
        associations: { tasks: ["mt#4317"] },
      })
    );
    expect(plan.values.map((v) => v.disposition)).toEqual([DROP]);
  });

  test("a UNIQUE task id is preserved as relatedTask, never tracksTask", () => {
    const plan = mustPlan(record({ content: "no ids here", associations: { tasks: ["mt#3154"] } }));
    expect(plan.values.map((v) => v.disposition)).toEqual(["preserve-relatedTask"]);
    expect(plan.relatedTaskAdditions).toEqual(["mt#3154"]);
  });

  test("a UNIQUE non-task value goes to body text, not to an invented key", () => {
    const plan = mustPlan(
      record({ content: "no ids here", associations: { docs: ["docs/architecture/adr-032.md"] } })
    );
    expect(plan.values.map((v) => v.disposition)).toEqual(["preserve-body-text"]);
    expect(plan.bodyAdditions).toEqual(["docs: docs/architecture/adr-032.md"]);
    expect(plan.relatedTaskAdditions).toEqual([]);
  });

  test("a uuid cited by its 8-char PREFIX in the body counts as recoverable", () => {
    // Comparing the whole uuid would call this unique and write a needless cross-reference.
    const plan = mustPlan(
      record({
        content: "see memory 7b286e2e for context",
        associations: { memories: ["7b286e2e-1111-2222-3333-444444444444"] },
      })
    );
    expect(plan.values.map((v) => v.disposition)).toEqual([DROP]);
  });

  test("a uuid absent from the body is preserved to body text", () => {
    const plan = mustPlan(
      record({
        content: "nothing relevant",
        associations: { memories: ["4b83ff51-0000-0000-0000-000000000000"] },
      })
    );
    expect(plan.values.map((v) => v.disposition)).toEqual(["preserve-body-text"]);
  });

  test("a bare PR number is matched prefix-insensitively against the body", () => {
    const plan = mustPlan(
      record({ content: "landed in PR #3200 yesterday", associations: { prs: ["3200"] } })
    );
    expect(plan.values.map((v) => v.disposition)).toEqual([DROP]);
  });

  test("every divergent key is scheduled for removal even when all its values drop", () => {
    const plan = mustPlan(
      record({ content: "mt#1 mt#2", associations: { tasks: ["mt#1"], task: ["mt#2"] } })
    );
    expect(plan.divergentKeys.sort()).toEqual(["task", "tasks"]);
    expect(plan.values.every((v) => v.disposition === DROP)).toBe(true);
  });

  test("vocabulary keys are NOT scheduled for removal alongside divergent ones", () => {
    const plan = mustPlan(
      record({ content: "x", associations: { tracksTask: ["mt#1709"], tasks: ["mt#9999"] } })
    );
    expect(plan.divergentKeys).toEqual(["tasks"]);
  });

  test("the real `2bf00254` shape preserves all three of its unique values", () => {
    const plan = mustPlan(
      record({
        content: "prose that cites none of them",
        associations: { prs: ["3225"], tasks: ["mt#4365", "mt#4235"] },
      })
    );
    expect(plan.relatedTaskAdditions.sort()).toEqual(["mt#4235", "mt#4365"]);
    expect(plan.bodyAdditions).toEqual(["prs: 3225"]);
  });
});

describe("buildBodyAddition", () => {
  test("carries the idempotency marker so a re-run cannot double-append", () => {
    expect(buildBodyAddition(["docs: a.md"])).toContain(CROSSREF_MARKER);
  });

  test("renders one bullet per preserved value", () => {
    const block = buildBodyAddition(["docs: a.md", "prs: 3225"]);
    expect(block).toContain("- docs: a.md");
    expect(block).toContain("- prs: 3225");
  });
});

describe("pre-state snapshot safety (PR #3295 R1)", () => {
  test("two paths built in the same millisecond are still distinct", () => {
    // A timestamp-only name collides for two operators, or one retry, inside the same second.
    const paths = new Set(Array.from({ length: 50 }, () => buildSnapshotPath()));
    expect(paths.size).toBe(50);
  });

  test("writing to an existing path THROWS rather than overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "mt4448-snap-"));
    const path = join(dir, "snap.json");

    expect(writeSnapshotExclusive(path, [{ id: "first" }])).toBe(path);
    expect(() => writeSnapshotExclusive(path, [{ id: "second" }])).toThrow("Refusing to proceed");

    // The original survived — this is the property that matters, not just that it threw.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([{ id: "first" }]);
    rmSync(dir, { recursive: true, force: true });
  });
});
