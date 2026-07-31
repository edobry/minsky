/**
 * Valid fixture for custom/no-entity-id-param-drift (mt#2780).
 * Fed to the RuleTester with a `src/adapters/shared/commands/tasks/...`
 * filename — every shape here complies with the tasks-family convention.
 */
import { z } from "zod";
import type { CommandParameterMap } from "../../../src/adapters/shared/command-registry";

declare const taskContextParams: CommandParameterMap;

// Canonical alone — clean.
export const canonicalOnlyParams = {
  taskId: { schema: z.string(), description: "task id", required: true },
  limit: { schema: z.number().optional(), description: "limit", required: false },
} satisfies CommandParameterMap;

// Canonical + back-compat alias (the mt#2737/mt#2741 pattern) — clean.
export const canonicalPlusAliasParams = {
  taskId: { schema: z.string(), description: "canonical", required: false },
  task: { schema: z.string(), description: "back-compat alias", required: false },
} satisfies CommandParameterMap;

// Alias present but a spread may carry the canonical — skipped (conservative).
export const spreadMayCarryCanonicalParams = {
  ...taskContextParams,
  task: {
    schema: z.string(),
    description: "alias; canonical may arrive via spread",
    required: false,
  },
} satisfies CommandParameterMap;

// Context params only (repo/workspace/session scoping) — no entity-id keys at all.
export const contextOnlyParams = {
  repo: { schema: z.string(), description: "repo", required: false },
  workspace: { schema: z.string(), description: "workspace", required: false },
  session: { schema: z.string(), description: "workspace-session scoping", required: false },
} satisfies CommandParameterMap;
