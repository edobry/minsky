/**
 * Rule File Operations
 *
 * Operations for file handling, YAML processing, and format management.
 * Extracted from rules.ts as part of modularization effort.
 */
import { promises as fs } from "fs";
import { existsSync } from "fs";
import * as grayMatterNamespace from "gray-matter";
import { serializeYamlFrontmatter } from "../utils/yaml-frontmatter";
import { BaseRuleOperation, type RuleOperationDependencies } from "./base-rule-operation";
import { log } from "../../../utils/logger";
import { type Rule, type RuleMeta, type RuleFormat, type CreateRuleOptions } from "../types";

const matter = grayMatterNamespace.default || grayMatterNamespace;

/**
 * Read Rule File Operation
 */
export class ReadRuleFileOperation extends BaseRuleOperation<
  { id: string; format: RuleFormat; debug?: boolean },
  Rule
> {
  getOperationName(): string {
    return "read rule file";
  }

  async executeOperation(params: {
    id: string;
    format: RuleFormat;
    debug?: boolean;
  }): Promise<Rule> {
    const normalizedId = this.normalizeRuleId(params.id);
    const filePath = this.getRuleFilePath(normalizedId, params.format);

    if (params.debug) {
      this.logDebug("Reading rule file", { filePath, format: params.format });
    }

    // Check if file exists
    const fsp = this.deps.fsPromises || fs;
    await fsp.access(filePath);

    if (params.debug) {
      this.logDebug("File exists", { filePath });
    }

    // Read and parse the file
    const content = String(await (this.deps.fsPromises || fs).readFile(filePath, "utf-8"));

    try {
      // Parse frontmatter
      const { data, content: ruleContent } = matter(content);

      if (params.debug) {
        this.logDebug("Successfully parsed frontmatter", {
          filePath,
          dataKeys: Object.keys(data),
          contentLength: ruleContent.length,
        });
      }

      return {
        id: normalizedId,
        name: data.name,
        description: data.description,
        globs: data.globs,
        alwaysApply: data.alwaysApply,
        tags: data.tags,
        content: ruleContent.trim(),
        format: params.format,
        path: filePath,
      };
    } catch (error) {
      // Gracefully handle errors in frontmatter parsing
      if (params.debug) {
        this.logError(params, error);
      }

      // Extract content after the second '---' or use the whole content if no frontmatter markers
      let extractedContent = content;
      const frontmatterEndIndex = content.indexOf("---", 3);
      if (content.startsWith("---") && frontmatterEndIndex > 0) {
        extractedContent = content.substring(frontmatterEndIndex + 3).trim();
      }

      // Return a basic rule object with just the content
      return {
        id: normalizedId,
        content: extractedContent,
        format: params.format,
        path: filePath,
      };
    }
  }

  private logDebug(message: string, context: Record<string, unknown>): void {
    log.debug(`[DEBUG] ${message}`, context);
  }

  protected getAdditionalLogContext(params: {
    id: string;
    format: RuleFormat;
    debug?: boolean;
  }): Record<string, unknown> {
    return {
      ruleId: params.id,
      format: params.format,
    };
  }
}

/**
 * Write Rule File Operation
 */
export class WriteRuleFileOperation extends BaseRuleOperation<
  {
    id: string;
    content: string;
    meta: RuleMeta;
    options: CreateRuleOptions;
  },
  Rule
> {
  getOperationName(): string {
    return "write rule file";
  }

  async executeOperation(params: {
    id: string;
    content: string;
    meta: RuleMeta;
    options: CreateRuleOptions;
  }): Promise<Rule> {
    const format = params.options.format || "minsky";
    const dirPath = this.getRuleDirPath(format);
    const filePath = this.getRuleFilePath(params.id, format);

    // Ensure directory exists
    await (this.deps.fsPromises || fs).mkdir(dirPath, { recursive: true });

    // Check if rule already exists
    const existsSyncFn = this.deps.existsSyncFn || existsSync;
    if (existsSyncFn(filePath) && !params.options.overwrite) {
      throw new Error(`Rule already exists: ${params.id}. Use --overwrite to replace it.`);
    }

    // Clean up meta to remove undefined values that YAML can't handle
    const cleanMeta = this.cleanMetadata(params.meta);

    // Use custom stringify function
    const fileContent = serializeYamlFrontmatter(params.content, cleanMeta);

    // Write the file
    await (this.deps.fsPromises || fs).writeFile(filePath, fileContent, "utf-8");

    log.debug("Rule created/updated", {
      _path: filePath,
      id: params.id,
      format,
      globs: cleanMeta.globs,
    });

    // Return the created rule
    return {
      id: params.id,
      ...cleanMeta,
      content: params.content,
      format,
      path: filePath,
    };
  }

  protected getAdditionalLogContext(params: {
    id: string;
    content: string;
    meta: RuleMeta;
    options: CreateRuleOptions;
  }): Record<string, unknown> {
    return {
      ruleId: params.id,
      format: params.options.format || "minsky",
      hasContent: !!params.content,
      metaKeys: Object.keys(params.meta),
    };
  }
}

/**
 * List Rules Directory Operation
 */
export class ListRulesDirectoryOperation extends BaseRuleOperation<
  { format: RuleFormat; debug?: boolean },
  string[]
> {
  getOperationName(): string {
    return "list rules directory";
  }

  async executeOperation(params: { format: RuleFormat; debug?: boolean }): Promise<string[]> {
    const dirPath = this.getRuleDirPath(params.format);

    if (params.debug) {
      log.debug("Listing rules directory", { directory: dirPath, format: params.format });
    }

    try {
      const files = await (this.deps.fsPromises || fs).readdir(dirPath);
      return files.filter((file) => file.endsWith(".mdc"));
    } catch (error) {
      // Directory might not exist, which is fine
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  protected getAdditionalLogContext(params: {
    format: RuleFormat;
    debug?: boolean;
  }): Record<string, unknown> {
    return {
      format: params.format,
    };
  }
}

/**
 * Factory functions for creating file operations
 */
export const createReadRuleFileOperation = (deps: RuleOperationDependencies) =>
  new ReadRuleFileOperation(deps);

export const createWriteRuleFileOperation = (deps: RuleOperationDependencies) =>
  new WriteRuleFileOperation(deps);

export const createListRulesDirectoryOperation = (deps: RuleOperationDependencies) =>
  new ListRulesDirectoryOperation(deps);
