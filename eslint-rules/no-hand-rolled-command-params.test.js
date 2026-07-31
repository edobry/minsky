/**
 * @fileoverview Tests for custom/no-hand-rolled-command-params (mt#2779).
 *
 * The rule requires shared-command execute handlers to derive their param
 * types from the params map (`InferParams<typeof map>`, or no annotation so
 * contextual inference applies) and forbids hand-rolled `*Params` shapes —
 * the mt#2742 Detector-B bug class (undeclared `params.<key>` reads that
 * compile cleanly and are always undefined at runtime).
 *
 * Inline cases cover each message id; the fixture-file cases assert the
 * end-to-end shapes under `__fixtures__/no-hand-rolled-command-params/`.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-hand-rolled-command-params.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(path.join(here, "__fixtures__", "no-hand-rolled-command-params", name), "utf-8");

const commandsFile = "src/adapters/shared/commands/example-command.ts";

// Message ids, extracted once (custom/no-magic-string-duplication).
const MSG = {
  interface: "handRolledInterface",
  aliasLiteral: "handRolledAliasLiteral",
  annotation: "handRolledAnnotation",
  classGeneric: "untiedClassGeneric",
  cast: "paramsCast",
};

const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tsTester.run("no-hand-rolled-command-params", rule, {
  valid: [
    // No annotation — contextual inference from `parameters:`.
    {
      filename: commandsFile,
      code: `
        const cmd = defineCommand({
          parameters: fooParams,
          execute: async (params, ctx) => params.taskId,
        });
      `,
    },
    // Explicit InferParams annotation (property form).
    {
      filename: commandsFile,
      code: `
        const cmd = {
          parameters: fooParams,
          execute: async (params: InferParams<typeof fooParams>) => params.taskId,
        };
      `,
    },
    // Class tied to its map + InferParams execute (method form).
    {
      filename: commandsFile,
      code: `
        class FooCommand extends BaseTaskCommand<typeof fooParams> {
          readonly parameters = fooParams;
          async execute(params: InferParams<typeof fooParams>, ctx: CommandExecutionContext) {
            return params.taskId;
          }
        }
      `,
    },
    // Derived alias — allowed (map-tied by construction).
    {
      filename: commandsFile,
      code: `export type FooParams = InferParams<typeof fooParams>;`,
    },
    // Derived-from-signature alias — allowed (no literal shape).
    {
      filename: commandsFile,
      code: `type MigrateBackendParams = Parameters<TasksMigrateBackendCommand["execute"]>[0];`,
    },
    // Non-*Params interface — out of the rule's namespace.
    {
      filename: commandsFile,
      code: `interface MigrationDetail { id: string; status: string; }`,
    },
    // Non-execute functions may annotate freely.
    {
      filename: commandsFile,
      code: `function helper(input: { taskId?: string }) { return input.taskId; }`,
    },
    // Classes not extending BaseTaskCommand are out of the heritage check.
    {
      filename: commandsFile,
      code: `class Unrelated extends SomethingElse<Foo> {}`,
    },
    // Full valid fixture file.
    {
      filename: commandsFile,
      code: fixture("valid.ts"),
    },
  ],

  invalid: [
    // Hand-rolled params interface declaration.
    {
      filename: commandsFile,
      code: `interface TasksFooParams { taskId: string; ghost?: string; }`,
      errors: [{ messageId: MSG.interface }],
    },
    // Literal-shape *Params alias.
    {
      filename: commandsFile,
      code: `type TasksFooParams = { taskId: string };`,
      errors: [{ messageId: MSG.aliasLiteral }],
    },
    // Literal hidden in an intersection still counts.
    {
      filename: commandsFile,
      code: `type TasksFooParams = InferParams<typeof fooParams> & { ghost?: string };`,
      errors: [{ messageId: MSG.aliasLiteral }],
    },
    // Execute annotated with a named hand-rolled type (property form).
    {
      filename: commandsFile,
      code: `
        const cmd = {
          parameters: fooParams,
          execute: async (params: TasksFooParams) => params.ghost,
        };
      `,
      errors: [{ messageId: MSG.annotation }],
    },
    // Execute annotated with an inline object literal type.
    {
      filename: commandsFile,
      code: `
        const cmd = {
          parameters: fooParams,
          execute: async (params: { taskId?: string; ghost?: string }) => params.ghost,
        };
      `,
      errors: [{ messageId: MSG.annotation }],
    },
    // Execute annotated Record<string, unknown> (the cast-style opener).
    {
      filename: commandsFile,
      code: `
        const cmd = {
          parameters: fooParams,
          execute: async (params: Record<string, unknown>) => params.ghost,
        };
      `,
      errors: [{ messageId: MSG.annotation }],
    },
    // Class generic not `typeof map`.
    {
      filename: commandsFile,
      code: `
        class FooCommand extends BaseTaskCommand<TasksFooParams> {
          readonly parameters = fooParams;
          async execute(params: InferParams<typeof fooParams>, ctx: Ctx) { return 1; }
        }
      `,
      errors: [{ messageId: MSG.classGeneric }],
    },
    // Bare BaseTaskCommand (default generic) is also untied.
    {
      filename: commandsFile,
      code: `
        class FooCommand extends BaseTaskCommand {
          readonly parameters = fooParams;
          async execute(params: InferParams<typeof fooParams>, ctx: Ctx) { return 1; }
        }
      `,
      errors: [{ messageId: MSG.classGeneric }],
    },
    // Class execute method annotated with a hand-rolled type.
    {
      filename: commandsFile,
      code: `
        class FooCommand extends BaseTaskCommand<typeof fooParams> {
          readonly parameters = fooParams;
          async execute(params: TasksFooParams, ctx: Ctx) { return params.ghost; }
        }
      `,
      errors: [{ messageId: MSG.annotation }],
    },
    // Cast to a *Params type.
    {
      filename: commandsFile,
      code: `const typed = params as TasksFooParams;`,
      errors: [{ messageId: MSG.cast }],
    },
    // Full invalid fixture file — the seven documented violations in order.
    {
      filename: commandsFile,
      code: fixture("invalid.ts"),
      errors: [
        { messageId: MSG.interface },
        { messageId: MSG.aliasLiteral },
        { messageId: MSG.annotation },
        { messageId: MSG.annotation },
        { messageId: MSG.classGeneric },
        { messageId: MSG.annotation },
        { messageId: MSG.cast },
      ],
    },
  ],
});

console.log("no-hand-rolled-command-params: all rule-tester cases pass");
