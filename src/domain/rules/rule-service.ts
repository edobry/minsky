/**
 * RuleService
 *
 * Handles CRUD operations for rule files with frontmatter metadata.
 */
import { injectable } from "tsyringe";
import { promises as nodeFsPromises } from "fs";
import { join } from "path";
import * as grayMatterNamespace from "gray-matter";
import { existsSync as nodeExistsSync } from "fs";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { serializeYamlFrontmatter } from "./utils/yaml-frontmatter";
import type {
  Rule,
  RuleMeta,
  RuleFormat,
  RuleOptions,
  CreateRuleOptions,
  UpdateRuleOptions,
  SearchRuleOptions,
} from "./types";

const matter = grayMatterNamespace.default || grayMatterNamespace;

@injectable()
export class RuleService {
  private workspacePath: string;
  private fs: Pick<
    typeof nodeFsPromises,
    "readdir" | "access" | "readFile" | "mkdir" | "writeFile"
  >;
  private existsSyncFn: (path: string) => boolean;

  constructor(
    workspacePath: string,
    deps?: {
      fsPromises?: Pick<
        typeof nodeFsPromises,
        "readdir" | "access" | "readFile" | "mkdir" | "writeFile"
      >;
      existsSyncFn?: (path: string) => boolean;
    }
  ) {
    this.workspacePath = workspacePath;
    this.fs = deps?.fsPromises || nodeFsPromises;
    this.existsSyncFn = deps?.existsSyncFn || nodeExistsSync;
    // Log workspace path on initialization for debugging
    log.debug("RuleService initialized", { workspacePath });
  }

  private getRuleDirPath(format: RuleFormat): string {
    const formatDirMap: Record<RuleFormat, string> = {
      cursor: ".cursor/rules",
      generic: ".ai/rules",
      minsky: ".minsky/rules",
    };
    const dirPath = join(this.workspacePath, formatDirMap[format]);
    return dirPath;
  }

  /**
   * List all rules in the workspace
   */
  async listRules(options: RuleOptions = {}): Promise<Rule[]> {
    const rules: Rule[] = [];
    const formats: RuleFormat[] = options.format
      ? [options.format]
      : ["minsky", "cursor", "generic"];

    for (const format of formats) {
      const dirPath = this.getRuleDirPath(format);

      if (options.debug) {
        log.debug("Listing rules", { directory: dirPath, format });
      }

      try {
        const files = await this.fs.readdir(dirPath);

        for (const file of files) {
          if (!file.endsWith(".mdc")) continue;

          try {
            const rule = await this.getRule(file.replace(/\.mdc$/, ""), {
              format,
              debug: options.debug,
            });

            // Filter by tag if specified
            if (options.tag && (!rule.tags || !rule.tags.includes(options.tag))) {
              continue;
            }

            if (rule) rules.push(rule);
          } catch (error) {
            log.error("Error processing rule file", {
              file,
              originalError: getErrorMessage(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
          }
        }
      } catch (error) {
        // Directory might not exist, which is fine
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          log.error("Error reading rules directory", {
            format,
            originalError: getErrorMessage(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    }

    return rules;
  }

  /**
   * Get a specific rule by id
   */
  async getRule(id: string, options: RuleOptions = {}): Promise<Rule> {
    // Remove extension if it was included
    const bareId = id.replace(/\.mdc$/, "");

    if (options.debug) {
      log.debug("Getting rule", { id: bareId, requestedFormat: options.format });
    }

    // If a specific format is requested, try that first
    if (options.format) {
      const requestedFormat = options.format;
      const dirPath = this.getRuleDirPath(requestedFormat);
      const filePath = join(dirPath, `${bareId}.mdc`);

      if (options.debug) {
        log.debug("Checking requested format", { format: requestedFormat, filePath });
      }

      try {
        // Check if file exists in the requested format
        await this.fs.access(filePath);

        if (options.debug) {
          log.debug("File exists in requested format", { filePath });
        }

        // File exists in requested format, read and parse it
        const content = String(await this.fs.readFile(filePath, "utf-8")) as string;

        try {
          const { data, content: ruleContent } = matter(content);

          if (options.debug) {
            log.debug("Successfully parsed frontmatter", {
              filePath,
              dataKeys: Object.keys(data),
              contentLength: ruleContent.length,
            });
          }

          return {
            id: bareId,
            name: data.name,
            description: data.description,
            globs: data.globs,
            alwaysApply: data.alwaysApply,
            tags: data.tags,
            content: ruleContent.trim(),
            format: requestedFormat,
            path: filePath,
          };
        } catch (parseError) {
          // Re-throw with the file path included so callers can surface the problem.
          // Silently swallowing YAML errors produces rules with empty frontmatter,
          // which causes data loss during compile (e.g. globs/description wiped to {}).
          throw new Error(
            `Failed to parse YAML frontmatter in rule file "${filePath}": ${getErrorMessage(parseError)}`
          );
        }
      } catch (error) {
        // If it's a frontmatter parse error we just threw, propagate it up.
        if (
          error instanceof Error &&
          error.message.startsWith("Failed to parse YAML frontmatter")
        ) {
          throw error;
        }
        // Rule not found in the requested format
        if (options.debug) {
          log.debug("File not found in requested format", {
            filePath,
            error: getErrorMessage(error),
          });
        }
        // Instead of failing immediately, try other formats below
      }
    }

    // Try to find in all formats if not found in the requested format or if no format was specified
    const formatsToSearch: RuleFormat[] = ["minsky", "cursor", "generic"];

    for (const format of formatsToSearch) {
      // Skip if we already checked this format above
      if (options.format === format) continue;

      const dirPath = this.getRuleDirPath(format);
      const filePath = join(dirPath, `${bareId}.mdc`);

      if (options.debug) {
        log.debug("Checking alternative format", { format, filePath });
      }

      try {
        // Check if file exists
        await this.fs.access(filePath);

        if (options.debug) {
          log.debug("File exists in alternative format", { filePath });
        }

        // File exists, read and parse it
        const content = String(await this.fs.readFile(filePath, "utf-8")) as string;

        try {
          const { data, content: ruleContent } = matter(content);

          if (options.debug) {
            log.debug("Successfully parsed frontmatter in alternative format", {
              filePath,
              dataKeys: Object.keys(data),
              contentLength: ruleContent.length,
            });
          }

          // If we found the rule in a different format than requested, return with appropriate notice
          if (options.format && format !== options.format) {
            const originalFormat = format;
            const requestedFormat = options.format;

            // Return the rule in its original format, but with a notice that format conversion was requested
            // Future enhancement: We could implement actual format conversion here
            return {
              id: bareId,
              name: data.name,
              description: data.description,
              globs: data.globs,
              alwaysApply: data.alwaysApply,
              tags: data.tags,
              content: ruleContent.trim(),
              format: originalFormat, // Return actual format, not requested format
              path: filePath,
              formatNote: `Rule found in '${originalFormat}' format but '${requestedFormat}' was requested. Format conversion is not supported yet.`,
            };
          }

          // Otherwise just return the rule as found
          return {
            id: bareId,
            name: data.name,
            description: data.description,
            globs: data.globs,
            alwaysApply: data.alwaysApply,
            tags: data.tags,
            content: ruleContent.trim(),
            format,
            path: filePath,
          };
        } catch (parseError) {
          // Re-throw with the file path so callers can surface the problem.
          // Silently swallowing YAML errors produces rules with empty frontmatter,
          // causing data loss during compile (e.g. globs/description wiped to {}).
          throw new Error(
            `Failed to parse YAML frontmatter in rule file "${filePath}": ${getErrorMessage(parseError)}`
          );
        }
      } catch (error) {
        // If it's a frontmatter parse error we just threw, propagate it up.
        if (
          error instanceof Error &&
          error.message.startsWith("Failed to parse YAML frontmatter")
        ) {
          throw error;
        }
        // File doesn't exist in this format, try the next one
        if (options.debug) {
          log.debug("File not found in alternative format", {
            filePath,
            error: getErrorMessage(error),
          });
        }
        continue;
      }
    }

    // If we reach here, the rule was not found in any format
    if (options.debug) {
      log.error("Rule not found in any format", { id: bareId, requestedFormat: options.format });
    }

    if (options.format) {
      throw new Error(
        `Rule '${id}' not found in '${options.format}' format or any other available format`
      );
    } else {
      throw new Error(`Rule not found: ${id}`);
    }
  }

  /**
   * Find a rule by ID (alias for getRule with error handling)
   */
  async findRuleById(id: string, options: RuleOptions = {}): Promise<Rule | null> {
    try {
      return await this.getRule(id, options);
    } catch (error) {
      // Return null if rule is not found, instead of throwing
      if (options.debug) {
        log.debug("Rule not found", { id, error: getErrorMessage(error) });
      }
      return null;
    }
  }

  /**
   * Create a new rule
   */
  async createRule(
    id: string,
    content: string,
    meta: RuleMeta,
    options: CreateRuleOptions = {}
  ): Promise<Rule> {
    const format = options.format || "minsky";
    const dirPath = this.getRuleDirPath(format);
    const filePath = join(dirPath, `${id}.mdc`);

    // Ensure directory exists
    await this.fs.mkdir(dirPath, { recursive: true });

    // Check if rule already exists
    if (this.existsSyncFn(filePath) && !options.overwrite) {
      throw new Error(`Rule already exists: ${id}. Use --overwrite to replace it.`);
    }

    // Clean up meta to remove undefined values that YAML can't handle
    const cleanMeta: RuleMeta = {};
    Object.entries(meta).forEach(([key, value]) => {
      if (value !== undefined) {
        cleanMeta[key] = value;
      }
    });

    // Use custom stringify function instead of matterStringify
    const fileContent = serializeYamlFrontmatter(content, cleanMeta);

    // Write the file
    await this.fs.writeFile(filePath, fileContent, "utf-8");

    log.debug("Rule created/updated", {
      _path: filePath,
      id,
      format,
      globs: cleanMeta.globs,
    });

    // Return the created rule
    return {
      id,
      ...cleanMeta,
      content,
      format,
      path: filePath,
    };
  }

  /**
   * Update an existing rule
   */
  async updateRule(
    id: string,
    options: UpdateRuleOptions,
    ruleOptions: RuleOptions = {}
  ): Promise<Rule> {
    const rule = await this.getRule(id, ruleOptions);

    // No changes needed
    if (!options.content && !options.meta) {
      return rule;
    }

    // Prepare updated meta
    const metaForFrontmatter: RuleMeta = {};
    const currentRuleMeta: Partial<RuleMeta> = {
      name: rule.name,
      description: rule.description,
      globs: rule.globs,
      alwaysApply: rule.alwaysApply,
      tags: rule.tags,
    };

    // Merge current rule meta with updates from options.meta
    const mergedMeta = { ...currentRuleMeta, ...options.meta };

    // Populate metaForFrontmatter with defined values from mergedMeta
    for (const key in mergedMeta) {
      if (
        Object.prototype.hasOwnProperty.call(mergedMeta, key) &&
        mergedMeta[key as keyof RuleMeta] !== undefined
      ) {
        metaForFrontmatter[key as keyof RuleMeta] = mergedMeta[key as keyof RuleMeta];
      }
    }

    // Content to use
    const updatedContent = options.content || rule.content;

    // Use custom stringify function instead of matterStringify
    const fileContent = serializeYamlFrontmatter(updatedContent, metaForFrontmatter);

    // Write the file
    await this.fs.writeFile(rule.path, fileContent, "utf-8");

    log.debug("Rule updated", {
      _path: rule.path,
      id,
      format: rule.format,
      contentChanged: !!options.content,
      metaChanged: !!options.meta,
    });

    return this.getRule(id, { format: rule.format, debug: ruleOptions.debug }); // Re-fetch to get updated rule
  }

  /**
   * Search for rules by content or metadata
   */
  async searchRules(options: SearchRuleOptions = {}): Promise<Rule[]> {
    // Get all rules first (with format filtering if specified)
    const rules = await this.listRules({
      format: options.format,
      tag: options.tag,
    });

    // No search query, just return the filtered rules
    if (!options.query) {
      return rules;
    }

    const searchTerm = options.query.toLowerCase();

    // Filter by search term
    return rules.filter((rule) => {
      // Search in content
      if (rule.content.toLowerCase().toString().includes(searchTerm)) {
        return true;
      }

      // Search in name
      if (rule.name && rule.name.toLowerCase().includes(searchTerm)) {
        return true;
      }

      // Search in description
      if (rule.description && rule.description.toLowerCase().includes(searchTerm)) {
        return true;
      }

      // Search in tags
      if (rule.tags && rule.tags.some((tag) => tag.toLowerCase().includes(searchTerm))) {
        return true;
      }

      return false;
    });
  }
}
