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
  formatSessionListVerbose,
} from "../cli-result-formatters";

/**
 * Interface for command result formatters
 */
export interface CommandResultFormatter {
  /**
   * Get a default formatter for command results
   */
  getDefaultFormatter(commandDef: SharedCommand): (result: unknown) => void;

  /**
   * Format array results
   */
  formatArrayResult(result: unknown[], commandDef: SharedCommand): void;

  /**
   * Format object results
   */
  formatObjectResult(result: Record<string, unknown>, commandDef: SharedCommand): void;

  /**
   * Format primitive results (string, number, boolean)
   */
  formatPrimitiveResult(result: unknown): void;
}

/**
 * Default implementation of command result formatter
 */
export class DefaultCommandResultFormatter implements CommandResultFormatter {
  /**
   * Get a default formatter for command results
   */
  getDefaultFormatter(commandDef: SharedCommand): (result: unknown) => void {
    return (result: unknown) => {
      if (Array.isArray(result)) {
        this.formatArrayResult(result, commandDef);
      } else if (typeof result === "object" && result !== null) {
        this.formatObjectResult(result as Record<string, unknown>, commandDef);
      } else {
        this.formatPrimitiveResult(result);
      }
    };
  }

  /**
   * Format array results
   */
  formatArrayResult(result: unknown[], commandDef: SharedCommand): void {
    if (result.length === 0) {
      log.cli("No results found.");
      return;
    }

    result.forEach((item, index) => {
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        // For objects in arrays, try to display meaningful information
        if (obj.id && obj.title) {
          // Looks like a task or similar entity
          log.cli(`- ${obj.id}: ${obj.title}${obj.status ? ` [${obj.status}]` : ""}`);
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
  formatObjectResult(result: Record<string, unknown>, commandDef: SharedCommand): void {
    // Handle specific command types with custom formatters
    switch (commandDef.id) {
      case "session.get":
        if ("session" in result) {
          formatSessionDetails(result.session as Record<string, unknown>);
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
          if (result.verbose) {
            formatSessionListVerbose(result.sessions as unknown[]);
          } else {
            this.formatSessionListResult(result.sessions as unknown[]);
          }
        } else {
          this.formatGenericObject(result);
        }
        break;

      // Updated to handle PR subcommands
      case "session.pr.create":
        if ("prBranch" in result) {
          formatSessionPrDetails(result as Record<string, unknown>);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "session.pr.list":
        // Render table output when provided by command implementation
        if (
          result &&
          typeof result === "object" &&
          "table" in result &&
          result.table &&
          typeof result.table === "object" &&
          Array.isArray((result.table as Record<string, unknown>).headers) &&
          Array.isArray((result.table as Record<string, unknown>).rows)
        ) {
          const { headers, rows } = result.table as {
            headers: string[];
            rows: string[][];
          };
          this.formatTableResult(headers, rows);

          if (typeof result.count === "number") {
            const count = result.count as number;
            log.cli("");
            log.cli(`${count} pull request${count === 1 ? "" : "s"} found`);
          }
        } else if (result?.message) {
          // Prefer explicit message when provided (e.g., empty results)
          log.cli(result.message);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "session.pr.get":
        // Get command handles its own formatting in the command class
        this.formatGenericObject(result);
        break;

      case "session.approve":
        if (result.result && "session" in (result.result as object)) {
          formatSessionApprovalDetails(result.result as Record<string, unknown>);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "rules.list":
        if ("rules" in result) {
          this.formatRulesListResult(result.rules as unknown[]);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "rules.get":
        if ("content" in result || "id" in result) {
          formatRuleDetails(result as Record<string, unknown>);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "rules.search":
        // Now uses same format as tasks.search (results array)
        if (result && typeof result === "object" && Array.isArray(result.results)) {
          const results = result.results as Array<{
            id: string;
            score?: number;
            name?: string;
            description?: string;
            format?: string;
          }>;
          if (results.length === 0) {
            log.cli("No rules found.");
          } else {
            // Visual separator after any header emitted by the command implementation
            log.cli("");
            results.forEach((rule, index) => {
              const name = rule.name || rule.id;
              const fmt = rule.format ? ` [${rule.format}]` : "";
              const desc = rule.description ? ` - ${rule.description}` : "";
              // Show score in --details mode if available
              const scorePart =
                rule.score !== undefined && this.shouldShowDetails(result)
                  ? `\nScore: ${rule.score.toFixed(3)}`
                  : "";
              log.cli(`${index + 1}. ${name}${fmt}${desc}${scorePart}`);
            });
            // Footer separator before count
            log.cli("");
            if (typeof result.count === "number") {
              const count = result.count as number;
              log.cli(`${count} result${count === 1 ? "" : "s"} found`);
            } else {
              log.cli(`${results.length} result${results.length === 1 ? "" : "s"} found`);
            }
          }
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "tasks.search":
      case "tasks.similar":
        if (result && typeof result === "object" && Array.isArray(result.results)) {
          const results = result.results as Array<{
            id: string;
            score?: number;
            title?: string;
            status?: string;
          }>;
          if (results.length === 0) {
            log.cli("No results found.");
          } else {
            // Visual separator after any header emitted by the command implementation
            log.cli("");
            results.forEach((r, index) => {
              const title = r.title ? r.title : r.id;
              const idPart = r.title ? ` [${r.id}]` : "";
              const statusPart = r.status ? ` [${r.status}]` : "";
              // Show score in --details mode if available
              const scorePart =
                r.score !== undefined && this.shouldShowDetails(result)
                  ? `\nScore: ${r.score.toFixed(3)}`
                  : "";
              log.cli(`${index + 1}. ${title}${idPart}${statusPart}${scorePart}`);
            });
            // Footer separator before count
            log.cli("");
            if (typeof result.count === "number") {
              const count = result.count as number;
              log.cli(`${count} result${count === 1 ? "" : "s"} found`);
            }
          }
        } else if (result?.message) {
          log.cli(result.message);
        } else {
          this.formatGenericObject(result);
        }
        break;

      case "debug.echo":
        formatDebugEchoDetails(result as Record<string, unknown>);
        break;

      case "session.commit": {
        const shortHash = (
          result.shortHash
            ? String(result.shortHash)
            : result.commitHash
              ? String(result.commitHash).slice(0, 7)
              : ""
        ).trim();
        const subject = String(result.subject || result.message || "");
        const branch = String(result.branch || "");
        const filesChanged = Number.isFinite(result.filesChanged)
          ? (result.filesChanged as number)
          : 0;
        const insertions = Number.isFinite(result.insertions) ? (result.insertions as number) : 0;
        const deletions = Number.isFinite(result.deletions) ? (result.deletions as number) : 0;

        if (result.oneline) {
          log.cli(
            `${shortHash} ${subject} | ${branch} | ${filesChanged} files, +${insertions} -${deletions}`
          );
        } else {
          const quotedSubject = subject ? `"${subject}"` : "";
          log.cli(`Committed ${shortHash} ${quotedSubject} to branch ${branch}`);
          if (result.authorName || result.authorEmail || result.timestamp) {
            const author = `${result.authorName || ""}${result.authorEmail ? ` <${result.authorEmail}>` : ""}`;
            const when = result.timestamp ? ` at ${result.timestamp}` : "";
            log.cli(`Author: ${author}${when}`);
          }
          log.cli(
            `${filesChanged} files changed, ${insertions} insertions(+), ${deletions} deletions(-)`
          );

          if (!result.noFiles && Array.isArray(result.files) && result.files.length > 0) {
            (result.files as unknown[]).forEach((f) => {
              const file = f as Record<string, unknown>;
              if (file && file.status && file.path) {
                log.cli(`${file.status} ${file.path}`);
              }
            });
          }
        }
        break;
      }

      default:
        this.formatGenericObject(result);
        break;
    }
  }

  /**
   * Format session list results
   */
  private formatSessionListResult(sessions: unknown[]): void {
    if (Array.isArray(sessions) && sessions.length > 0) {
      sessions.forEach((session) => {
        formatSessionSummary(session as Record<string, unknown>);
      });
    } else {
      log.cli("No sessions found.");
    }
  }

  /**
   * Check if details should be shown (scores, diagnostics, etc.)
   */
  private shouldShowDetails(result: Record<string, unknown>): boolean {
    // Check if details flag was passed to the command
    return Boolean(result?.showDetails || result?.details);
  }

  /**
   * Format rules list results
   */
  private formatRulesListResult(rules: unknown[]): void {
    if (!Array.isArray(rules) || rules.length === 0) {
      log.cli("No rules found.");
      return;
    }

    // Align with tasks.search style: numbered items and trailing count
    // Visual separator after any header emitted by the command implementation
    log.cli("");
    rules.forEach((rule, index: number) => {
      const r = rule as Record<string, unknown>;
      const ruleId = r.id || "unknown";
      const fmt = r.format ? ` [${r.format}]` : "";
      const desc = r.description ? ` - ${r.description}` : "";
      log.cli(`${index + 1}. ${ruleId}${fmt}${desc}`);
    });
    // Footer separator before count
    log.cli("");
    log.cli(`${rules.length} result${rules.length === 1 ? "" : "s"} found`);
  }

  /**
   * Format generic object (fallback)
   */
  private formatGenericObject(result: Record<string, unknown>): void {
    // Try to find meaningful fields to display
    if (result.printed) {
      // Command already printed a verbose report; avoid redundant summary
      return;
    }
    if (result.message) {
      // Prefer explicit message if present
      log.cli(result.message);
      return;
    } else if (result.success !== undefined) {
      // Check for formatted output first before using generic success message
      if (result.output) {
        log.cli(result.output);
      } else {
        log.cli(result.success ? "✅ Success" : "❌ Failed");
      }

      // Handle single error
      if (result.error) {
        log.cli(`Error: ${result.error}`);
      }

      // Handle error array (e.g., from rules generate command)
      if (result.errors && Array.isArray(result.errors) && result.errors.length > 0) {
        log.cli("Errors:");
        (result.errors as unknown[]).forEach((error: unknown, index: number) => {
          const errorMsg =
            typeof error === "string"
              ? error
              : (error as Record<string, unknown>).message
                ? String((error as Record<string, unknown>).message)
                : JSON.stringify(error);
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
  formatPrimitiveResult(result: unknown): void {
    if (typeof result === "boolean") {
      log.cli(result ? "✅ Success" : "❌ Failed");
    } else if (result === null || result === undefined) {
      log.cli("No result");
    } else {
      // Print primitive values (string, number, bigint, symbol)
      log.cli(String(result));
    }
  }

  /**
   * Format a simple table given headers and rows
   */
  private formatTableResult(headers: string[], rows: string[][]): void {
    // Calculate column widths
    const colCount = headers.length;
    const widths = headers.map((h, i) => {
      const maxRowWidth = rows.reduce((max, row) => {
        const cell = (row[i] ?? "").toString();
        return Math.max(max, cell.length);
      }, 0);
      return Math.max(h.length, maxRowWidth);
    });

    const pad = (text: string, width: number) => text.padEnd(width, " ");

    // Print header
    log.cli(headers.map((h, i) => pad(h, widths[i] ?? 0)).join("  "));
    // Print separator
    log.cli(widths.map((w) => "-".repeat(w)).join("  "));

    // Print rows
    rows.forEach((row) => {
      const cells = Array.from({ length: colCount }, (_, i) =>
        pad((row[i] ?? "").toString(), widths[i] ?? 0)
      );
      log.cli(cells.join("  "));
    });
  }
}

/**
 * Enhanced formatter with additional features
 */
export class EnhancedCommandResultFormatter extends DefaultCommandResultFormatter {
  /**
   * Format array results with enhanced display options
   */
  formatArrayResult(result: unknown[], commandDef: SharedCommand): void {
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
  private canUseTableFormat(result: unknown[]): boolean {
    if (result.length === 0) return false;

    const firstItem = result[0];
    if (typeof firstItem !== "object" || firstItem === null) return false;

    const firstKeys = Object.keys(firstItem as object).sort();

    // Check if all items have the same keys
    return result.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const itemKeys = Object.keys(item as object).sort();
      return (
        firstKeys.length === itemKeys.length &&
        firstKeys.every((key, index) => key === itemKeys[index])
      );
    });
  }

  /**
   * Format array as a simple table
   */
  private formatAsTable(result: unknown[]): void {
    if (result.length === 0) return;

    const keys = Object.keys(result[0] as object);

    // Print header
    log.cli(keys.join("\t"));
    log.cli(keys.map(() => "---").join("\t"));

    // Print rows
    result.forEach((item) => {
      const obj = item as Record<string, unknown>;
      const values = keys.map((key) => {
        const value = obj[key];
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
