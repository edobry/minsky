/**
 * Type-level regression tests for mt#2779: handler param types derive from
 * the command's params map, so reading an undeclared `params.<key>` fails to
 * compile. Reproduces the mt#2742 `session_edit-file` shape (a handler read
 * of `params.session` when the declared key is `sessionId`) — pre-mt#2779
 * that compiled via a hand-rolled interface and evaluated to undefined
 * forever.
 *
 * Each `@ts-expect-error` is the type-level assertion (typecheck FAILS if the
 * marked read stops erroring — i.e. if the hole reopens) and is paired with a
 * runtime assertion so the test exercises executable behavior, per the
 * placeholder-test CI gate.
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import {
  defineCommand,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
  type InferParams,
} from "../command-registry";
import { BaseTaskCommand } from "./tasks/base-task-command";

// The mt#2742 shape: `sessionId` is the declared key; `session` never existed.
const editFileShapeParams = {
  sessionId: {
    schema: z.string(),
    description: "declared id key",
    required: false,
  },
  path: {
    schema: z.string(),
    description: "declared path key",
    required: true,
  },
} satisfies CommandParameterMap;

const testCtx = { interface: "test" } as CommandExecutionContext;

describe("InferParams-derived handler param types (mt#2779)", () => {
  test("InferParams exposes declared keys and rejects undeclared reads at compile time", () => {
    type Params = InferParams<typeof editFileShapeParams>;
    const params: Params = { sessionId: "s-1", path: "a.ts" };

    expect(params.sessionId).toBe("s-1");
    expect(params.path).toBe("a.ts");

    // @ts-expect-error -- `session` was never a declared param (mt#2742 bug shape)
    const ghost = params.session;
    expect(ghost).toBeUndefined();
  });

  test("defineCommand contextually types handler params from the map", async () => {
    const cmd = defineCommand({
      id: "test.inferparams.define",
      category: CommandCategory.TASKS,
      name: "define",
      description: "mt#2779 regression fixture",
      parameters: editFileShapeParams,
      execute: async (params) => {
        // @ts-expect-error -- undeclared key read is rejected inside inferred handlers
        const ghost = params.session;
        return { path: params.path, ghost };
      },
    });

    const result = await cmd.execute({ sessionId: "s-2", path: "b.ts" }, testCtx);
    expect(result.path).toBe("b.ts");
    expect(result.ghost).toBeUndefined();
  });

  test("BaseTaskCommand derives execute params from the map generic", async () => {
    class TestCommand extends BaseTaskCommand<typeof editFileShapeParams> {
      readonly id = "test.inferparams.class";
      readonly name = "class";
      readonly description = "mt#2779 regression fixture";
      readonly parameters = editFileShapeParams;

      async execute(
        params: InferParams<typeof editFileShapeParams>,
        _ctx: CommandExecutionContext
      ) {
        // @ts-expect-error -- undeclared key read is rejected in class handlers
        const ghost = params.session;
        return { got: params.path, ghost };
      }
    }

    const result = await new TestCommand().execute({ sessionId: "s-3", path: "c.ts" }, testCtx);
    expect(result.got).toBe("c.ts");
    expect(result.ghost).toBeUndefined();
    // The registration surface carries the map itself, not a parallel type.
    expect(new TestCommand().getRegistration().parameters).toBe(editFileShapeParams);
  });
});
