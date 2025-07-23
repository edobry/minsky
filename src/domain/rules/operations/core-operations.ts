/**
 * Core Rule Operations
 * 
 * Main rule operations (list, get, create, update, search).
 * Extracted from rules.ts as part of modularization effort.
 */
import { BaseRuleOperation, type RuleOperationDependencies } from "./base-rule-operation";
import { ReadRuleFileOperation, WriteRuleFileOperation, ListRulesDirectoryOperation } from "./file-operations";
import { type Rule, type RuleMeta, type RuleOptions, type CreateRuleOptions, type UpdateRuleOptions, type SearchRuleOptions } from "../types";

/**
 * List Rules Operation
 */
export class ListRulesOperation extends BaseRuleOperation<RuleOptions, Rule[]> {
  private readFileOp: ReadRuleFileOperation;
  private listDirOp: ListRulesDirectoryOperation;

  constructor(deps: RuleOperationDependencies) {
    super(deps);
    this.readFileOp = new ReadRuleFileOperation(deps);
    this.listDirOp = new ListRulesDirectoryOperation(deps);
  }

  getOperationName(): string {
    return "list rules";
  }

  async executeOperation(options: RuleOptions = {}): Promise<Rule[]> {
    const rules: Rule[] = [];
    const formats = this.getFormatsToSearch(options.format);

    for (const format of formats) {
      const files = await this.listDirOp.execute({ format, debug: options.debug });

      for (const file of files) {
        try {
          const rule = await this.readFileOp.execute({
            id: file.replace(/\\.mdc$/, ""),
            format,
            debug: options.debug,
          });

          // Filter by tag if specified
          if (options.tag && (!rule.tags || !rule.tags.includes(options.tag))) {
            continue;
          }

          if (rule) rules.push(rule);
        } catch (error) {
          // Log error but continue processing other files
          this.logError({ file }, error);
        }
      }
    }

    return rules;
  }
}

/**
 * Get Rule Operation
 */
export class GetRuleOperation extends BaseRuleOperation<{ id: string; options?: RuleOptions }, Rule> {
  private readFileOp: ReadRuleFileOperation;

  constructor(deps: RuleOperationDependencies) {
    super(deps);
    this.readFileOp = new ReadRuleFileOperation(deps);
  }

  getOperationName(): string {
    return "get rule";
  }

  async executeOperation({ id, options = {} }: { id: string; options?: RuleOptions }): Promise<Rule> {
    const bareId = this.normalizeRuleId(id);
    const formats = this.getFormatsToSearch(options.format);

    for (const format of formats) {
      try {
        const rule = await this.readFileOp.execute({
          id: bareId,
          format,
          debug: options.debug,
        });

        // If we found the rule in a different format, add a format note
        if (options.format && format !== options.format) {
          rule.formatNote = `Rule found in '${format}' format but '${options.format}' was requested.`;
        }

        return rule;
      } catch (error) {
        // Continue to try other formats
        continue;
      }
    }

    // Rule not found in any format
    const errorMessage = options.format 
      ? `Rule '${id}' not found in '${options.format}' format or any other available format`
      : `Rule not found: ${id}`;
    throw new Error(errorMessage);
  }
}

/**
 * Create Rule Operation
 */
export class CreateRuleOperation extends BaseRuleOperation<{
  id: string;
  content: string;
  meta: RuleMeta;
  options?: CreateRuleOptions;
}, Rule> {
  private writeFileOp: WriteRuleFileOperation;

  constructor(deps: RuleOperationDependencies) {
    super(deps);
    this.writeFileOp = new WriteRuleFileOperation(deps);
  }

  getOperationName(): string {
    return "create rule";
  }

  async executeOperation({
    id,
    content,
    meta,
    options = {},
  }: {
    id: string;
    content: string;
    meta: RuleMeta;
    options?: CreateRuleOptions;
  }): Promise<Rule> {
    return await this.writeFileOp.execute({ id, content, meta, options });
  }
}

/**
 * Update Rule Operation
 */
export class UpdateRuleOperation extends BaseRuleOperation<{
  id: string;
  options: UpdateRuleOptions;
  ruleOptions?: RuleOptions;
}, Rule> {
  private getRuleOp: GetRuleOperation;
  private writeFileOp: WriteRuleFileOperation;

  constructor(deps: RuleOperationDependencies) {
    super(deps);
    this.getRuleOp = new GetRuleOperation(deps);
    this.writeFileOp = new WriteRuleFileOperation(deps);
  }

  getOperationName(): string {
    return "update rule";
  }

  async executeOperation({
    id,
    options,
    ruleOptions = {},
  }: {
    id: string;
    options: UpdateRuleOptions;
    ruleOptions?: RuleOptions;
  }): Promise<Rule> {
    const rule = await this.getRuleOp.execute({ id, options: ruleOptions });

    // No changes needed
    if (!options.content && !options.meta) {
      return rule;
    }

    // Prepare updated meta
    const currentRuleMeta: Partial<RuleMeta> = {
      name: rule.name,
      description: rule.description,
      globs: rule.globs,
      alwaysApply: rule.alwaysApply,
      tags: rule.tags,
    };

    // Merge current rule meta with updates
    const mergedMeta = { ...currentRuleMeta, ...options.meta };
    const metaForFrontmatter = this.cleanMetadata(mergedMeta as RuleMeta);

    // Content to use
    const updatedContent = options.content || rule.content;

    // Write the updated rule
    await this.writeFileOp.execute({
      id,
      content: updatedContent,
      meta: metaForFrontmatter,
      options: { format: rule.format, overwrite: true },
    });

    // Re-fetch to get updated rule
    return await this.getRuleOp.execute({ id, options: { format: rule.format, debug: ruleOptions.debug } });
  }
}

/**
 * Search Rules Operation
 */
export class SearchRulesOperation extends BaseRuleOperation<SearchRuleOptions, Rule[]> {
  private listRulesOp: ListRulesOperation;

  constructor(deps: RuleOperationDependencies) {
    super(deps);
    this.listRulesOp = new ListRulesOperation(deps);
  }

  getOperationName(): string {
    return "search rules";
  }

  async executeOperation(options: SearchRuleOptions = {}): Promise<Rule[]> {
    // Get all rules first (with format filtering if specified)
    const rules = await this.listRulesOp.execute({
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

/**
 * Factory functions for creating core operations
 */
export const createListRulesOperation = (deps: RuleOperationDependencies) =>
  new ListRulesOperation(deps);

export const createGetRuleOperation = (deps: RuleOperationDependencies) =>
  new GetRuleOperation(deps);

export const createCreateRuleOperation = (deps: RuleOperationDependencies) =>
  new CreateRuleOperation(deps);

export const createUpdateRuleOperation = (deps: RuleOperationDependencies) =>
  new UpdateRuleOperation(deps);

export const createSearchRulesOperation = (deps: RuleOperationDependencies) =>
  new SearchRulesOperation(deps);