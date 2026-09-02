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
import {
  tasksListParams,
  tasksSearchParams,
  taskEditParams,
  tasksCreateParams,
  taskCreationParams,
  taskContextParams,
} from "./task-parameters";
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

describe("tasks_create kind param — governance gap fix (mt#3010)", () => {
  test("tasksCreateParams.kind reuses the same registry-derived schema as tasksListParams.kind", () => {
    // Before mt#3010, taskCreationParams.kind was a raw z.string().optional() —
    // every OTHER kind param in this file already used the validated enum, so
    // an unknown kind at CREATE time was accepted by the schema and silently
    // fell back to "implementation" at getWorkflow() time instead of being
    // rejected up front.
    expect(tasksCreateParams.kind.schema).toBe(tasksListParams.kind.schema);
  });

  test("tasksCreateParams.kind schema accepts every known workflow kind", () => {
    for (const kind of KNOWN_KINDS) {
      expect(() => tasksCreateParams.kind.schema.parse(kind)).not.toThrow();
    }
  });

  test("tasksCreateParams.kind schema rejects an unknown kind", () => {
    expect(() => tasksCreateParams.kind.schema.parse("not-a-real-kind")).toThrow();
  });
});

/**
 * ADR-046 (mt#2911): the work-package kind is a first-class registry entry, so
 * every kind param derived from the shared enum must accept it — create, edit,
 * list, search here; tasks_available reuses the same TaskParameters.kind
 * (routing-commands.ts:28) and is exercised end-to-end in
 * task-routing-service.test.ts's default-deny block.
 */
describe("work-package kind flows through every declaration site (ADR-046)", () => {
  test("the workflow registry carries the kind (the single source every schema derives from)", () => {
    expect(Object.keys(WORKFLOWS)).toContain("work-package");
  });

  test.each([
    ["tasksCreateParams", tasksCreateParams.kind],
    ["taskEditParams", taskEditParams.kind],
    ["tasksListParams", tasksListParams.kind],
    ["tasksSearchParams", tasksSearchParams.kind],
  ])('%s.kind schema parses "work-package"', (_name, param) => {
    expect(param.schema.safeParse("work-package").success).toBe(true);
  });
});

/**
 * mt#4808: the inputs the new-task project precedence reads off the adapter's
 * params must actually BE on `tasksCreateParams`.
 *
 * `crud-commands.ts` passes `params.workspace`, `params.repo` and
 * `params.parent` to `resolveNewTaskProjectId`. Those arrive by spread —
 * `parent` from `taskCreationParams`, `workspace`/`repo` from
 * `taskContextParams` — which makes their presence easy to miss by reading
 * `tasksCreateParams`'s literal alone, and a missing one would silently make
 * that precedence leg dead rather than failing. PR #3525 R1 read the create
 * params off `packages/domain/src/schemas/tasks.ts` (which declares no such
 * symbol) and concluded `parent` was absent; these assertions settle it
 * mechanically instead of by re-reading.
 */
describe("tasks_create carries the project-precedence inputs (mt#4808)", () => {
  test.each([["parent"], ["workspace"], ["repo"]])(
    "tasksCreateParams exposes `%s`",
    (name: string) => {
      expect(tasksCreateParams).toHaveProperty(name);
    }
  );

  // `toBe` alone would pass vacuously if BOTH sides were undefined — which is
  // exactly the state these tests exist to catch — so assert definedness first.
  test("`parent` reaches tasksCreateParams via the taskCreationParams spread", () => {
    expect(taskCreationParams.parent).toBeDefined();
    expect(tasksCreateParams.parent).toBe(taskCreationParams.parent);
  });

  test("`workspace` and `repo` reach it via the taskContextParams spread", () => {
    expect(taskContextParams.workspace).toBeDefined();
    expect(taskContextParams.repo).toBeDefined();
    expect(tasksCreateParams.workspace).toBe(taskContextParams.workspace);
    expect(tasksCreateParams.repo).toBe(taskContextParams.repo);
  });

  test("`parent` is optional and accepts a qualified task id", () => {
    expect(tasksCreateParams.parent.required).toBeFalsy();
    expect(tasksCreateParams.parent.schema.safeParse("mt#4723").success).toBe(true);
  });
});
