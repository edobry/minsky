/**
 * Schema-level guards on the task create params (mt#4808).
 *
 * `projectId` is an INTERNAL field: the adapter resolves it and threads it
 * through so the backend can stamp per call, and `tasks.create`'s own params
 * map does not expose it. But `createTaskFromTitleAndSpec` is a domain-API
 * entry point in its own right, and this schema is the only runtime boundary
 * between a caller and `tasks.project_id` — `CreateTaskOptions.projectId` is a
 * TypeScript type, which a JS caller or a loosely-typed one does not have to
 * honor. So the value is validated as a uuid here (PR #3525 R1) rather than
 * accepted as an arbitrary string and handed to persistence.
 *
 * This does NOT weaken the fail-open posture the rest of mt#4808 is built on:
 * that covers a project which could not be RESOLVED — which yields `undefined`,
 * a legal input asserted below — not a caller supplying a value that is not a
 * project id.
 */

import { describe, expect, test } from "bun:test";
import { taskCreateFromTitleAndSpecParamsSchema } from "./tasks";

const PEEZOMBIE_ID = "2ef29b41-413e-4ecf-a61b-e695697e7d82";

/** The minimum a create needs; `spec` is required by the schema's refine. */
function createParams(extra: Record<string, unknown> = {}) {
  return { title: "T", spec: "spec body", ...extra };
}

describe("taskCreateFromTitleAndSpecParamsSchema — projectId (mt#4808)", () => {
  test("accepts a uuid", () => {
    const parsed = taskCreateFromTitleAndSpecParamsSchema.parse(
      createParams({ projectId: PEEZOMBIE_ID })
    );

    expect(parsed.projectId).toBe(PEEZOMBIE_ID);
  });

  test("accepts its absence — an unresolved project is the fail-open case", () => {
    const parsed = taskCreateFromTitleAndSpecParamsSchema.parse(createParams());

    expect(parsed.projectId).toBeUndefined();
  });

  test("REJECTS a non-uuid rather than passing it through to the insert", () => {
    const result = taskCreateFromTitleAndSpecParamsSchema.safeParse(
      createParams({ projectId: "edobry/peezombie.me" })
    );

    expect(result.success).toBe(false);
  });

  test("rejects an empty string, which a naive `?? ''` upstream could produce", () => {
    const result = taskCreateFromTitleAndSpecParamsSchema.safeParse(
      createParams({ projectId: "" })
    );

    expect(result.success).toBe(false);
  });
});
