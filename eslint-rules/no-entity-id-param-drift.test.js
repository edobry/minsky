/**
 * @fileoverview Tests for custom/no-entity-id-param-drift (mt#2780).
 *
 * The rule flags a command params map in a family directory that declares the
 * family's back-compat alias entity-id name without the family's canonical
 * name (the mt#2741 Detector-A drift class). Conventions are declared in the
 * rule's FAMILY_CONVENTIONS table (decision record: mt#2741).
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-entity-id-param-drift.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(path.join(here, "__fixtures__", "no-entity-id-param-drift", name), "utf-8");

const tasksFile = "src/adapters/shared/commands/tasks/fixture-command.ts";
const sessionFile = "src/adapters/shared/commands/session/fixture-command.ts";
const memoryFile = "src/adapters/shared/commands/memory/index.ts";
const topLevelFile = "src/adapters/shared/commands/asks.ts";
const outsideFile = "src/domain/tasks/unrelated.ts";

const MSG = "aliasWithoutCanonical";

const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tsTester.run("no-entity-id-param-drift", rule, {
  valid: [
    // Canonical alone.
    {
      filename: tasksFile,
      code: `const m = { taskId: { schema: s, required: true } } satisfies CommandParameterMap;`,
    },
    // Canonical + back-compat alias (mt#2737/mt#2741 pattern).
    {
      filename: tasksFile,
      code: `const m = { taskId: { schema: s }, task: { schema: s } } satisfies CommandParameterMap;`,
    },
    // Alias with a spread that may carry the canonical — conservative skip.
    {
      filename: tasksFile,
      code: `const m = { ...taskIdParam, task: { schema: s } } satisfies CommandParameterMap;`,
    },
    // `session` in a TASKS map is workspace-scoping context, not session-family drift.
    {
      filename: tasksFile,
      code: `const m = { taskId: { schema: s }, session: { schema: s } } satisfies CommandParameterMap;`,
    },
    // `task` in a SESSION map is a legitimate co-selector, not drift.
    {
      filename: sessionFile,
      code: `const m = { sessionId: { schema: s }, task: { schema: s } } satisfies CommandParameterMap;`,
    },
    // Family with no table entry (memory) — no check.
    {
      filename: memoryFile,
      code: `const m = { id: { schema: s }, task: { schema: s } } satisfies CommandParameterMap;`,
    },
    // Top-level commands file — no family directory, no check.
    {
      filename: topLevelFile,
      code: `const m = { task: { schema: s } } satisfies CommandParameterMap;`,
    },
    // Outside the commands tree entirely.
    {
      filename: outsideFile,
      code: `const m = { task: { schema: s } } satisfies CommandParameterMap;`,
    },
    // Non-map object literals in a family file are not checked.
    {
      filename: tasksFile,
      code: `const notAMap = { task: "mt#1" };`,
    },
    // Full valid fixture.
    {
      filename: tasksFile,
      code: fixture("valid.ts"),
    },
  ],

  invalid: [
    // Alias alone in a tasks-family satisfies-map.
    {
      filename: tasksFile,
      code: `const m = { task: { schema: s, required: true } } satisfies CommandParameterMap;`,
      errors: [{ messageId: MSG }],
    },
    // Alias alone in an inline parameters: map.
    {
      filename: tasksFile,
      code: `const cmd = { id: "tasks.x", parameters: { task: { schema: s } }, execute: async (p) => p };`,
      errors: [{ messageId: MSG }],
    },
    // Alias alone in a class parameters field.
    {
      filename: tasksFile,
      code: `class C { readonly parameters = { task: { schema: s } }; }`,
      errors: [{ messageId: MSG }],
    },
    // Session-family drift: `session` without `sessionId`.
    {
      filename: sessionFile,
      code: `const m = { session: { schema: s } } satisfies CommandParameterMap;`,
      errors: [{ messageId: MSG }],
    },
    // Full invalid fixture — three documented violations.
    {
      filename: tasksFile,
      code: fixture("invalid.ts"),
      errors: [{ messageId: MSG }, { messageId: MSG }, { messageId: MSG }],
    },
  ],
});

console.log("no-entity-id-param-drift: all rule-tester cases pass");
