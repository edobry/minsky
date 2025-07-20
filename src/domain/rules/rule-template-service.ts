/**
 * Rule Template Service
 * 
 * Extends the base RuleService with template generation capabilities.
 * This service can generate rules dynamically based on interface preferences
 * (CLI, MCP, or hybrid) using the template system.
 */

import { RuleService, type Rule, type RuleMeta, type RuleFormat } from "../rules";
import {
  type RuleGenerationConfig,
  type TemplateContext,
  createTemplateContext,
  DEFAULT_CLI_CONFIG,
  DEFAULT_MCP_CONFIG,
  DEFAULT_HYBRID_CONFIG
} from "./template-system";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

// ============================================================================
// Template Registry Interface
// ============================================================================

export interface RuleTemplate {
  /** Template ID (matches rule file name) */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Template description */
  description: string;
  
  /** File patterns this rule applies to */
  globs?: string[];
  
  /** Whether this rule should always be applied */
  alwaysApply?: boolean;
  
  /** Tags for categorization */
  tags?: string[];
  
  /** Template generation function */
  generateContent: (context: TemplateContext) => string;
  
  /** Optional custom metadata generation */
  generateMeta?: (context: TemplateContext) => Partial<RuleMeta>;
}

export interface GenerateRulesOptions {
  /** Rule generation configuration */
  config: RuleGenerationConfig;
  
  /** Whether to overwrite existing rules */
  overwrite?: boolean;
  
  /** Specific rules to generate (if not provided, generates all) */
  selectedRules?: string[];
  
  /** Dry run - don't actually write files */
  dryRun?: boolean;
  
  /** Debug output */
  debug?: boolean;
}

export interface GenerateRulesResult {
  /** Whether the operation was successful */
  success: boolean;
  
  /** Generated rules */
  rules: Rule[];
  
  /** Any errors that occurred */
  errors: string[];
  
  /** Output directory used */
  outputDir: string;
  
  /** Configuration used */
  config: RuleGenerationConfig;
}

// ============================================================================
// Rule Template Service
// ============================================================================

export class RuleTemplateService extends RuleService {
  private templateRegistry: Map<string, RuleTemplate> = new Map();

  constructor(workspacePath: string) {
    super(workspacePath);
    log.debug("RuleTemplateService initialized", { workspacePath });
    
    // Register default templates
    this.registerDefaultTemplates();
  }

  // ========================================================================
  // Template Registration
  // ========================================================================

  /**
   * Register a rule template
   */
  registerTemplate(template: RuleTemplate): void {
    this.templateRegistry.set(template.id, template);
    log.debug("Template registered", {
      templateId: template.id,
      name: template.name,
      tags: template.tags
    });
  }

  /**
   * Get all registered templates
   */
  getTemplates(): RuleTemplate[] {
    return Array.from(this.templateRegistry.values());
  }

  /**
   * Get a specific template by ID
   */
  getTemplate(id: string): RuleTemplate | undefined {
    return this.templateRegistry.get(id);
  }

  // ========================================================================
  // Rule Generation
  // ========================================================================

  /**
   * Generate rules based on configuration
   */
  async generateRules(options: GenerateRulesOptions): Promise<GenerateRulesResult> {
    const { config, overwrite = false, selectedRules, dryRun = false, debug = false } = options;
    
    const result: GenerateRulesResult = {
      success: true,
      rules: [],
      errors: [],
      outputDir: config.outputDir || this.getOutputDir(config.ruleFormat),
      config
    };

    if (debug) {
      log.debug("Starting rule generation", {
        config,
        selectedRules,
        dryRun,
        templateCount: this.templateRegistry.size
      });
    }

    // Create template context
    const context = createTemplateContext(config);

    // Determine which templates to generate
    const templatesToGenerate = selectedRules
      ? selectedRules.map(id => this.templateRegistry.get(id)).filter(Boolean) as RuleTemplate[]
      : this.getTemplates();

    if (debug) {
      log.debug("Templates to generate", {
        count: templatesToGenerate.length,
        templateIds: templatesToGenerate.map(t => t.id)
      });
    }

    // Generate each template
    for (const template of templatesToGenerate) {
      try {
        const rule = await this.generateRule(template, context, { overwrite, dryRun, debug });
        result.rules.push(rule);
        
        if (debug) {
          log.debug("Rule generated successfully", {
            templateId: template.id,
            ruleId: rule.id,
            contentLength: rule.content.length
          });
        }
      } catch (error) {
        const errorMessage = `Failed to generate rule '${template.id}': ${getErrorMessage(error)}`;
        result.errors.push(errorMessage);
        result.success = false;
        
        log.error("Rule generation failed", {
          templateId: template.id,
          error: getErrorMessage(error)
        });
      }
    }

    if (debug) {
      log.debug("Rule generation completed", {
        success: result.success,
        rulesGenerated: result.rules.length,
        errors: result.errors.length
      });
    }

    return result;
  }

  /**
   * Generate a single rule from a template
   */
  async generateRule(
    template: RuleTemplate,
    context: TemplateContext,
    options: { overwrite?: boolean; dryRun?: boolean; debug?: boolean } = {}
  ): Promise<Rule> {
    const { overwrite = false, dryRun = false, debug = false } = options;

    try {
      // Generate content using template function
      const content = template.generateContent(context);
      
      // Generate metadata
      const baseMeta: RuleMeta = {
        name: template.name,
        description: template.description,
        globs: template.globs,
        alwaysApply: template.alwaysApply,
        tags: template.tags
      };
      
      // Apply custom metadata generation if provided
      const customMeta = template.generateMeta ? template.generateMeta(context) : {};
      const meta = { ...baseMeta, ...customMeta };

      if (debug) {
        log.debug("Generated template content", {
          templateId: template.id,
          contentLength: content.length,
          metaKeys: Object.keys(meta)
        });
      }

      // Create the rule
      if (dryRun) {
        // For dry run, return a mock rule without writing to filesystem
        return {
          id: template.id,
          ...meta,
          content,
          format: context.config.ruleFormat,
          path: this.getRulePath(template.id, context.config)
        };
      } else {
        // Actually create the rule file
        return await this.createRule(template.id, content, meta, {
          format: context.config.ruleFormat,
          overwrite
        });
      }
    } catch (error) {
      throw new Error(`Template generation failed for '${template.id}': ${getErrorMessage(error)}`);
    }
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  /**
   * Get output directory for rule format
   */
  private getOutputDir(format: RuleFormat): string {
    return format === "cursor" ? ".cursor/rules" : ".ai/rules";
  }

  /**
   * Get the path where a rule would be created
   */
  private getRulePath(ruleId: string, config: RuleGenerationConfig): string {
    const outputDir = config.outputDir || this.getOutputDir(config.ruleFormat);
    return `${outputDir}/${ruleId}.mdc`;
  }

  // ========================================================================
  // Configuration Presets
  // ========================================================================

  /**
   * Generate CLI-focused rules
   */
  async generateCliRules(options: Omit<GenerateRulesOptions, "config"> = {}): Promise<GenerateRulesResult> {
    return this.generateRules({
      ...options,
      config: { ...DEFAULT_CLI_CONFIG, ...options }
    });
  }

  /**
   * Generate MCP-focused rules
   */
  async generateMcpRules(options: Omit<GenerateRulesOptions, "config"> = {}): Promise<GenerateRulesResult> {
    return this.generateRules({
      ...options,
      config: { ...DEFAULT_MCP_CONFIG, ...options }
    });
  }

  /**
   * Generate hybrid rules (supports both CLI and MCP)
   */
  async generateHybridRules(options: Omit<GenerateRulesOptions, "config"> = {}): Promise<GenerateRulesResult> {
    return this.generateRules({
      ...options,
      config: { ...DEFAULT_HYBRID_CONFIG, ...options }
    });
  }

  // ========================================================================
  // Default Templates Registration
  // ========================================================================

  /**
   * Register default rule templates
   * This includes the templates that replace static content from init.ts
   */
  private registerDefaultTemplates(): void {
    // Register the test template for validation
    this.registerTemplate({
      id: "test-template",
      name: "Test Template",
      description: "A test template to validate the template system",
      tags: ["test"],
      generateContent: (context) => {
        const { helpers } = context;
        return `# Test Rule

This is a test rule generated by the template system.

## Example Command

${helpers.command("tasks.list", "list all available tasks")}

## Code Example

\`\`\`bash
${helpers.codeBlock("tasks.list")}
\`\`\`

## Workflow Step

${helpers.workflowStep("First", "tasks.list")}
`;
      }
    });

    log.debug("Default templates registration completed", {
      templateCount: this.templateRegistry.size
    });
  }

  /**
   * Register the default templates that replace init.ts static content
   */
  registerInitTemplates(): void {
    try {
      // Use require for synchronous loading
      const { registerDefaultTemplates } = require("./default-templates");
      registerDefaultTemplates(this);
      log.debug("Init templates registered successfully", {
        templateCount: this.templateRegistry.size
      });
    } catch (error) {
      log.error("Failed to register init templates", { error });
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a RuleTemplateService instance
 */
export function createRuleTemplateService(workspacePath: string): RuleTemplateService {
  return new RuleTemplateService(workspacePath);
}

/**
 * Generate rules with a specific configuration
 */
export async function generateRulesWithConfig(
  workspacePath: string,
  config: RuleGenerationConfig,
  options: Omit<GenerateRulesOptions, "config"> = {}
): Promise<GenerateRulesResult> {
  const service = createRuleTemplateService(workspacePath);
  return service.generateRules({ ...options, config });
} 
