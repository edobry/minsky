import { promises as fs } from "fs";
import { join, basename, dirname } from "path";
import * as grayMatterNamespace from "gray-matter";
import { existsSync } from "fs";

const matter = (grayMatterNamespace as any).default || grayMatterNamespace;
const matterStringify = (grayMatterNamespace as any).stringify || (matter as any).stringify;

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
    console.log(`[DEBUG] RuleService initialized with workspace path: ${workspacePath}`);
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
        console.log(`[DEBUG] Listing rules from directory: ${dirPath}`);
      }

      try {
        const files = await fs.readdir(dirPath);

        for (const file of files) {
          if (!file.endsWith(".mdc")) continue;

          try {
            const rule = await this.getRule(file.replace(/\.mdc$/, ""), { format, debug: options.debug });

            // Filter by tag if specified
            if (options.tag && (!rule.tags || !rule.tags.includes(options.tag))) {
              continue;
            }

            if (rule) rules.push(rule);
          } catch (error) {
            console.error(`Error processing rule file: ${file}`, error);
          }
        }
      } catch (error) {
        // Directory might not exist, which is fine
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`Error reading rules directory for ${format}:`, error);
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

    // If a specific format is requested, try that first 
    if (options.format) {
      const requestedFormat = options.format;
      const dirPath = this.getRuleDirPath(requestedFormat);
      const filePath = join(dirPath, `${bareId}.mdc`);

      try {
        // Check if file exists in the requested format
        await fs.access(filePath);

        // File exists in requested format, read and parse it
        const content = await fs.readFile(filePath, "utf-8");
        const { data, content: ruleContent } = matter(content);

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
      } catch (error) {
        // Rule not found in the requested format
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

      try {
        // Check if file exists
        await fs.access(filePath);

        // File exists, read and parse it
        const content = await fs.readFile(filePath, "utf-8");
        const { data, content: ruleContent } = matter(content);

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
            formatNote: `Rule found in '${originalFormat}' format but '${requestedFormat}' was requested. Format conversion is not supported yet.`
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
      } catch (error) {
        // File doesn't exist in this format, try the next one
        continue;
      }
    }

    // If we reach here, the rule was not found in any format
    if (options.format) {
      throw new Error(`Rule '${id}' not found in '${options.format}' format or any other available format`);
    } else {
      throw new Error(`Rule not found: ${id}`);
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

    // Create frontmatter content
    const fileContent = matterStringify(content, cleanMeta);

    // Write the file
    await fs.writeFile(filePath, fileContent, "utf-8");

    console.log(`[DEBUG] Rule created/updated at path: ${filePath}`);

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
    // Get the existing rule first
    const rule = await this.getRule(id, ruleOptions);

    // No changes needed
    if (!options.content && !options.meta) {
      return rule;
    }

    // Prepare updated meta
    const updatedMeta: RuleMeta = {
      name: rule.name,
      description: rule.description,
      globs: rule.globs,
      alwaysApply: rule.alwaysApply,
      tags: rule.tags,
    };

    // Apply meta updates if any
    if (options.meta) {
      Object.assign(updatedMeta, options.meta);
    }

    // Clean up meta to remove undefined values that YAML can't handle
    const cleanMeta: RuleMeta = {};
    Object.entries(updatedMeta).forEach(([key, value]) => {
      if (value !== undefined) {
        cleanMeta[key] = value;
      }
    });

    // Content to use
    const updatedContent = options.content || rule.content;

    // Create frontmatter content
    const fileContent = matterStringify(updatedContent, cleanMeta);

    // Write the file
    await fs.writeFile(rule.path, fileContent, "utf-8");
    console.log(`[DEBUG] Rule updated at path: ${rule.path}`);

    // Return the updated rule
    return {
      ...rule,
      ...cleanMeta,
      content: updatedContent,
    };
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
      if (rule.content.toLowerCase().includes(searchTerm)) {
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
