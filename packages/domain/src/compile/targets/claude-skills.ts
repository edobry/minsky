/**
 * Claude Skills Compile Target
 *
 * Reads skill sources from `.minsky/skills/<name>/` — EITHER a TypeScript
 * module (`skill.ts`, via `defineSkill`) OR a markdown source (`SKILL.md` with
 * YAML frontmatter) — validates them via `skillDefinitionSchema`, and emits
 * `.claude/skills/<name>/SKILL.md` with YAML frontmatter + content body.
 *
 * Hybrid, location-canonical authoring per ADR-015 (mt#2251): canonicity comes
 * from the `.minsky/skills/` location, not the file format. The markdown-source
 * path is mt#2279.
 */

import { join, dirname } from "path";
import realFs from "fs/promises";
import matter from "gray-matter";
import { skillDefinitionSchema } from "../../definitions/schemas";
import type { SkillDefinition } from "../../definitions/types";
import { log } from "../../utils/logger";
import { COMPILE_GENERATED_BANNER } from "../../rules/compile/banner-constants";
import type {
  MinskyCompileTarget,
  MinskyCompileResult,
  MinskyTargetOptions,
  MinskyCompileFsDeps,
} from "../types";

/** Injectable dynamic import — overridden in tests. */
export type DynamicImportFn = (path: string) => Promise<unknown>;

const realDynamicImport: DynamicImportFn = (path: string) => import(path);

/**
 * Injectable skip-warning sink — overridden in tests. The production default
 * logs via the shared logger; mt#2182 requires that skipped skills are NOT
 * swallowed silently. Injected (rather than spying on `log`) to sidestep
 * cross-package module-identity issues with the singleton logger.
 */
export type SkipLogFn = (message: string) => void;

const defaultSkipLog: SkipLogFn = (message: string) => log.warn(message);

/**
 * Normalize a markdown frontmatter value that may be authored as a scalar string
 * (`tags: alpha`) into a single-element array (`["alpha"]`), so authors don't hit
 * a schema-validation skip for the common singleton case. Non-string values
 * (already-arrays, etc.) pass through unchanged for the schema to validate.
 */
function normalizeToStringArray(value: unknown): unknown {
  return typeof value === "string" ? [value] : value;
}

/** Source file names for a skill under `.minsky/skills/<name>/`. */
const SKILL_TS_SOURCE = "skill.ts";
const SKILL_MD_SOURCE = "SKILL.md";

/**
 * Source directory where skills are authored.
 * Pattern: `.minsky/skills/<name>/{skill.ts | SKILL.md}`
 */
function skillSourceDir(workspacePath: string): string {
  return join(workspacePath, ".minsky", "skills");
}

/**
 * Root output directory for compiled skills.
 * Output: .claude/skills/<name>/SKILL.md
 */
function skillOutputDir(workspacePath: string): string {
  return join(workspacePath, ".claude", "skills");
}

/** Absolute path to the compiled SKILL.md for a given skill name. */
function skillOutputPath(workspacePath: string, skillName: string): string {
  return join(skillOutputDir(workspacePath), skillName, "SKILL.md");
}

/**
 * Build SKILL.md content from a validated SkillDefinition.
 *
 * Emits YAML frontmatter followed by the content body. Format matches
 * the hand-authored files in .claude/skills/*\/SKILL.md.
 */
export function buildSkillMd(skill: SkillDefinition): string {
  const frontmatterData: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };

  if (skill.tags !== undefined && skill.tags.length > 0) {
    frontmatterData["tags"] = skill.tags;
  }

  frontmatterData["user-invocable"] = skill.userInvocable ?? true;

  if (skill.disableModelInvocation === true) {
    frontmatterData["disable-model-invocation"] = true;
  }

  if (skill.allowedTools !== undefined && skill.allowedTools.length > 0) {
    frontmatterData["allowed-tools"] = skill.allowedTools;
  }

  // Ensure a blank line between frontmatter closing delimiter and content body.
  // gray-matter.stringify places content immediately after "---\n" unless the
  // content starts with "\n". Hand-authored SKILL.md files always have this
  // blank line, so we normalise here for stable output.
  const body = skill.content.startsWith("\n") ? skill.content : `\n${skill.content}`;
  const compiled = matter.stringify(body, frontmatterData);
  // Inject the generation banner as a YAML line-comment on line 2 (immediately
  // after the opening `---`). Line 1 must stay the `---` frontmatter opener, so
  // the banner can't go on line 1 the way it does for CLAUDE.md/AGENTS.md. This
  // matches the `.cursor/rules/*.mdc` convention and lands within the first 5
  // lines, so `.claude/hooks/check-generated-file-edit.ts` (which scans the
  // first 5 lines for GENERATION_BANNER_PATTERNS) blocks direct edits.
  return compiled.replace(/^---\n/, `---\n${COMPILE_GENERATED_BANNER}\n`);
}

/** Resolved source for one skill directory. */
type SkillSource =
  | { dirName: string; kind: "ts"; path: string }
  | { dirName: string; kind: "md"; path: string }
  | { dirName: string; kind: "both"; tsPath: string; mdPath: string };

/** True iff the path exists (fs.access does not throw). */
async function fileExists(fs: MinskyCompileFsDeps, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover skill sources under `.minsky/skills/`. A directory is a skill source
 * when it contains a `skill.ts` OR a `SKILL.md`. Directories with neither are
 * skipped (not skill sources). A directory with BOTH is reported as `kind:
 * "both"` so the compile step can flag the ambiguous canonical source.
 */
async function discoverSkillSources(
  workspacePath: string,
  fs: MinskyCompileFsDeps
): Promise<SkillSource[]> {
  const sourceDir = skillSourceDir(workspacePath);
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return [];
  }

  const sources: SkillSource[] = [];
  for (const dirName of entries) {
    const tsPath = join(sourceDir, dirName, SKILL_TS_SOURCE);
    const mdPath = join(sourceDir, dirName, SKILL_MD_SOURCE);
    const [hasTs, hasMd] = await Promise.all([fileExists(fs, tsPath), fileExists(fs, mdPath)]);
    if (hasTs && hasMd) {
      sources.push({ dirName, kind: "both", tsPath, mdPath });
    } else if (hasTs) {
      sources.push({ dirName, kind: "ts", path: tsPath });
    } else if (hasMd) {
      sources.push({ dirName, kind: "md", path: mdPath });
    }
    // neither — not a skill source, skip
  }
  return sources;
}

/**
 * Load and validate a skill definition from an imported TypeScript module.
 * Accepts both `export default defineSkill(...)` and named `export { skill }`.
 */
function extractSkillDefinition(
  mod: unknown,
  sourcePath: string
): { skill: SkillDefinition } | { error: string } {
  if (typeof mod !== "object" || mod === null) {
    return { error: `Module at ${sourcePath} did not export an object` };
  }

  const candidate =
    (mod as Record<string, unknown>)["default"] ?? (mod as Record<string, unknown>)["skill"];

  if (candidate === undefined) {
    return {
      error: `Module at ${sourcePath} has no default export or named 'skill' export`,
    };
  }

  const parsed = skillDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: `Invalid skill definition at ${sourcePath}: ${parsed.error.message}`,
    };
  }

  return { skill: parsed.data as SkillDefinition };
}

/**
 * Parse and validate a skill definition from a markdown source (`SKILL.md`).
 *
 * The YAML frontmatter carries the metadata (kebab-case keys, matching the
 * compiled-output frontmatter); the markdown body is the skill content. Maps
 * frontmatter → SkillDefinition fields and validates via the same schema as
 * the TypeScript path, so both formats produce identical, validated output.
 */
function extractSkillDefinitionFromMd(
  raw: string,
  sourcePath: string
): { skill: SkillDefinition } | { error: string } {
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

  // Map kebab-case frontmatter keys → camelCase SkillDefinition fields. Omit
  // undefined keys so the schema's defaults (userInvocable, disableModelInvocation)
  // apply rather than being overridden with undefined.
  const candidate: Record<string, unknown> = { content: body };
  if (fm["name"] !== undefined) candidate["name"] = fm["name"];
  if (fm["description"] !== undefined) candidate["description"] = fm["description"];
  if (fm["tags"] !== undefined) candidate["tags"] = normalizeToStringArray(fm["tags"]);
  if (fm["user-invocable"] !== undefined) candidate["userInvocable"] = fm["user-invocable"];
  if (fm["disable-model-invocation"] !== undefined) {
    candidate["disableModelInvocation"] = fm["disable-model-invocation"];
  }
  if (fm["allowed-tools"] !== undefined) {
    candidate["allowedTools"] = normalizeToStringArray(fm["allowed-tools"]);
  }

  const parsed = skillDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: `Invalid skill markdown source at ${sourcePath}: ${parsed.error.message}`,
    };
  }

  return { skill: parsed.data as SkillDefinition };
}

/** Build the claude-skills target, injecting a dynamic-import function for tests. */
function makeClaudeSkillsTarget(
  dynamicImport: DynamicImportFn = realDynamicImport,
  onSkip: SkipLogFn = defaultSkipLog
): MinskyCompileTarget {
  return {
    id: "claude-skills",
    displayName: "Claude Skills",
    // .claude/skills/ contains both compiled and hand-authored SKILL.md files
    // (the hand-authored ones are the existing Claude Code skills in this repo).
    // Skip orphan detection so --check doesn't flag them as stale.
    //
    // Compiled output is emitted verbatim (NOT Prettier-formatted). To avoid a
    // lint-staged-vs-compile-staleness deadlock when a source uses Prettier-
    // divergent markdown, `.claude/skills/` is Prettier-ignored (see .prettierignore
    // / mt#2555); this compile-check guard is the sole authority for compiled-skill
    // staleness.
    sharedOutputDirectory: true,

    defaultOutputPath(workspacePath: string): string {
      return skillOutputDir(workspacePath);
    },

    async listOutputFiles(
      _options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<string[]> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const sources = await discoverSkillSources(workspacePath, fs);
      // Exclude `kind: "both"` — compile() skips ambiguous-source dirs and never
      // produces an output for them, so listing an expected output here would make
      // staleness checks (which compare listOutputFiles against actual outputs)
      // false-flag a never-written file as missing/stale.
      return sources
        .filter((s) => s.kind !== "both")
        .map((s) => skillOutputPath(workspacePath, s.dirName));
    },

    async compile(
      options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<MinskyCompileResult> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const sources = await discoverSkillSources(workspacePath, fs);

      const filesWritten: string[] = [];
      const definitionsIncluded: string[] = [];
      const definitionsSkipped: string[] = [];
      const contentsByPath = new Map<string, string>();
      const dryRunParts: string[] = [];

      for (const source of sources) {
        const { dirName } = source;

        // Ambiguous canonical source: a skill dir must have exactly one of
        // skill.ts / SKILL.md. Skip + warn rather than silently picking one
        // (mt#2279). The skill produces no output until the ambiguity is fixed.
        if (source.kind === "both") {
          onSkip(
            `[compile:claude-skills] skipping "${dirName}": both ${SKILL_TS_SOURCE} and ${SKILL_MD_SOURCE} present under .minsky/skills/${dirName}/ — ambiguous canonical source; keep exactly one`
          );
          definitionsSkipped.push(dirName);
          continue;
        }

        let extracted: { skill: SkillDefinition } | { error: string };

        if (source.kind === "ts") {
          let mod: unknown;
          try {
            mod = await dynamicImport(source.path);
          } catch (error) {
            // Do NOT swallow silently (mt#2182): a broken import path here is the
            // failure mode that left all 7 skills uncompiled with no warning.
            const reason = error instanceof Error ? error.message : String(error);
            onSkip(
              `[compile:claude-skills] skipping "${dirName}": failed to import ${source.path}: ${reason}`
            );
            definitionsSkipped.push(dirName);
            continue;
          }
          extracted = extractSkillDefinition(mod, source.path);
        } else {
          // markdown source
          let raw: string;
          try {
            raw = await fs.readFile(source.path, "utf-8");
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            onSkip(
              `[compile:claude-skills] skipping "${dirName}": failed to read ${source.path}: ${reason}`
            );
            definitionsSkipped.push(dirName);
            continue;
          }
          extracted = extractSkillDefinitionFromMd(raw, source.path);
        }

        if ("error" in extracted) {
          onSkip(`[compile:claude-skills] skipping "${dirName}": ${extracted.error}`);
          definitionsSkipped.push(dirName);
          continue;
        }

        const { skill } = extracted;
        const outputPath = skillOutputPath(workspacePath, skill.name);
        const content = buildSkillMd(skill);

        if (options.dryRun) {
          contentsByPath.set(outputPath, content);
          dryRunParts.push(`// ${outputPath}\n${content}`);
        } else {
          await fs.mkdir(dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, content, "utf-8");
        }

        filesWritten.push(outputPath);
        definitionsIncluded.push(skill.name);
      }

      return {
        target: "claude-skills",
        filesWritten,
        definitionsIncluded,
        definitionsSkipped,
        content: options.dryRun ? dryRunParts.join("\n\n") : undefined,
        contentsByPath: options.dryRun ? contentsByPath : undefined,
      };
    },
  };
}

export const claudeSkillsTarget = makeClaudeSkillsTarget();

/** Export factory for test injection */
export { makeClaudeSkillsTarget };
