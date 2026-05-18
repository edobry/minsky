/**
 * Regression test: kind plumbing through tasks_create surface (mt#1871)
 *
 * mt#1812 added the `kind` field on Task and the workflow registry, but the
 * tasks_create MCP/CLI surface didn't accept `--kind` — so umbrella tasks were
 * uncreatable except via direct DB modification. mt#1871 wired kind through:
 * schema → domain adapter → backend.createTaskFromTitleAndSpec.
 *
 * These tests verify:
 *   1. `kind` is forwarded into the CreateTaskOptions passed to the backend.
 *   2. Default behavior is unchanged when `--kind` is omitted (option absent,
 *      backend default takes over).
 *   3. Unknown kinds are rejected up front with a clear ValidationError
 *      naming the valid set.
 */

import { describe, it, expect, mock } from "bun:test";
import { createTaskFromParams, createTaskFromTitleAndSpec } from "./mutation-commands";
import type { TaskServiceInterface } from "../taskService";

const BAD_SPEC = "# Bad\n\n## Summary\nx";

function makeMockService(): {
  service: TaskServiceInterface;
  createMock: ReturnType<typeof mock>;
} {
  const createMock = mock(async (title: string, _spec: string, _options?: unknown) => ({
    id: "mt#9999",
    title,
    status: "TODO",
    kind: (_options as { kind?: string })?.kind ?? "implementation",
    backend: "minsky",
  }));

  const service = {
    listTasks: mock(async () => []),
    getTask: mock(async () => null),
    getTaskStatus: mock(async () => undefined),
    setTaskStatus: mock(async () => {}),
    createTaskFromTitleAndSpec: createMock,
    deleteTask: mock(async () => false),
    getWorkspacePath: () => "/mock",
    getCapabilities: () => ({ canCreate: true }),
    getTaskSpecContent: mock(async () => ({ task: null, specPath: "", content: "" })),
    listBackends: () => [{ name: "minsky", prefix: "mt" }],
    updateTask: mock(async () => {}),
  } as unknown as TaskServiceInterface;

  return { service, createMock };
}

describe("createTaskFromParams kind plumbing (mt#1871)", () => {
  it("forwards `kind: umbrella` into backend createTaskFromTitleAndSpec options", async () => {
    const { service, createMock } = makeMockService();

    await createTaskFromParams(
      {
        title: "Test umbrella task",
        spec: "# Test umbrella task\n\n## Summary\nx",
        kind: "umbrella",
        force: false,
      },
      { taskService: service }
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0];
    const options = callArgs?.[2] as { kind?: string } | undefined;
    expect(options?.kind).toBe("umbrella");
  });

  it("omits kind from options when --kind is not specified (backend default applies)", async () => {
    const { service, createMock } = makeMockService();

    await createTaskFromParams(
      {
        title: "Default-kind task",
        spec: "# Default\n\n## Summary\nx",
        force: false,
      },
      { taskService: service }
    );

    const callArgs = createMock.mock.calls[0];
    const options = callArgs?.[2] as { kind?: string } | undefined;
    expect(options?.kind).toBeUndefined();
  });

  it("rejects unknown kinds with a ValidationError that names valid kinds", async () => {
    const { service } = makeMockService();

    await expect(
      createTaskFromParams(
        {
          title: "Bad kind",
          spec: BAD_SPEC,
          kind: "epic", // not in WORKFLOWS
          force: false,
        },
        { taskService: service }
      )
    ).rejects.toThrow(/Unknown task kind/);

    await expect(
      createTaskFromParams(
        {
          title: "Bad kind 2",
          spec: BAD_SPEC,
          kind: "ummbrella", // typo
          force: false,
        },
        { taskService: service }
      )
    ).rejects.toThrow(/implementation/);
  });

  it("accepts kind: implementation explicitly (round-trip identity case)", async () => {
    const { service, createMock } = makeMockService();

    await createTaskFromParams(
      {
        title: "Explicit implementation",
        spec: "# Explicit\n\n## Summary\nx",
        kind: "implementation",
        force: false,
      },
      { taskService: service }
    );

    const options = createMock.mock.calls[0]?.[2] as { kind?: string } | undefined;
    expect(options?.kind).toBe("implementation");
  });
});

describe("createTaskFromTitleAndSpec (public) kind plumbing (mt#1871)", () => {
  it("forwards kind through the public createTaskFromTitleAndSpec surface", async () => {
    const { service, createMock } = makeMockService();

    await createTaskFromTitleAndSpec(
      {
        title: "Umbrella via public surface",
        spec: "# Umbrella\n\n## Summary\nx",
        kind: "umbrella",
        force: false,
      },
      { taskService: service }
    );

    const options = createMock.mock.calls[0]?.[2] as { kind?: string } | undefined;
    expect(options?.kind).toBe("umbrella");
  });

  it("rejects unknown kinds via the public surface too", async () => {
    const { service } = makeMockService();

    await expect(
      createTaskFromTitleAndSpec(
        {
          title: "Bad",
          spec: BAD_SPEC,
          kind: "rfc",
          force: false,
        },
        { taskService: service }
      )
    ).rejects.toThrow(/Unknown task kind/);
  });
});
