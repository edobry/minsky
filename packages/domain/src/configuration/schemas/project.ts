/**
 * Project identity configuration schema (mt#2414 — Phase 1.1 of mt#2391).
 *
 * The `project` key in `.minsky/config.yaml` holds the stable identity of
 * the Minsky-managed project. Stamped by `minsky init` / `minsky setup`.
 *
 * Field: `project.slug`
 * - A stable human-readable identifier, e.g. `owner/repo` or a custom name.
 * - Written by `minsky init` based on the git-remote origin at init time.
 * - Optional so older config files that pre-date mt#2414 remain valid.
 */

import { z } from "zod";

export const projectConfigSchema = z
  .object({
    /**
     * Stable project identifier stamped by `minsky init`.
     *
     * Default derivation: `owner/repo` from the `origin` remote URL
     * (e.g. `edobry/minsky`). Human-readable and matches how GitHub
     * refers to repos. Changes on fork — if stability across forks is
     * required, use an explicit custom slug instead.
     *
     * Used as the `project_slug` column in the Phase 1.2 DB schema
     * (mt#2415) and as the query-scoping key in Phase 1.3 (mt#2416).
     */
    slug: z.string().optional(),
  })
  .optional();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
