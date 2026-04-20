/**
 * Zod validation schemas for definition types.
 *
 * Used at compile time to validate TypeScript-authored definitions
 * before producing harness-specific output.
 */

import { z } from "zod";

/** Name format: lowercase letters, numbers, hyphens. No leading/trailing/consecutive hyphens. */
const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "Must be lowercase letters, numbers, and hyphens. Cannot start/end with hyphen or have consecutive hyphens."
  )
  .refine((s) => !s.includes("--"), "Cannot contain consecutive hyphens");

const descriptionSchema = z.string().min(1).max(1024);

export const skillDefinitionSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  tags: z.array(z.string()).optional(),
  userInvocable: z.boolean().optional().default(true),
  disableModelInvocation: z.boolean().optional().default(false),
  allowedTools: z.array(z.string()).optional(),
  content: z.string().min(1),
});

export const ruleDefinitionSchema = z.object({
  name: z.string().optional(),
  description: z.string().min(1),
  alwaysApply: z.boolean().optional().default(false),
  tags: z.array(z.string()).optional(),
  globs: z.union([z.string(), z.array(z.string())]).optional(),
  content: z.string().min(1),
});

const agentModelSchema = z.enum(["sonnet", "opus", "haiku", "inherit"]);
const permissionModeSchema = z.enum(["default", "acceptEdits", "auto", "dontAsk", "plan"]);

export const agentDefinitionSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  model: agentModelSchema.optional().default("inherit"),
  skills: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  permissionMode: permissionModeSchema.optional().default("default"),
  maxTurns: z.number().int().positive().optional(),
  prompt: z.string().min(1),
});

export type SkillDefinitionInput = z.input<typeof skillDefinitionSchema>;
export type RuleDefinitionInput = z.input<typeof ruleDefinitionSchema>;
export type AgentDefinitionInput = z.input<typeof agentDefinitionSchema>;
