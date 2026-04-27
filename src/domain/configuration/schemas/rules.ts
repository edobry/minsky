import { z } from "zod";

export const rulesTargetSchema = z.object({
  enabled: z.boolean().default(true),
  outputPath: z.string().optional(),
  ruleTypes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
});

// Preset definitions — curated rule collections
export const RULE_PRESETS: Record<string, string[]> = {
  "minsky-core": ["minsky-workflow", "task-status-protocol", "pr-preparation-workflow"],
  "minsky-full": [
    "minsky-workflow",
    "minsky-workflow-orchestrator",
    "minsky-session-management",
    "task-implementation-workflow",
    "task-status-protocol",
    "task-status-workflow-protocol",
    "pr-preparation-workflow",
    "pr-description-guidelines",
    "testing-session-repo-changes",
  ],
  "typescript-strict": ["no-dynamic-imports", "ensure-ascii-code-symbols", "constants-management"],
  "testing-standards": [
    "testing-standards",
    "test-infrastructure",
    "testing-boundaries",
    "bun-test-patterns",
  ],
  "code-style": [
    "comments",
    "meta-cognitive-boundary-protocol",
    "constants-management",
    "cli-output-design",
  ],
  safety: ["operational-safety-dry-run-first", "dont-ignore-errors", "git-safety"],
};

export const rulesConfigSchema = z
  .object({
    sourcePath: z.string().default(".minsky/rules"),
    targets: z.record(z.string(), rulesTargetSchema).default({}),
    presets: z.array(z.string()).default([]),
    enabled: z.array(z.string()).default([]),
    disabled: z.array(z.string()).default([]),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .default(() => ({}) as any);

export type RulesTargetConfig = z.infer<typeof rulesTargetSchema>;
export type RulesConfig = z.infer<typeof rulesConfigSchema>;
