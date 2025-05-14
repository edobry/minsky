import { promises as fs } from "fs";
import { join, basename, dirname } from "path";
import matter from "gray-matter";
import { existsSync } from "fs";

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

    // Try to find in specified format, or search in both formats
    const formats: RuleFormat[] = options.format ? [options.format] : ["cursor", "generic"];

    for (const format of formats) {
      const dirPath = this.getRuleDirPath(format);
      const filePath = join(dirPath, `${bareId}.mdc`);

      if (options.debug) {
        console.log(`[DEBUG] Attempting to read rule from: ${filePath}`);
        console.log(`[DEBUG] File exists check: ${existsSync(filePath)}`);
      }

      try {
        // Check if file exists
        await fs.access(filePath);

        // File exists, read and parse it
        const content = await fs.readFile(filePath, "utf-8");
        
        if (options.debug) {
          console.log(`[DEBUG] Successfully read file: ${filePath}`);
          console.log(`[DEBUG] Content length: ${content.length} bytes`);
        }
        
        const { data, content: ruleContent } = matter(content);

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
        if (options.debug) {
          console.error(`[DEBUG] Error accessing rule file: ${filePath}`, error);
        }
        
        // File doesn't exist in this format, try the next one
        if (format === formats[formats.length - 1]) {
          throw new Error(`Rule not found: ${id}`);
        }
      }
    }

    throw new Error(`Rule not found: ${id}`);
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
    const fileContent = matter.stringify(content, cleanMeta);

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
    const fileContent = matter.stringify(updatedContent, cleanMeta);

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
