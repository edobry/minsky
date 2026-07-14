/**
 * Regression tests for the mt#2762 `kind` filter param definitions.
 *
 * Verifies tasks_list and tasks_search both expose a `kind` parameter whose
 * schema is the shared, workflow-registry-derived enum (TaskParameters.kind) —
 * the same schema tasks_edit already uses — so CLI (`--kind umbrella`) and MCP
 * surfaces share one source of truth for valid kinds. Per mt#2759: a param's
 * `defaultValue` field (not a Zod `.default()`) is what CLI/MCP bridges
 * materialize; `kind` intentionally has neither — it's optional-no-default, so
 * omitting it applies no kind filter.
 */
import { describe, test, expect } from "bun:test";
import { tasksListParams, tasksSearchParams, taskEditParams } from "./task-parameters";
import { WORKFLOWS } from "@minsky/domain/tasks/workflows";

const KNOWN_KINDS = Object.keys(WORKFLOWS);

describe("tasks_list / tasks_search kind filter param (mt#2762)", () => {
  test("tasksListParams exposes a `kind` param", () => {
    expect(tasksListParams).toHaveProperty("kind");
  });

  test("tasksSearchParams exposes a `kind` param", () => {
    expect(tasksSearchParams).toHaveProperty("kind");
  });

  test("tasksListParams.kind is not required and has no defaultValue (mt#2759)", () => {
    expect(tasksListParams.kind.required).toBeFalsy();
    expect(tasksListParams.kind.defaultValue).toBeUndefined();
  });

  test("tasksSearchParams.kind is not required and has no defaultValue (mt#2759)", () => {
    expect(tasksSearchParams.kind.required).toBeFalsy();
    expect(tasksSearchParams.kind.defaultValue).toBeUndefined();
  });

  test("tasksListParams.kind reuses the same schema object as taskEditParams.kind", () => {
    // Single source of truth: both read paths and the edit command validate
    // against the same workflow-registry-derived enum (TaskParameters.kind).
    expect(tasksListParams.kind.schema).toBe(taskEditParams.kind.schema);
    expect(tasksSearchParams.kind.schema).toBe(taskEditParams.kind.schema);
  });

  test("kind schema accepts every known workflow kind", () => {
    for (const kind of KNOWN_KINDS) {
      expect(() => tasksListParams.kind.schema.parse(kind)).not.toThrow();
    }
  });

  test("kind schema rejects an unknown kind", () => {
    expect(() => tasksListParams.kind.schema.parse("not-a-real-kind")).toThrow();
  });
});
