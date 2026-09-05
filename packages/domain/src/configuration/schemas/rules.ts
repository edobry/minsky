import { z } from "zod";

/**
 * Per-target rules configuration.
 *
 * mt#573 SC6 deleted four fields from this object: `ruleTypes`, `tags`,
 * `excludeTags` and `enabled`. All four were dead — verified 2026-09-05, this
 * schema and `RulesTargetConfig` were referenced only in this file, and nothing
 * anywhere read `rules.targets`. (The identically-named `ruleTypes` /
 * `excludeTags` in `rules/compile/types.ts` belong to the LEGACY compile
 * options type, which mt#2996 deletes; they are not this schema.)
 *
 * They are named here rather than merely removed because two of them were
 * traps. `enabled` collided by name with `rulesConfigSchema.enabled` below,
 * which is a rule-id LIST, not a boolean — a per-target `enabled: false` and a
 * project-level `enabled: [...]` read alike in a config file and mean nothing
 * alike. And `ruleTypes`/`tags`/`excludeTags` are exactly the shape someone
 * would reach for to express tier filtering, which now lives on the RULE
 * (`tier`, `minimumRung`) and in the project-level selection below. Growing it
 * into a per-target filter would give a project two disagreeing answers to
 * "which rules does this target get?" — the defect this task exists to remove
 * from the pipeline, reintroduced one layer down.
 */
export const rulesTargetSchema = z.object({
  outputPath: z.string().optional(),
});

/**
 * Project rule selection (mt#573).
 *
 * `presets` names bundles DERIVED from tier metadata (`deriveRulePresets` in
 * `rules/rule-selection.ts`), not entries in a hand-typed table — the table
 * this file used to carry named 22 ids, of which 13 existed only in Minsky's
 * own repository and 3 existed nowhere, and nothing could have noticed.
 *
 * `rung` is the project's adoption rung. Optional, and absent means NO rung
 * filter rather than `T0`: the canonical ladder doc is unwritten (RFC
 * `3ce937f0`), so a project that never declared a rung must not lose rules to a
 * comparison it did not opt into.
 */
export const rulesConfigSchema = z
  .object({
    sourcePath: z.string().default(".minsky/rules"),
    targets: z.record(z.string(), rulesTargetSchema).default({}),
    presets: z.array(z.string()).default([]),
    enabled: z.array(z.string()).default([]),
    disabled: z.array(z.string()).default([]),
    rung: z.enum(["T0", "T1", "T2", "T3", "T4"]).optional(),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .default(() => ({}) as any);

export type RulesTargetConfig = z.infer<typeof rulesTargetSchema>;
export type RulesConfig = z.infer<typeof rulesConfigSchema>;
