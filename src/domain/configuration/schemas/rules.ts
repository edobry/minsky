import { z } from "zod";

export const rulesTargetSchema = z.object({
  enabled: z.boolean().default(true),
  outputPath: z.string().optional(),
  ruleTypes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
});

export const rulesConfigSchema = z
  .object({
    sourcePath: z.string().default(".cursor/rules"),
    targets: z.record(z.string(), rulesTargetSchema).default({}),
  })
  .default({});

export type RulesTargetConfig = z.infer<typeof rulesTargetSchema>;
export type RulesConfig = z.infer<typeof rulesConfigSchema>;
