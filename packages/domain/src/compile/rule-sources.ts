/**
 * Flat-`.mdc` + `<name>/rule.ts` rule source reader for the new `compile` pipeline.
 *
 * Phase 2 of the compile-pipeline convergence (mt#2994 / ADR-016). The legacy
 * `rules compile` pipeline reads flat `.minsky/rules/*.mdc` rule sources; the new
 * `compile` pipeline previously read ONLY per-directory `.minsky/rules/<name>/rule.ts`
 * sources (see `targets/cursor-rules-ts.ts`). This module lets the new pipeline
 * discover and parse BOTH forms into validated `RuleDefinition`s — mirroring the
 * mt#2279 hybrid `SKILL.md` reader for skills (`targets/claude-skills.ts`:
 * `discoverSkillSources` / `extractSkillDefinitionFromMd`).
 *
 * Scope (mt#2994 — READER only). Wiring the flat-`.mdc`-sourced rules into the
 * `.cursor/rules/` EMITTER — and reconciling byte-parity with the legacy writer,
 * then removing it — is Phase 3 (mt#2995, "dedup the two `.cursor/rules/`
 * writers"): the legacy `.cursor/rules/` output reserializes frontmatter
 * (`jsYaml.dump`, name-first) and differs from the flat source for 47/54 rules,
 * so matching it byte-for-byte is emitter work, not reader work. The monolithic
 * CLAUDE.md/AGENTS.md assembler (Phase 1, mt#2992) also consumes this reader.
 * In Phase 2, `discoverRuleSources` is wired into `cursor-rules-ts` (its
 * production caller); `extractRuleDefinitionFromMdc` is unit-tested here and
 * consumed by Phases 1 and 3.
 */

import { join } from "path";
import matter from "gray-matter";
import { ruleDefinitionSchema } from "../definitions/schemas";
import type { RuleDefinition } from "../definitions/types";
import type { MinskyCompileFsDeps } from "./types";

/** File name of a TypeScript rule source inside a `.minsky/rules/<name>/` dir. */
export const RULE_TS_SOURCE = "rule.ts";

const MDC_EXT = ".mdc";

/**
 * A discovered rule source. `name` is the rule id — the `<name>/` directory name
 * for a TS source, or the `<name>.mdc` basename for a markdown source.
 *
 * `kind: "both"` marks an ambiguous canonical source (a `<name>/rule.ts` AND a
 * flat `<name>.mdc` exist for the same name). Consumers skip+warn on it rather
 * than silently preferring one format (mirrors mt#2279's ambiguous-skill handling).
 */
export type RuleSource =
  | { kind: "ts"; name: string; path: string }
  | { kind: "mdc"; name: string; path: string }
  | { kind: "both"; name: string; tsPath: string; mdcPath: string };

/** Source directory where rules are authored: `.minsky/rules/`. */
export function ruleSourceDir(workspacePath: string): string {
  return join(workspacePath, ".minsky", "rules");
}

/** Absolute path to a `<name>/rule.ts` TS rule source. */
export function ruleTsPath(workspacePath: string, name: string): string {
  return join(ruleSourceDir(workspacePath), name, RULE_TS_SOURCE);
}

/** Absolute path to a flat `<name>.mdc` markdown rule source. */
export function ruleMdcPath(workspacePath: string, name: string): string {
  return join(ruleSourceDir(workspacePath), `${name}${MDC_EXT}`);
}

async function fileExists(fs: MinskyCompileFsDeps, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** gray-matter yields a scalar for a single-item YAML value; normalize to array. */
function normalizeToStringArray(value: unknown): unknown {
  return typeof value === "string" ? [value] : value;
}

/**
 * Discover rule sources under `.minsky/rules/`. Two forms are recognized:
 *  - a flat `<name>.mdc` file   → `{ kind: "mdc" }`
 *  - a `<name>/rule.ts` module  → `{ kind: "ts" }`
 * When BOTH exist for the same `<name>`, the source is `{ kind: "both" }` (an
 * ambiguous canonical source — consumers skip+warn, per mt#2279).
 *
 * Returns sources sorted by name for deterministic output. A missing/unreadable
 * `.minsky/rules/` directory yields `[]` (not an error) — mirrors the skills reader.
 */
export async function discoverRuleSources(
  workspacePath: string,
  fs: MinskyCompileFsDeps
): Promise<RuleSource[]> {
  const sourceDir = ruleSourceDir(workspacePath);
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return [];
  }

  const mdcNames = new Set<string>();
  const tsNames = new Set<string>();

  for (const entry of entries) {
    if (entry.endsWith(MDC_EXT)) {
      mdcNames.add(entry.slice(0, -MDC_EXT.length));
      continue;
    }
    // A non-`.mdc` entry is a candidate rule dir iff it contains a `rule.ts`.
    if (await fileExists(fs, join(sourceDir, entry, RULE_TS_SOURCE))) {
      tsNames.add(entry);
    }
  }

  const allNames = [...new Set<string>([...mdcNames, ...tsNames])].sort();
  const sources: RuleSource[] = [];
  for (const name of allNames) {
    const hasTs = tsNames.has(name);
    const hasMdc = mdcNames.has(name);
    if (hasTs && hasMdc) {
      sources.push({
        kind: "both",
        name,
        tsPath: ruleTsPath(workspacePath, name),
        mdcPath: ruleMdcPath(workspacePath, name),
      });
    } else if (hasTs) {
      sources.push({ kind: "ts", name, path: ruleTsPath(workspacePath, name) });
    } else {
      sources.push({ kind: "mdc", name, path: ruleMdcPath(workspacePath, name) });
    }
  }
  return sources;
}

/**
 * Parse + validate a rule definition from a flat markdown source (`<name>.mdc`).
 *
 * The YAML frontmatter carries metadata (`description`, `globs`, `alwaysApply`,
 * `tags`, and an optional `name`); the markdown body is the rule content. Maps
 * frontmatter → `RuleDefinition` and validates via `ruleDefinitionSchema` — the
 * SAME schema the TypeScript (`rule.ts`) path uses — so both formats produce
 * identical, validated output. `name` falls back to the file-derived `ruleName`
 * when frontmatter omits it (legacy rules key off the filename).
 *
 * Returns `{ error }` (never throws) on unparseable frontmatter or a
 * schema-invalid definition, so callers skip+warn rather than crash. One current
 * rule (`verification-checklist.mdc`) has no `description` and fails the schema —
 * that is the intended skip-with-warning path, and a tracked convergence gap
 * (the rule needs a `description`, or the schema must relax it) surfaced by this
 * reader rather than swallowed.
 */
export function extractRuleDefinitionFromMdc(
  raw: string,
  sourcePath: string,
  ruleName: string
): { rule: RuleDefinition } | { error: string } {
  let fm: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(raw);
    fm = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { error: `Failed to parse markdown frontmatter at ${sourcePath}: ${reason}` };
  }

  // Map frontmatter → RuleDefinition. Omit undefined keys so schema defaults
  // (alwaysApply=false) apply rather than being overridden with undefined.
  const candidate: Record<string, unknown> = { content: body };
  candidate["name"] = fm["name"] !== undefined ? fm["name"] : ruleName;
  if (fm["description"] !== undefined) candidate["description"] = fm["description"];
  if (fm["globs"] !== undefined) candidate["globs"] = fm["globs"];
  if (fm["alwaysApply"] !== undefined) candidate["alwaysApply"] = fm["alwaysApply"];
  if (fm["tags"] !== undefined) candidate["tags"] = normalizeToStringArray(fm["tags"]);

  const parsed = ruleDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return { error: `Invalid rule markdown source at ${sourcePath}: ${parsed.error.message}` };
  }
  return { rule: parsed.data as RuleDefinition };
}
