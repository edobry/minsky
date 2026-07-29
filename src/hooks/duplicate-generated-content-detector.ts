/**
 * Detector for duplicated top-level content blocks in generated/compiled
 * project artifacts (mt#3299, gate 4 of the mt#3295 corpus-derived gate
 * wave): compiled `.claude/skills/**`, `AGENTS.md`, `CLAUDE.md`, and
 * `src/generated/completion-manifest.json`. A duplicate top-level block
 * (the same heading body repeated, or two different headings with
 * byte-identical bodies) is symptomatic of a broken compile step — the same
 * source rule/skill section emitted twice into the same generated file.
 *
 * Runs in the same pre-commit pass as the existing compile-regen check
 * (mt#2977) and is scoped to STAGED changes to these specific watched
 * targets only — it does not scan the whole repo, so it fires only when a
 * commit actually touches one of them.
 *
 * `detectMarkdownDuplicateBlocks()` / `detectJsonDuplicateEntries()` are pure
 * functions; `runDuplicateGeneratedContentCheck()` is the I/O-performing
 * pre-commit runner (kept out of pre-commit.ts's own max-lines budget, same
 * rationale as `migration-guard-detector.ts`).
 */

import { execGitWithTimeout } from "@minsky/domain/utils/git-exec";
import { log } from "@minsky/shared/logger";
import { readStagedFileContent } from "./staged-file-reader";

export const DUPLICATE_GENERATED_CONTENT_CHECK_OVERRIDE_ENV =
  "MINSKY_SKIP_DUPLICATE_GENERATED_CONTENT_CHECK";

/** Watched exact repo-relative paths. */
export const WATCHED_GENERATED_FILES: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "src/generated/completion-manifest.json",
];

/** Watched directory prefix — every compiled skill file underneath. */
export const WATCHED_SKILLS_DIR_PREFIX = ".claude/skills/";

export type DuplicateContentKind = "markdown-heading-block" | "json-top-level-entry";

export interface DuplicateContentViolation {
  filePath: string;
  /** Label (heading text or JSON key) of the first occurrence. */
  firstLabel: string;
  /** Label of the duplicate occurrence. */
  duplicateLabel: string;
  kind: DuplicateContentKind;
}

export function isDuplicateGeneratedContentOverrideTruthy(envValue: string | undefined): boolean {
  if (!envValue) return false;
  const v = envValue.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Dependency-free FNV-1a 32-bit hash — exact-duplicate detection only, not cryptographic. */
function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeBlockLines(bodyLines: readonly string[]): string[] {
  return bodyLines.map((l) => l.trim()).filter(Boolean);
}

/**
 * Minimum non-blank line count for a block to be eligible for duplicate
 * detection. Short blocks (e.g. a one-line placeholder repeated across
 * skills by convention) are common and not the failure class this check
 * targets — a broken compile step duplicating a whole section produces much
 * larger repeated bodies.
 */
const MIN_BLOCK_LINES = 4;

/**
 * Split markdown content into heading blocks (any `#`-`######` heading
 * starts a new block; content before the first heading is ignored) and flag
 * any two blocks AT THE SAME HEADING LEVEL whose normalized body is
 * byte-identical.
 *
 * Comparison is scoped to same-level pairs only (mt#3299 PR #2392 R1
 * non-blocking: "heading-level noise") — without that, a short H1
 * introduction paragraph and an unrelated H3 subsection that happen to share
 * a few identical boilerplate lines could spuriously compare as
 * "duplicated," even though they sit at completely different structural
 * depths and aren't the same repeated section. Different generated targets
 * use different conventions for what their real "sections" are (CLAUDE.md's
 * sections are `#` headings; a compiled skill's are `##` under one `#`
 * title), so rather than picking one fixed "top" level, every level is
 * tracked independently and only same-level collisions are reported.
 */
export function detectMarkdownDuplicateBlocks(
  filePath: string,
  content: string
): DuplicateContentViolation[] {
  const lines = content.split("\n");
  const blocks: Array<{ level: number; heading: string; body: string[] }> = [];
  let current: { level: number; heading: string; body: string[] } | null = null;

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      if (current) blocks.push(current);
      current = {
        level: (headingMatch[1] ?? "#").length,
        heading: (headingMatch[2] ?? "").trim(),
        body: [],
      };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) blocks.push(current);

  const seenByLevel = new Map<number, Map<string, string>>(); // level -> (hash -> first heading)
  const violations: DuplicateContentViolation[] = [];
  for (const block of blocks) {
    const normalizedLines = normalizeBlockLines(block.body);
    if (normalizedLines.length < MIN_BLOCK_LINES) continue;
    const hash = fnv1aHash(normalizedLines.join("\n"));
    let seen = seenByLevel.get(block.level);
    if (!seen) {
      seen = new Map<string, string>();
      seenByLevel.set(block.level, seen);
    }
    const firstHeading = seen.get(hash);
    if (firstHeading !== undefined) {
      violations.push({
        filePath,
        firstLabel: firstHeading,
        duplicateLabel: block.heading,
        kind: "markdown-heading-block",
      });
    } else {
      seen.set(hash, block.heading);
    }
  }
  return violations;
}

/**
 * Flag duplicate top-level JSON object entries whose serialized values are
 * byte-identical (indicating the same manifest entry emitted under two
 * different keys). Non-object/array-root JSON is skipped (nothing "top
 * level" to compare). Trivially small values are skipped — not the failure
 * class this check targets.
 */
export function detectJsonDuplicateEntries(
  filePath: string,
  jsonContent: string
): DuplicateContentViolation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];

  const MIN_VALUE_LENGTH = 40;
  const seen = new Map<string, string>();
  const violations: DuplicateContentViolation[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length < MIN_VALUE_LENGTH) continue;
    const hash = fnv1aHash(serialized);
    const firstKey = seen.get(hash);
    if (firstKey !== undefined) {
      violations.push({
        filePath,
        firstLabel: firstKey,
        duplicateLabel: key,
        kind: "json-top-level-entry",
      });
    } else {
      seen.set(hash, key);
    }
  }
  return violations;
}

/** Dispatch to the right pure detector based on file path/extension. */
export function detectDuplicateGeneratedContent(
  filePath: string,
  content: string
): DuplicateContentViolation[] {
  if (filePath.endsWith(".json")) return detectJsonDuplicateEntries(filePath, content);
  if (filePath.endsWith(".md")) return detectMarkdownDuplicateBlocks(filePath, content);
  return [];
}

/**
 * Parse `git diff --cached --name-status -z` NUL-delimited output into
 * status records: `[status, path]` for a plain add/modify/delete, or
 * `[status, oldPath, newPath]` for a rename/copy (status starts with
 * `R`/`C`). NUL-delimited (`-z`) parsing — rather than the default
 * newline-plus-tab format this detector used previously — avoids git's
 * path-quoting for filenames containing special characters (backslashes,
 * quotes, non-ASCII bytes); a plain `\t`/`\n` split silently mis-parses a
 * quoted path (mt#3299 PR #2392 R1 non-blocking).
 */
export function parseNameStatusZ(output: string): string[][] {
  const tokens = output.split("\0").filter((t) => t.length > 0);
  const records: string[][] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (status === undefined) break;
    if (/^[RC]/.test(status)) {
      records.push([status, tokens[i + 1] ?? "", tokens[i + 2] ?? ""]);
      i += 3;
    } else {
      records.push([status, tokens[i + 1] ?? ""]);
      i += 2;
    }
  }
  return records;
}

/**
 * Filter parsed `git diff --cached --name-status -z` records down to staged
 * files matching one of the watched generated targets.
 */
export function filterStagedWatchedFiles(records: readonly (readonly string[])[]): string[] {
  const files: string[] = [];
  for (const record of records) {
    // Renames/copies are 3-token records `[status, oldPath, newPath]` — the
    // NEW path (last element) is what's actually staged.
    const filePath = record[record.length - 1];
    if (!filePath) continue;
    const isWatchedExact = WATCHED_GENERATED_FILES.includes(filePath);
    const isWatchedSkill = filePath.startsWith(WATCHED_SKILLS_DIR_PREFIX);
    if (isWatchedExact || isWatchedSkill) files.push(filePath);
  }
  return files;
}

export interface DuplicateGeneratedContentCheckResult {
  success: boolean;
  message: string;
  exitCode: number;
  overridden?: boolean;
}

/**
 * Pre-commit runner: for every staged watched generated file, read its
 * staged content and flag duplicate top-level blocks/entries.
 */
export async function runDuplicateGeneratedContentCheck(
  projectRoot: string
): Promise<DuplicateGeneratedContentCheckResult> {
  if (
    isDuplicateGeneratedContentOverrideTruthy(
      process.env[DUPLICATE_GENERATED_CONTENT_CHECK_OVERRIDE_ENV]
    )
  ) {
    log.cli(
      `[pre-commit:duplicate-generated-content] override ${DUPLICATE_GENERATED_CONTENT_CHECK_OVERRIDE_ENV} set — skipped`
    );
    return {
      success: true,
      message: "Duplicate-generated-content check skipped via override",
      exitCode: 0,
      overridden: true,
    };
  }

  try {
    const result = await execGitWithTimeout(
      "diff",
      "diff --cached --name-status -z --diff-filter=ACMR",
      { workdir: projectRoot, timeout: 5000 }
    );
    const records = parseNameStatusZ(result.stdout.toString());
    const stagedTargets = filterStagedWatchedFiles(records);
    if (stagedTargets.length === 0) {
      return {
        success: true,
        message: "Duplicate-generated-content check passed (n/a)",
        exitCode: 0,
      };
    }

    const allViolations: DuplicateContentViolation[] = [];
    for (const filePath of stagedTargets) {
      const content = await readStagedFileContent(projectRoot, filePath);
      allViolations.push(...detectDuplicateGeneratedContent(filePath, content));
    }
    if (allViolations.length === 0) {
      return { success: true, message: "Duplicate-generated-content check passed", exitCode: 0 };
    }

    log.cli(`${allViolations.length} duplicated generated-content block(s). Commit blocked.`);
    for (const v of allViolations) {
      log.cli(
        `   ${v.filePath} [${v.kind}]: "${v.firstLabel}" duplicated as "${v.duplicateLabel}"`
      );
    }
    log.cli(
      "A duplicated top-level block usually means a broken compile step emitted the same " +
        "section twice — re-run the compile pipeline and check its source rule for the fix. " +
        `Override: ${DUPLICATE_GENERATED_CONTENT_CHECK_OVERRIDE_ENV}=1`
    );
    return {
      success: false,
      message: `Duplicate-generated-content check failed: ${allViolations.length} duplicate(s)`,
      exitCode: 1,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`Duplicate-generated-content check failed: ${errorMsg}`);
    return {
      success: false,
      message: `Duplicate-generated-content check failed: ${errorMsg}`,
      exitCode: 1,
    };
  }
}
