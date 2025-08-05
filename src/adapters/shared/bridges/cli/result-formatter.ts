/**
 * CLI Result Formatter
 *
 * Handles output formatting for different command types and results.
 * Extracted from cli-bridge.ts as part of modularization effort.
 */
import { log } from "../../../../utils/logger";
import { type SharedCommand } from "../../command-registry";
import {
  formatSessionDetails,
  formatSessionSummary,
  formatSessionPrDetails,
  formatSessionApprovalDetails,
  formatDebugEchoDetails,
  formatRuleDetails,
  formatRuleSummary,
} from "../cli-result-formatters";

/**
 * Interface for command result formatters
 */
export interface CommandResultFormatter {
  /**
   * Get a default formatter for command results
   */
  getDefaultFormatter(commandDef: SharedCommand): (result: any) => void;

  /**
   * Format array results
   */
  formatArrayResult(result: any[], commandDef: SharedCommand): void;

  /**
   * Format object results
   */
  formatObjectResult(result: any, commandDef: SharedCommand): void;

  /**
   * Format primitive results (string, number, boolean)
   */
  formatPrimitiveResult(result: any): void;
}

/**
 * Default implementation of command result formatter
 */
export class DefaultCommandResultFormatter implements CommandResultFormatter {
  /**
   * Get a default formatter for command results
   */
  getDefaultFormatter(commandDef: SharedCommand): (result: any) => void {
    return (result: any) => {
      if (Array.isArray(result)) {
        this.formatArrayResult(result, commandDef);
      } else if (typeof result === "object" && result !== null) {
        this.formatObjectResult(result, commandDef);
      } else {
        this.formatPrimitiveResult(result);
      }
    };
  }

  /**
   * Format array results
   */
  formatArrayResult(result: any[], commandDef: SharedCommand): void {
    if (result.length === 0) {
      log.cli("No results found.");
      return;
    }

    result.forEach((item, index) => {
      if (typeof item === "object" && item !== null) {
        // For objects in arrays, try to display meaningful information
        if (item.id && item.title) {
          // Looks like a task or similar entity
          log.cli(`- ${item.id}: ${item.title}${item.status ? ` [${item.status}]` : ""}`);
        } else {
          // Generic object display
          log.cli(`${index + 1}. ${JSON.stringify(item)}`);
        }
      } else {
        log.cli(`${index + 1}. ${item}`);
      }
    });
  }

  /**
   * Format object results based on command type
   */
  formatObjectResult(result: any, commandDef: SharedCommand): void {
    // Handle specific command types with custom formatters
    switch (commandDef.id) {
      case "session.get":
        if ("session" in result) {
          formatSessionDetails(result.session as Record<string, any>);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "session.dir":
        if ("directory" in result) {
          log.cli(`${result.directory}`);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "session.list":
        if ("sessions" in result) {
          this.formatSessionListResult(result.sessions);
        } else {
          this.formatGenericObject(result);
        }
        break;

      // Updated to handle PR subcommands
      case "session.pr.create":
        if ("prBranch" in result) {
          formatSessionPrDetails(result);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "session.pr.list":
        // List command handles its own formatting in the command class
        this.formatGenericObject(result);
        break;

      case "session.pr.get":
        // Get command handles its own formatting in the command class
        this.formatGenericObject(result);
        break;

      case "session.approve":
        if (result.result && "session" in result.result) {
          formatSessionApprovalDetails(result.result);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "rules.list":
        if ("rules" in result) {
          this.formatRulesListResult(result.rules);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "rules.get":
        if ("content" in result || "id" in result) {
          formatRuleDetails(result);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "rules.search":
        if ("rules" in result) {
          this.formatRulesListResult(result.rules);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "debug.echo":
        formatDebugEchoDetails(result);
        break;

      default:
        this.formatGenericObject(result);
        break;
    }
  }

  /**
   * Format session list results
   */
  private formatSessionListResult(sessions: any[]): void {
    if (Array.isArray(sessions) && sessions.length > 0) {
      sessions.forEach((session: any) => {
        formatSessionSummary(session as Record<string, any>);
      });
    } else {
      log.cli("No sessions found.");
    }
  }

  /**
   * Format rules list results
   */
  private formatRulesListResult(rules: any[]): void {
    if (Array.isArray(rules) && rules.length > 0) {
      rules.forEach((rule: any) => {
        formatRuleSummary(rule);
      });
    } else {
      log.cli("No rules found.");
    }
  }

  /**
   * Format generic object (fallback)
   */
  private formatGenericObject(result: any): void {
    // Try to find meaningful fields to display
    if (result.message) {
      log.cli(result.message);
    } else if (result.success !== undefined) {
      log.cli(result.success ? "✅ Success" : "❌ Failed");

      // Handle single error
      if (result.error) {
        log.cli(`Error: ${result.error}`);
      }

      // Handle error array (e.g., from rules generate command)
      if (result.errors && Array.isArray(result.errors) && result.errors.length > 0) {
        log.cli("Errors:");
        result.errors.forEach((error: any, index: number) => {
          const errorMsg =
            typeof error === "string" ? error : error.message || JSON.stringify(error);
          log.cli(`  ${index + 1}. ${errorMsg}`);
        });
      }
    } else {
      // Fall back to JSON representation
      log.cli(JSON.stringify(result, null, 2));
    }
  }

  /**
   * Format primitive results (string, number, boolean)
   */
  formatPrimitiveResult(result: any): void {
    if (typeof result === "boolean") {
      log.cli(result ? "✅ Success" : "❌ Failed");
    } else if (result === null || result === undefined) {
      log.cli("No result");
    } else {
      log.cli(String(result));
    }
  }
}

/**
 * Enhanced formatter with additional features
 */
export class EnhancedCommandResultFormatter extends DefaultCommandResultFormatter {
  /**
   * Format array results with enhanced display options
   */
  formatArrayResult(result: any[], commandDef: SharedCommand): void {
    if (result.length === 0) {
      log.cli("No results found.");
      return;
    }

    // Add count information for large arrays
    if (result.length > 10) {
      log.cli(`Found ${result.length} results (showing all):`);
    }

    // Use table format for structured data if all items have same keys
    if (this.canUseTableFormat(result)) {
      this.formatAsTable(result);
    } else {
      super.formatArrayResult(result, commandDef);
    }
  }

  /**
   * Check if array can be formatted as a table
   */
  private canUseTableFormat(result: any[]): boolean {
    if (result.length === 0) return false;

    const firstItem = result[0];
    if (typeof firstItem !== "object" || firstItem === null) return false;

    const firstKeys = Object.keys(firstItem).sort();

    // Check if all items have the same keys
    return result.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const itemKeys = Object.keys(item).sort();
      return (
        firstKeys.length === itemKeys.length &&
        firstKeys.every((key, index) => key === itemKeys[index])
      );
    });
  }

  /**
   * Format array as a simple table
   */
  private formatAsTable(result: any[]): void {
    if (result.length === 0) return;

    const keys = Object.keys(result[0]);

    // Print header
    log.cli(keys.join("\t"));
    log.cli(keys.map(() => "---").join("\t"));

    // Print rows
    result.forEach((item) => {
      const values = keys.map((key) => {
        const value = item[key];
        if (value === null || value === undefined) return "";
        return String(value);
      });
      log.cli(values.join("\t"));
    });
  }
}

/**
 * Default instance for result formatting
 */
export const defaultResultFormatter = new DefaultCommandResultFormatter();

/**
 * Enhanced instance for result formatting
 */
export const enhancedResultFormatter = new EnhancedCommandResultFormatter();
