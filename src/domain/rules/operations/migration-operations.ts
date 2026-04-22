/**
 * Rules Migration and Search Operations
 *
 * Functions for migrating rules from .cursor/rules/, indexing embeddings,
 * and performing enhanced similarity search.
 */

import realFs from "fs/promises";
import { join } from "path";
import { getErrorMessage } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { RuleService } from "../../rules";
import type {
  MigrateRulesOptions,
  MigrateRulesResult,
  MigrateFsDeps,
  IndexEmbeddingsOptions,
  IndexEmbeddingsResult,
  EnhancedRuleSearchResult,
  SearchRulesEnhancedOptions,
} from "./types";

// ─── Migration ───────────────────────────────────────────────────────────────

/**
 * Migrate rules from .cursor/rules/ to .minsky/rules/.
 */
export async function migrateRules(options: MigrateRulesOptions): Promise<MigrateRulesResult> {
  const { workspacePath, dryRun, force } = options;
  const fs: MigrateFsDeps = options.fsDeps ?? (realFs as MigrateFsDeps);
  const sourceDir = join(workspacePath, ".cursor/rules");
  const destDir = join(workspacePath, ".minsky/rules");

  // Check if source directory exists
  let sourceEntries: string[];
  try {
    const entries = await fs.readdir(sourceDir);
    sourceEntries = entries.filter((f) => f.endsWith(".mdc"));
  } catch {
    return {
      success: false,
      error: `Source directory does not exist: ${sourceDir}`,
    };
  }

  if (sourceEntries.length === 0) {
    return {
      success: false,
      error: `No .mdc files found in source directory: ${sourceDir}`,
    };
  }

  // Create dest dir if needed (unless dry run)
  if (!dryRun) {
    await fs.mkdir(destDir, { recursive: true });
  }

  const migrated: string[] = [];
  const skipped: string[] = [];

  for (const filename of sourceEntries) {
    const srcFile = join(sourceDir, filename);
    const destFile = join(destDir, filename);

    // Check if destination file already exists
    let destExists = false;
    try {
      await fs.access(destFile);
      destExists = true;
    } catch {
      destExists = false;
    }

    if (destExists && !force) {
      skipped.push(filename);
      continue;
    }

    if (!dryRun) {
      const content = await fs.readFile(srcFile);
      await fs.writeFile(destFile, content);
    }
    migrated.push(filename);
  }

  return {
    success: true,
    dryRun,
    migrated,
    skipped,
    sourceDir,
    destDir,
    nextSteps: [
      "Run `minsky rules compile --target cursor-rules` to regenerate " +
        ".cursor/rules/ from the new canonical source",
      "Add `.cursor/rules/` to your .gitignore",
      "Run `git rm -r --cached .cursor/rules/` to untrack the old files",
    ],
  };
}

// ─── Index Embeddings ────────────────────────────────────────────────────────

/**
 * Index embeddings for rules using the similarity service.
 */
export async function indexRuleEmbeddings(
  options: IndexEmbeddingsOptions
): Promise<IndexEmbeddingsResult> {
  const { RuleSimilarityService } = await import("../rule-similarity-service");
  const service = RuleSimilarityService.createWithWorkspacePath(options.workspacePath);

  const ruleService = new RuleService(options.workspacePath);
  const rules = await ruleService.listRules({});

  // Apply limit for debugging
  const slice = options.limit ? rules.slice(0, options.limit) : rules;

  if (slice.length === 0) {
    return { success: true, indexed: 0, skipped: 0, total: 0 };
  }

  let indexed = 0;
  let skipped = 0;
  const start = Date.now();

  if (!options.json) {
    log.cli(`Indexing embeddings for ${slice.length} rule(s)...`);
  }

  for (const rule of slice) {
    if (!options.json) {
      log.cli(`- ${rule.id}`);
    }

    try {
      const changed = await service.indexRule(rule.id);
      if (changed) {
        indexed++;
      } else {
        skipped++;
      }
    } catch (error) {
      skipped++;
      if (options.debug) {
        log.cliError(`Error indexing rule ${rule.id}: ${getErrorMessage(error)}`);
      }
    }
  }

  const elapsed = Date.now() - start;
  return { success: true, indexed, skipped, total: slice.length, ms: elapsed };
}

// ─── Enhanced Search ─────────────────────────────────────────────────────────

/**
 * Perform similarity search and enhance results with full rule details.
 */
export async function searchRulesEnhanced(
  options: SearchRulesEnhancedOptions
): Promise<EnhancedRuleSearchResult[]> {
  const { RuleSimilarityService } = await import("../rule-similarity-service");
  const service = RuleSimilarityService.createWithWorkspacePath(options.workspacePath);

  const { query, limit = 10, threshold } = options;

  if (!query) {
    return [];
  }

  const results = await service.searchByText(query, limit, threshold);

  const rulesService = new RuleService(options.workspacePath);

  const enhancedResults: EnhancedRuleSearchResult[] = [];
  for (const result of results) {
    try {
      const rule = await rulesService.getRule(result.id);
      enhancedResults.push({
        id: result.id,
        score: result.score,
        name: rule.name || result.id,
        description: rule.description || rule.name || "",
        format: rule.format || "",
      });
    } catch {
      enhancedResults.push({
        id: result.id,
        score: result.score,
        name: result.id,
        description: "",
        format: "",
      });
    }
  }

  return enhancedResults;
}
