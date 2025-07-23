/**
 * Rule Template Service
 *
 * Extends the RuleService with template-based rule generation.
 */

import * as fs from "fs";
import * as path from "path";
import { RuleService, type RuleMeta as RuleMetadata } from "../rules";
import { createTemplateContext, type RuleGenerationConfig } from "./template-system";
import * as grayMatterNamespace from "gray-matter";
import * as jsYaml from "js-yaml";

const matter = grayMatterNamespace.default || grayMatterNamespace;

/**
 * Add YAML frontmatter to content
 */
function addFrontmatter(content: string, meta: RuleMetadata): string {
  // Use js-yaml's dump function with options to control quoting behavior
  let yamlStr = jsYaml.dump(meta, {
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

/**
 * Type for rule format
 */
export type RuleFormat = "cursor" | "openai";

/**
 * Template for generating rule content and metadata
 */
export interface RuleTemplate {
  /** Unique identifier for the template */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Description of the template */
  description: string;
  
  /** Tags for categorization */
  tags?: string[];
  
  /**
   * Generate content for the rule
   * @param context Template context with configuration and helpers
   * @returns Generated content as a string
   */
  generateContent: (context: any) => string;
  
  /**
   * Generate metadata for the rule (optional)
   * @param context Template context with configuration and helpers
   * @returns Rule metadata object
   */
  generateMeta?: (context: any) => RuleMetadata;
}

/**
 * Options for rule generation
 */
export interface GenerateRulesOptions {
  /** Configuration for rule generation */
  config: RuleGenerationConfig;
  
  /** Templates to use (if not specified, uses all registered templates) */
  selectedRules?: string[];
  
  /** Whether to overwrite existing files */
  overwrite?: boolean;
  
  /** Whether to perform a dry run (don't write files) */
  dryRun?: boolean;
}

/**
 * Result of rule generation
 */
export interface GenerateRulesResult {
  /** Whether the generation was successful */
  success: boolean;
  
  /** Generated rules info */
  rules: Array<{
    id: string;
    path: string;
    content: string;
    meta: RuleMetadata | null;
  }>;
  
  /** Any errors that occurred during generation */
  errors: string[];
  
  /** Configuration used for generation */
  config?: RuleGenerationConfig;
}

/**
 * Rule Template Service
 *
 * Manages templates for generating rule content and metadata.
 */
export class RuleTemplateService {
  private ruleService: RuleService;
  private templateRegistry: Map<string, RuleTemplate> = new Map();
  private workspacePath: string;
  
  /**
   * Create a new RuleTemplateService
   * @param workspacePath Path to the workspace
   */
  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.ruleService = new RuleService(workspacePath);
    
    // Load default templates
    this.registerInitTemplates();
  }
  
  /**
   * Register a template with the service
   * @param template Rule template to register
   */
  registerTemplate(template: RuleTemplate): void {
    if (this.templateRegistry.has(template.id)) {
      // Silently replace existing template to avoid conflicts during testing
      console.debug(`Replacing existing template '${template.id}'`);
    }
    
    this.templateRegistry.set(template.id, template);
  }
  
  /**
   * Get all registered templates
   * @returns Array of rule templates
   */
  getTemplates(): RuleTemplate[] {
    return Array.from(this.templateRegistry.values());
  }
  
  /**
   * Get a template by ID
   * @param id Template ID
   * @returns Rule template or undefined if not found
   */
  getTemplate(id: string): RuleTemplate | undefined {
    return this.templateRegistry.get(id);
  }
  
  /**
   * Generate rules based on configuration and selected templates
   * @param options Options for rule generation
   * @returns Result of rule generation
   */
  async generateRules(options: GenerateRulesOptions): Promise<GenerateRulesResult> {
    const { config, selectedRules, overwrite = false, dryRun = false } = options;
    const result: GenerateRulesResult = { success: true, rules: [], errors: [] };
    
    // Create template context
    const context = createTemplateContext(config);
    
    // Determine templates to use
    let templates: RuleTemplate[] = [];
    if (selectedRules && selectedRules.length > 0) {
      // Use selected templates
      for (const id of selectedRules) {
        const template = this.templateRegistry.get(id);
        if (template) {
          templates.push(template);
        } else {
          result.errors.push(`Template '${id}' not found`);
        }
      }
    } else {
      // Use all templates
      templates = this.getTemplates();
    }
    
    // If there are errors at this point, return early
    if (result.errors.length > 0) {
      result.success = false;
      return result;
    }
    
    // Generate rules
    for (const template of templates) {
      try {
        const generatedRule = await this.generateRule(template, context, overwrite, dryRun);
        result.rules.push(generatedRule);
      } catch (error) {
        result.errors.push(`Error generating rule '${template.id}': ${(error as Error).message}`);
        result.success = false;
      }
    }
    
    // If there are errors, mark as unsuccessful
    if (result.errors.length > 0) {
      result.success = false;
    }
    
    // Add config to result for testing/debugging
    result.config = config;
    
    return result;
  }
  
  /**
   * Generate a single rule from a template
   * @param template Rule template
   * @param context Template context
   * @param overwrite Whether to overwrite existing files
   * @param dryRun Whether to perform a dry run (don't write files)
   * @returns Generated rule info
   */
  private async generateRule(
    template: RuleTemplate,
    context: any,
    overwrite: boolean,
    dryRun: boolean
  ): Promise<{
    id: string;
    path: string;
    content: string;
    meta: RuleMetadata | null;
  }> {
    // Generate content and metadata
    const content = template.generateContent(context);
    const meta = template.generateMeta ? template.generateMeta(context) : null;
    
    // Get output path
    const outputDir = this.getOutputDir(context.config);
    const rulePath = this.getRulePath(template.id, outputDir);
    
    // Ensure directory exists (unless dry run)
    if (!dryRun) {
      const ruleDir = path.dirname(rulePath);
      if (!fs.existsSync(ruleDir)) {
        fs.mkdirSync(ruleDir, { recursive: true });
      }
    }
    
    // Check if file exists and respect overwrite option
    if (!dryRun && fs.existsSync(rulePath) && !overwrite) {
      throw new Error(`Rule file already exists at '${rulePath}' and overwrite is disabled`);
    }
    
    // Write the file (unless dry run)
    if (!dryRun) {
      // If metadata is provided, add YAML frontmatter
      let fileContent = content;
      if (meta) {
        fileContent = addFrontmatter(content, meta);
      }
      
      fs.writeFileSync(rulePath, fileContent);
    }
    
    // Create the base rule object
    const rule: any = {
      id: template.id,
      path: rulePath,
      content,
      meta
    };
    
    // Flatten metadata properties onto the rule object if metadata exists
    if (meta) {
      Object.assign(rule, meta);
    }
    
    return rule;
  }
  
  /**
   * Get the output directory for rules
   * @param config Rule generation config
   * @returns Output directory path
   */
  private getOutputDir(config: RuleGenerationConfig): string {
    // Use configured output directory if provided
    const outputDir = config.outputDir || 
      (config.ruleFormat === "cursor" ? ".cursor/rules" : ".ai/rules");
    
    // If output dir is absolute, use it as-is
    if (path.isAbsolute(outputDir)) {
      return outputDir;
    }
    
    // Otherwise, resolve relative to workspace path
    return path.resolve(this.workspacePath, outputDir);
  }
  
  /**
   * Get the path for a rule file
   * @param id Rule ID
   * @param outputDir Output directory
   * @returns Full path to rule file
   */
  private getRulePath(id: string, outputDir: string): string {
    return path.join(outputDir, `${id}.mdc`);
  }
  
  /**
   * Generate CLI-first rules
   * @param options Options for rule generation (overrides interface to "cli")
   * @returns Result of rule generation
   */
  async generateCliRules(
    options: Omit<GenerateRulesOptions, "config"> & Partial<Pick<RuleGenerationConfig, "ruleFormat" | "outputDir">>
  ): Promise<GenerateRulesResult> {
    return this.generateRules({
      ...options,
      config: {
        interface: "cli",
        mcpEnabled: false,
        mcpTransport: "stdio",
        preferMcp: false,
        ruleFormat: options.ruleFormat || "cursor",
        outputDir: options.outputDir || ".cursor/rules"
      }
    });
  }
  
  /**
   * Generate MCP-only rules
   * @param options Options for rule generation (overrides interface to "mcp")
   * @returns Result of rule generation
   */
  async generateMcpRules(
    options: Omit<GenerateRulesOptions, "config"> & Partial<Pick<RuleGenerationConfig, "ruleFormat" | "outputDir">>
  ): Promise<GenerateRulesResult> {
    return this.generateRules({
      ...options,
      config: {
        interface: "mcp",
        mcpEnabled: true,
        mcpTransport: "stdio",
        preferMcp: true,
        ruleFormat: options.ruleFormat || "cursor",
        outputDir: options.outputDir || ".cursor/rules"
      }
    });
  }
  
  /**
   * Generate hybrid rules
   * @param options Options for rule generation (overrides interface to "hybrid")
   * @returns Result of rule generation
   */
  async generateHybridRules(
    options: Omit<GenerateRulesOptions, "config"> & Partial<Pick<RuleGenerationConfig, "ruleFormat" | "outputDir" | "preferMcp">>
  ): Promise<GenerateRulesResult> {
    return this.generateRules({
      ...options,
      config: {
        interface: "hybrid",
        mcpEnabled: true,
        mcpTransport: "stdio",
        preferMcp: options.preferMcp === undefined ? false : options.preferMcp,
        ruleFormat: options.ruleFormat || "cursor",
        outputDir: options.outputDir || ".cursor/rules"
      }
    });
  }
  
  /**
   * Register default templates
   * These are the core templates used for standard rule generation
   */
  async registerDefaultTemplates(): Promise<void> {
    this.registerInitTemplates(); // Init templates are a subset of default templates
  }
  
  /**
   * Register the init templates synchronously
   * Used specifically by the init.ts file to avoid async/await overhead
   */
  registerInitTemplates(): void {
    try {
      // Synchronous require to avoid circular dependencies
      const { DEFAULT_TEMPLATES } = require("./default-templates");
      
      // Register each template
      for (const template of DEFAULT_TEMPLATES) {
        this.registerTemplate(template);
      }
    } catch (error) {
      console.error("Error registering init templates:", error);
      
      // Register a minimal init template
      this.registerTemplate({
        id: "minsky-workflow",
        name: "Minsky Workflow",
        description: "Minsky workflow orchestration guide",
        tags: ["workflow"],
        generateContent: (context) => {
          return "# Minsky Workflow\n\nThis is a fallback template due to an error loading templates.";
        }
      });
    }
  }
}

/**
 * Create a rule template service
 * @param workspacePath Path to the workspace
 * @returns RuleTemplateService instance
 */
export function createRuleTemplateService(workspacePath: string): RuleTemplateService {
  return new RuleTemplateService(workspacePath);
}

/**
 * Generate rules with a specific configuration
 * @param workspacePath Path to the workspace
 * @param options Options for rule generation
 * @returns Result of rule generation
 */
export async function generateRulesWithConfig(
  workspacePath: string,
  config: RuleGenerationConfig,
  options: Omit<GenerateRulesOptions, "config">
): Promise<GenerateRulesResult> {
  const service = createRuleTemplateService(workspacePath);
  await service.registerDefaultTemplates();
  return service.generateRules({ ...options, config });
} 
