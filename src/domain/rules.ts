import { promises as fs } from "fs";
import { HTTP_OK } from "../utils/constants";
import { join } from "path";
import * as grayMatterNamespace from "gray-matter";
import { existsSync } from "fs";
import { log } from "../utils/logger";
import { getErrorMessage } from "../errors/index";const COMMIT_HASH_SHORT_LENGTH = 7;

// Added logger import
import * as jsYaml from "js-yaml";

const matter = grayMatterNamespace.default || grayMatterNamespace;

// Create a custom stringify function that doesn't add unnecessary quotes
function customMatterStringify(content: string, data: any): string {
  // Use js-yaml's dump function directly with options to control quoting behavior
  let yamlStr = jsYaml.dump(data as unknown, {
    lineWidth: -1, // Don't wrap lines
    noCompatMode: true, // Use YAML 1.2
    quotingType: "\"", // Use double quotes when necessary
    forceQuotes: false, // Don't force quotes on all strings
  });

  // Post-process to ensure descriptions with special characters use double quotes
  // Replace single-quoted descriptions with double-quoted ones
  yamlStr = yamlStr.replace(/^description: '(.+)'$/gm, (match, description) => {
    // Check if description contains special characters that warrant quoting
    if (description.includes(":") || description.includes("!") || description.includes("?")) {
      return `description: "${description}"`;
    }
    return match;
  });

  return `---\n${yamlStr}---\n${content}`;
}

export interface Rule {
  id: string; // Filename without extension
  name?: string; // From frontmatter
  description?: string; // From frontmatter
  globs?: string[]; // From frontmatter, file patterns that this rule applies to
  alwaysApply?: boolean; // From frontmatter, whether this rule is always applied
  tags?: string[]; // From frontmatter, optional tags for categorization
  content: string; // The rule content (without frontmatter)
  format: RuleFormat; // cursor or generic
  path: string; // Full path to the rule file
  formatNote?: string; // Optional format conversion notice
}

export interface RuleMeta {
  name?: string;
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
  tags?: string[];
  [key: string]: any; // Allow for additional custom fields
}

export type RuleFormat = "cursor" | "generic";

export interface RuleOptions {
  format?: RuleFormat;
  tag?: string;
  debug?: boolean; // Add debug option
}

export interface CreateRuleOptions {
  format?: RuleFormat;
  overwrite?: boolean;
}

export interface UpdateRuleOptions {
  content?: string;
  meta?: Partial<RuleMeta>;
}

export interface SearchRuleOptions {
  format?: RuleFormat;
  tag?: string;
  query?: string;
}

export class RuleService {
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    // Log workspace path on initialization for debugging
    log.debug("RuleService initialized", { workspacePath });
  }

  private getRuleDirPath(format: RuleFormat): string {
    const dirPath = join(this.workspacePath, format === "cursor" ? ".cursor/rules" : ".ai/rules");
    return dirPath;
  }

  /**
   * List all rules in the workspace
   */
  async listRules(options: RuleOptions = {}): Promise<Rule[]> {
    const rules: Rule[] = [];
    const formats: RuleFormat[] = options.format ? [options.format] : ["cursor", "generic"];

    for (const format of formats) {
      const dirPath = this.getRuleDirPath(format);

      if (options.debug) {
        log.debug("Listing rules", { directory: dirPath, format });
      }

      try {
        const files = await fs.readdir(dirPath);

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
              originalError: getErrorMessage(error as any),
              stack: error instanceof Error ? (error as any).stack as any : undefined as any,
            });
          }
        }
      } catch (error) {
        // Directory might not exist, which is fine
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          log.error("Error reading rules directory", {
            format,
            originalError: getErrorMessage(error as any),
            stack: error instanceof Error ? (error as any).stack as any : undefined as any,
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
        await fs.access(filePath);

        if (options.debug) {
          log.debug("File exists in requested format", { filePath });
        }

        // File exists in requested format, read and parse it
        const content = String(await fs.readFile(filePath, "utf-8")) as string;

        try {
          // FIXED: Added try/catch block around matter parsing to handle YAML parsing errors
          // Some rule files may have formatting issues in their frontmatter that cause gray-matter to throw
          const { data, content: ruleContent } = matter(content);

          if (options.debug) {
            log.debug("Successfully parsed frontmatter", {
              filePath,
              dataKeys: Object.keys(data as unknown) as unknown,
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
          } as unknown;
        } catch (error) {
          // FIXED: Gracefully handle errors in frontmatter parsing
          // This allows rules with invalid YAML frontmatter to still be loaded and used
          if (options.debug) {
            log.error("Error parsing frontmatter", {
              filePath,
              error: getErrorMessage(error as any),
              content: (((content) as any).toString() as any).substring(0, HTTP_OK), // Log the first HTTP_OK chars for debugging
            });
          }

          // If there's an issue with the frontmatter, try to handle it gracefully
          // Just extract content after the second '---' or use the whole content if no frontmatter markers
          let extractedContent = content;
          const frontmatterEndIndex = content.toString().indexOf("---", 3);
          if (content.startsWith("---") && frontmatterEndIndex > 0) {
            extractedContent = (content).toString().substring(frontmatterEndIndex + 3).toString().trim();
          }

          // Return a basic rule object with just the content, missing the metadata from frontmatter
          // This is better than failing completely as we still provide the rule content
          return {
            id: bareId,
            content: extractedContent,
            format: requestedFormat,
            path: filePath,
          };
        }
      } catch (error) {
        // Rule not found in the requested format
        if (options.debug) {
          log.debug("File not found in requested format", {
            filePath,
            error: getErrorMessage(error as any),
          });
        }
        // Instead of failing immediately, try other formats below
      }
    }

    // Try to find in all formats if not found in the requested format or if no format was specified
    const formatsToSearch: RuleFormat[] = ["cursor", "generic"];

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
        await fs.access(filePath);

        if (options.debug) {
          log.debug("File exists in alternative format", { filePath });
        }

        // File exists, read and parse it
        const content = String(await fs.readFile(filePath, "utf-8")) as string;

        try {
          // FIXED: Same try/catch pattern for frontmatter parsing in alternative formats
          const { data, content: ruleContent } = matter(content);

          if (options.debug) {
            log.debug("Successfully parsed frontmatter in alternative format", {
              filePath,
              dataKeys: Object.keys(data as unknown) as unknown,
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
            } as unknown;
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
          } as unknown;
        } catch (error) {
          // FIXED: Gracefully handle errors in frontmatter parsing for alternative formats
          if (options.debug) {
            log.error("Error parsing frontmatter in alternative format", {
              filePath,
              error: getErrorMessage(error as any),
              content: (((content) as any).toString() as any).substring(0, HTTP_OK), // Log the first HTTP_OK chars for debugging
            });
          }

          // Same frontmatter error handling as above for consistency
          let extractedContent = content;
          const frontmatterEndIndex = content.toString().indexOf("---", 3);
          if (content.startsWith("---") && frontmatterEndIndex > 0) {
            extractedContent = (content).toString().substring(frontmatterEndIndex + 3).toString().trim();
          }

          return {
            id: bareId,
            content: extractedContent,
            format,
            path: filePath,
          };
        }
      } catch (error) {
        // File doesn't exist in this format, try the next one
        if (options.debug) {
          log.debug("File not found in alternative format", {
            filePath,
            error: getErrorMessage(error as any),
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
   * Create a new rule
   */
  async createRule(id: string,
    content: string,
    meta: RuleMeta,
    options: CreateRuleOptions = {}
  ): Promise<Rule> {
    const format = options.format || "cursor";
    const dirPath = this.getRuleDirPath(format);
    const filePath = join(dirPath, `${id}.mdc`);

    // Ensure directory exists
    await fs.mkdir(dirPath, { recursive: true });

    // Check if rule already exists
    if (existsSync(filePath) && !options.overwrite) {
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
    const fileContent = customMatterStringify(content, cleanMeta);

    // Write the file
    await fs.writeFile(filePath, fileContent, "utf-8");

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
  async updateRule(id: string,
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
    const fileContent = customMatterStringify(updatedContent, metaForFrontmatter);

    // Write the file
    await fs.writeFile(rule.path, fileContent, "utf-8");

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
