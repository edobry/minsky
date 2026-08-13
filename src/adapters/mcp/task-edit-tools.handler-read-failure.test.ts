/**
 * Drives the REAL `tasks_spec_patch` handler with a spec read that throws
 * (mt#4108, PR #2973 R1).
 *
 * The sibling `task-edit-tools.read-outcome.test.ts` covers the extracted
 * decision; this covers the handler, which is what the task's acceptance test
 * actually asks for. Both are needed: the decision test pins the RULE, this pins
 * that the handler is wired to it.
 *
 * **No module patching.** `getTaskSpecContentFromParams` takes an optional
 * `taskService` on its deps, and `registerTaskEditTools`'s container is where
 * that comes from — so a container whose task service throws makes the REAL read
 * path fail through the documented seam. That keeps this a test of the handler
 * rather than of a stubbed import (`testing-standards.mdc §Testable Design`).
 * The handler's remaining un-injectable dependencies (mt#3679) are not reached:
 * the read fails first, which is the point.
 */

import { describe, test, expect } from "bun:test";
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerTaskEditTools } from "./task-edit-tools";

const TASK_ID = "mt#4073";
const READ_FAILURE = "write CONNECTION_ENDED";

interface CapturedCommand {
  name: string;
  getHandler: () => Promise<(args: Record<string, unknown>) => Promise<unknown>>;
}

/**
 * A task service that throws on ANY property access.
 *
 * Deliberately a Proxy rather than a stub of one named method: this test should
 * not encode WHICH call `getTaskSpecContentFromParams` makes to read a spec, or
 * it starts failing when that internal changes for reasons unrelated to the
 * behaviour under test.
 */
function throwingTaskService(): unknown {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(READ_FAILURE);
        };
      },
    }
  );
}

function captureSpecPatchHandler(): CapturedCommand {
  const commands: CapturedCommand[] = [];
  const mapper = {
    addCommand: (command: CapturedCommand) => {
      commands.push(command);
    },
  } as unknown as CommandMapper;

  const container = {
    has: (key: string) => key === "persistence" || key === "taskService",
    get: (key: string) => (key === "taskService" ? throwingTaskService() : {}),
  } as unknown as Parameters<typeof registerTaskEditTools>[1];

  registerTaskEditTools(mapper, container);

  const command = commands.find((c) => c.name === "tasks.spec.patch");
  if (!command) throw new Error("tasks.spec.patch was not registered");
  return command;
}

/** The handler may throw or resolve to an error payload; normalize to text. */
async function runHandler(args: Record<string, unknown>): Promise<string> {
  const handler = await captureSpecPatchHandler().getHandler();
  try {
    return JSON.stringify(await handler(args));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("tasks.spec.patch handler, when the spec read throws", () => {
  test("reports the read failure and does NOT claim the task is missing", async () => {
    const output = await runHandler({
      taskId: TASK_ID,
      content: "// ... existing code ...\n## Added\ntext\n// ... existing code ...\n",
    });

    expect(output).toContain("reading its current spec FAILED");
    expect(output).toContain(READ_FAILURE);
    // The originating defect: a transient read failure asserting the task is gone.
    expect(output).not.toContain("task doesn't exist");
  });

  test("refuses marker-less content too, rather than overwriting the spec", async () => {
    // The data-loss half. With no markers and a failed read, `specExists` is
    // false, so mt#2400's fail-closed guard does not fire and the handler would
    // otherwise reach the brand-new-spec direct write.
    const output = await runHandler({
      taskId: TASK_ID,
      content: "a full replacement body with no markers at all",
    });

    expect(output).toContain("reading its current spec FAILED");
    expect(output).toContain("NOT modified");
  });
});
