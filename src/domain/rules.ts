import { promises as fs } from "fs";
import { HTTP_OK } from "../utils/constants";
import { join } from "path";
import * as grayMatterNamespace from "gray-matter";
import { existsSync } from "fs";
import { log } from "../utils/logger";
import { getErrorMessage } from "../errors/index";const COMMIT_HASH_SHORT_LENGTH = 7;

// Added logger import
import * as jsYaml from "js-yaml";

const matter = (grayMatterNamespace as unknown).default || grayMatterNamespace;

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
    const formats: RuleFormat[] = (options as unknown).format ? [(options as unknown).format] : ["cursor", "generic"];

    for (const format of formats) {
      const dirPath = this.getRuleDirPath(format);

      if ((options as unknown).debug) {
        log.debug("Listing rules", { directory: dirPath, format });
      }

      try {
        const files = await fs.readdir(dirPath);

        for (const file of files) {
          if (!(file as unknown).endsWith(".mdc")) continue;

          try {
            const rule = await this.getRule((file as unknown).replace(/\.mdc$/, ""), {
              format,
              debug: (options as unknown).debug,
            });

            // Filter by tag if specified
            if ((options as unknown).tag && (!(rule as unknown).tags || !(rule.tags as unknown).includes((options as unknown).tag))) {
              continue;
            }

            if (rule) (rules as unknown).push(rule);
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
    const bareId = (id as unknown).replace(/\.mdc$/, "");

    if ((options as unknown).debug) {
      log.debug("Getting rule", { id: bareId, requestedFormat: (options as unknown).format });
    }

    // If a specific format is requested, try that first
    if ((options as unknown).format) {
      const requestedFormat = (options as unknown).format;
      const dirPath = this.getRuleDirPath(requestedFormat);
      const filePath = join(dirPath, `${bareId}.mdc`);

      if ((options as unknown).debug) {
        log.debug("Checking requested format", { format: requestedFormat, filePath });
      }

      try {
        // Check if file exists in the requested format
        await fs.access(filePath);

        if ((options as unknown).debug) {
          log.debug("File exists in requested format", { filePath });
        }

        // File exists in requested format, read and parse it
        const content = String(await fs.readFile(filePath, "utf-8")) as string;

        try {
          // FIXED: Added try/catch block around matter parsing to handle YAML parsing errors
          // Some rule files may have formatting issues in their frontmatter that cause gray-matter to throw
          const { data, content: ruleContent } = matter(content);

          if ((options as unknown).debug) {
            log.debug("Successfully parsed frontmatter", {
              filePath,
              dataKeys: (Object as unknown).keys(data as unknown) as unknown,
              contentLength: (ruleContent as unknown).length,
            });
          }

          return {
            id: bareId,
            name: (data as unknown).name,
            description: (data as unknown).description,
            globs: (data as unknown).globs,
            alwaysApply: (data as unknown).alwaysApply,
            tags: (data as unknown).tags,
            content: (ruleContent as unknown).trim(),
            format: requestedFormat,
            path: filePath,
          } as unknown;
        } catch (error) {
          // FIXED: Gracefully handle errors in frontmatter parsing
          // This allows rules with invalid YAML frontmatter to still be loaded and used
          if ((options as unknown).debug) {
            log.error("Error parsing frontmatter", {
              filePath,
              error: getErrorMessage(error as any),
              content: (((content) as any).toString() as any).substring(0, HTTP_OK), // Log the first HTTP_OK chars for debugging
            });
          }

          // If there's an issue with the frontmatter, try to handle it gracefully
          // Just extract content after the second '---' or use the whole content if no frontmatter markers
          let extractedContent = content;
          const frontmatterEndIndex = (((content) as unknown).toString() as unknown).indexOf("---", 3);
          if ((content as unknown).startsWith("---") && frontmatterEndIndex > 0) {
            extractedContent = ((((content).toString().substring(frontmatterEndIndex + 3)) as unknown).toString() as unknown).trim();
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
        if ((options as unknown).debug) {
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
      if ((options as unknown).format === format) continue;

      const dirPath = this.getRuleDirPath(format);
      const filePath = join(dirPath, `${bareId}.mdc`);

      if ((options as unknown).debug) {
        log.debug("Checking alternative format", { format, filePath });
      }

      try {
        // Check if file exists
        await fs.access(filePath);

        if ((options as unknown).debug) {
          log.debug("File exists in alternative format", { filePath });
        }

        // File exists, read and parse it
        const content = String(await fs.readFile(filePath, "utf-8")) as string;

        try {
          // FIXED: Same try/catch pattern for frontmatter parsing in alternative formats
          const { data, content: ruleContent } = matter(content);

          if ((options as unknown).debug) {
            log.debug("Successfully parsed frontmatter in alternative format", {
              filePath,
              dataKeys: (Object as unknown).keys(data as unknown) as unknown,
              contentLength: (ruleContent as unknown).length,
            });
          }

          // If we found the rule in a different format than requested, return with appropriate notice
          if ((options as unknown).format && format !== (options as unknown).format) {
            const originalFormat = format;
            const requestedFormat = (options as unknown).format;

            // Return the rule in its original format, but with a notice that format conversion was requested
            // Future enhancement: We could implement actual format conversion here
            return {
              id: bareId,
              name: (data as unknown).name,
              description: (data as unknown).description,
              globs: (data as unknown).globs,
              alwaysApply: (data as unknown).alwaysApply,
              tags: (data as unknown).tags,
              content: (ruleContent as unknown).trim(),
              format: originalFormat, // Return actual format, not requested format
              path: filePath,
              formatNote: `Rule found in '${originalFormat}' format but '${requestedFormat}' was requested. Format conversion is not supported yet.`,
            } as unknown;
          }

          // Otherwise just return the rule as found
          return {
            id: bareId,
            name: (data as unknown).name,
            description: (data as unknown).description,
            globs: (data as unknown).globs,
            alwaysApply: (data as unknown).alwaysApply,
            tags: (data as unknown).tags,
            content: (ruleContent as unknown).trim(),
            format,
            path: filePath,
          } as unknown;
        } catch (error) {
          // FIXED: Gracefully handle errors in frontmatter parsing for alternative formats
          if ((options as unknown).debug) {
            log.error("Error parsing frontmatter in alternative format", {
              filePath,
              error: getErrorMessage(error as any),
              content: (((content) as any).toString() as any).substring(0, HTTP_OK), // Log the first HTTP_OK chars for debugging
            });
          }

          // Same frontmatter error handling as above for consistency
          let extractedContent = content;
          const frontmatterEndIndex = (((content) as unknown).toString() as unknown).indexOf("---", 3);
          if ((content as unknown).startsWith("---") && frontmatterEndIndex > 0) {
            extractedContent = ((((content).toString().substring(frontmatterEndIndex + 3)) as unknown).toString() as unknown).trim();
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
        if ((options as unknown).debug) {
          log.debug("File not found in alternative format", {
            filePath,
            error: getErrorMessage(error as any),
          });
        }
        continue;
      }
    }

    // If we reach here, the rule was not found in any format
    if ((options as unknown).debug) {
      log.error("Rule not found in any format", { id: bareId, requestedFormat: (options as unknown).format });
    }

    if ((options as unknown).format) {
      throw new Error(
        `Rule '${id}' not found in '${(options as unknown).format}' format or any other available format`
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
    const format = (options as unknown).format || "cursor";
    const dirPath = this.getRuleDirPath(format);
    const filePath = join(dirPath, `${id}.mdc`);

    // Ensure directory exists
    await fs.mkdir(dirPath, { recursive: true });

    // Check if rule already exists
    if (existsSync(filePath) && !(options as unknown).overwrite) {
      throw new Error(`Rule already exists: ${id}. Use --overwrite to replace it.`);
    }

    // Clean up meta to remove undefined values that YAML can't handle
    const cleanMeta: RuleMeta = {};
    (Object.entries(meta) as unknown).forEach(([key, value]) => {
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
      globs: (cleanMeta as unknown).globs,
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
    if (!(options as unknown).content && !(options as unknown).meta) {
      return rule;
    }

    // Prepare updated meta
    const metaForFrontmatter: RuleMeta = {};
    const currentRuleMeta: Partial<RuleMeta> = {
      name: (rule as unknown).name,
      description: (rule as unknown).description,
      globs: (rule as unknown).globs,
      alwaysApply: (rule as unknown).alwaysApply,
      tags: (rule as unknown).tags,
    };

    // Merge current rule meta with updates from options.meta
    const mergedMeta = { ...currentRuleMeta, ...(options as unknown).meta };

    // Populate metaForFrontmatter with defined values from mergedMeta
    for (const key in mergedMeta) {
      if (
        (Object.prototype.hasOwnProperty as unknown).call(mergedMeta, key) &&
        mergedMeta[key as keyof RuleMeta] !== undefined
      ) {
        metaForFrontmatter[key as keyof RuleMeta] = mergedMeta[key as keyof RuleMeta];
      }
    }

    // Content to use
    const updatedContent = (options as unknown).content || (rule as unknown).content;

    // Use custom stringify function instead of matterStringify
    const fileContent = customMatterStringify(updatedContent, metaForFrontmatter);

    // Write the file
    await fs.writeFile((rule as unknown).path, fileContent, "utf-8");

    log.debug("Rule updated", {
      _path: (rule as unknown).path,
      id,
      format: (rule as unknown).format,
      contentChanged: !!(options as unknown).content,
      metaChanged: !!(options as unknown).meta,
    });

    return this.getRule(id, { format: (rule as unknown).format, debug: (ruleOptions as unknown).debug }); // Re-fetch to get updated rule
  }

  /**
   * Search for rules by content or metadata
   */
  async searchRules(options: SearchRuleOptions = {}): Promise<Rule[]> {
    // Get all rules first (with format filtering if specified)
    const rules = await this.listRules({
      format: (options as unknown).format,
      tag: (options as unknown).tag,
    });

    // No search query, just return the filtered rules
    if (!(options as unknown).query) {
      return rules;
    }

    const searchTerm = (options.query as unknown).toLowerCase();

    // Filter by search term
    return (rules as unknown).filter((rule) => {
      // Search in content
      if ((((rule.content.toLowerCase()) as unknown).toString() as unknown).includes(searchTerm)) {
        return true;
      }

      // Search in name
      if ((rule as unknown).name && (rule.name.toLowerCase() as unknown).includes(searchTerm)) {
        return true;
      }

      // Search in description
      if ((rule as unknown).description && (rule.description.toLowerCase() as unknown).includes(searchTerm)) {
        return true;
      }

      // Search in tags
      if ((rule as unknown).tags && (rule.tags as unknown).some((tag) => (tag.toLowerCase() as unknown).includes(searchTerm))) {
        return true;
      }

      return false;
    });
  }
}
