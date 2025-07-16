/**
 * Response Formatting Utilities
 *
 * This module provides utilities for formatting command responses
 * consistently across different interfaces (CLI, MCP).
 */

import type { CommandExecutionContext } from "./command-registry";
import chalk from "chalk";

/**
 * Supported output formats
 */
export enum OutputFormat {
  /** Human-readable text output */
  TEXT = "text",
  /** JSON output for machine consumption */
  JSON = "json",
}

/**
 * Base interface for response formatters
 */
export interface ResponseFormatter<T = any> {
  /**
   * Format a response for output
   *
   * @param data Response data to format
   * @param context Command execution context
   * @returns Formatted response
   */
  format(data: T, context: CommandExecutionContext): string | object;
}

/**
 * Format a command response as JSON
 *
 * @param data Response data
 * @returns JSON formatted string
 */
export function formatAsJson(data: any): string {
  return JSON.stringify(data, undefined, 2);
}

/**
 * Base class for response formatters that support multiple output formats
 */
export abstract class BaseResponseFormatter<T = any> implements ResponseFormatter<T> {
  /**
   * Format a response based on the requested format
   *
   * @param data Response data
   * @param context Command execution context
   * @returns Formatted response
   */
  format(data: T, context: CommandExecutionContext): string | object {
    // Determine the output format
    const format = context.format.toLowerCase() as OutputFormat;

    // Format the response based on the requested format
    if (format === OutputFormat.JSON) {
      return this.formatJson(data, context);
    }

    // Default to text format
    return this.formatText(data, context);
  }

  /**
   * Format the response as text
   *
   * @param data Response data
   * @param context Command execution context
   * @returns Text formatted string
   */
  abstract formatText(data: T, context: CommandExecutionContext): string;

  /**
   * Format the response as JSON
   *
   * @param data Response data
   * @param context Command execution context
   * @returns JSON-serializable object
   */
  formatJson(data: T, context: CommandExecutionContext): object {
    return data as unknown as object;
  }
}

/**
 * Format a simple success response
 */
export class SuccessFormatter extends BaseResponseFormatter<string> {
  /**
   * Format a success message as text
   *
   * @param message Success message
   * @returns Formatted success message
   */
  formatText(message: string): string {
    return `${chalk.green("✓")} ${message}`;
  }

  /**
   * Format a success message as JSON
   *
   * @param message Success message
   * @returns JSON object with success flag and message
   */
  formatJson(message: string): object {
    return {
      success: true,
      message,
    };
  }
}

/**
 * Format a simple error response
 */
export class ErrorFormatter extends BaseResponseFormatter<Error> {
  /**
   * Format an error as text
   *
   * @param error Error object
   * @param context Command execution context
   * @returns Formatted error message
   */
  formatText(error: Error, context: CommandExecutionContext): string {
    let output = `${chalk.red("✗")} Error: ${(error as any).message}`;

    // Add stack trace in debug mode
    if ((context as any).debug && (error as any).stack) {
      output += `\n\n${(error as any).stack}`;
    }

    return output;
  }

  /**
   * Format an error as JSON
   *
   * @param error Error object
   * @param context Command execution context
   * @returns JSON object with error details
   */
  formatJson(error: Error, context: CommandExecutionContext): object {
    const result = {
      success: false,
      error: (error as any).message as any,
    } as any;

    // Add stack trace in debug mode
    if ((context as any).debug && (error as any).stack) {
      (result as any).stack = (error as any).stack as any;
    }

    return result;
  }
}

/**
 * Format a list of items
 */
export class ListFormatter<T = any> extends BaseResponseFormatter<T[]> {
  constructor(
    private itemFormatter?: (item: any) => string,
    private title?: string
  ) {
    super();
  }

  /**
   * Format a list as text
   *
   * @param items List of items
   * @returns Formatted list
   */
  formatText(items: T[]): string {
    if (items.length === 0) {
      return "No items found.";
    }

    let output = "";

    // Add title if provided
    if (this.title) {
      output += `${chalk.bold(this.title)}\n\n`;
    }

    // Format each item
    if (this.itemFormatter) {
      items.forEach((item, index) => {
        output += `${index + 1}. ${this.itemFormatter!(item)}\n`;
      });
    } else {
      items.forEach((item, index) => {
        output += `${index + 1}. ${String(item)}\n`;
      });
    }

    return output;
  }

  /**
   * Format a list as JSON
   *
   * @param items List of items
   * @returns JSON object with items array
   */
  formatJson(items: T[]): object {
    return {
      items,
      count: items.length,
    };
  }
}

/**
 * Format a table of data
 */
export class TableFormatter<T extends Record<string, any>> extends BaseResponseFormatter<T[]> {
  constructor(
    private columns: Array<keyof T>,
    private headers: Record<keyof T, string>,
    private title?: string
  ) {
    super();
  }

  /**
   * Format a table as text
   *
   * @param rows Table data rows
   * @returns Formatted table
   */
  formatText(rows: T[]): string {
    if (rows.length === 0) {
      return "No data found.";
    }

    let output = "";

    // Add title if provided
    if (this.title) {
      output += `${chalk.bold(this.title)}\n\n`;
    }

    // Calculate column widths
    const columnWidths: Record<keyof T, number> = {} as Record<keyof T, number>;

    // Initialize with header lengths
    this.columns.forEach((col) => {
      columnWidths[col] = String(this.headers[col] || col).length;
    });

    // Update with maximum data lengths
    rows.forEach((row) => {
      this.columns.forEach((col) => {
        const value = String(row[col] || "");
        columnWidths[col] = Math.max(columnWidths[col], value.length);
      });
    });

    // Create header row
    const headerRow = this.columns
      .map((col) => {
        const header = String(this.headers[col] || col);
        return header.padEnd(columnWidths[col]);
      })
      .join(" | ");

    output += `${chalk.bold(headerRow)}\n`;

    // Create separator row
    const separatorRow = this.columns
      .map((col) => {
        return "-".repeat(columnWidths[col]);
      })
      .join("-|-");

    output += `${separatorRow}\n`;

    // Create data rows
    rows.forEach((row) => {
      const dataRow = this.columns
        .map((col) => {
          const value = String(row[col] || "");
          return value.padEnd(columnWidths[col]);
        })
        .join(" | ") as unknown;

      output += `${dataRow}\n`;
    });

    return output;
  }

  /**
   * Format a table as JSON
   *
   * @param rows Table data rows
   * @returns JSON object with rows array
   */
  formatJson(rows: T[]): object {
    return {
      rows,
      count: rows.length,
    };
  }
}

/**
 * Create a success formatter
 *
 * @returns A new success formatter
 */
export function createSuccessFormatter(): SuccessFormatter {
  return new SuccessFormatter();
}

/**
 * Create an error formatter
 *
 * @returns A new error formatter
 */
export function createErrorFormatter(): ErrorFormatter {
  return new ErrorFormatter();
}

/**
 * Create a list formatter
 *
 * @param itemFormatter Optional function to format individual items
 * @param title Optional title for the list
 * @returns A new list formatter
 */
export function createListFormatter<T>(
  itemFormatter?: (item: any) => string,
  title?: string
): ListFormatter<T> {
  return new ListFormatter<T>(itemFormatter, title);
}

/**
 * Create a table formatter
 *
 * @param columns Columns to include in the table
 * @param headers Column headers
 * @param title Optional title for the table
 * @returns A new table formatter
 */
export function createTableFormatter<T extends Record<string, any>>(
  columns: Array<keyof T>,
  headers: Record<keyof T, string>,
  title?: string
): TableFormatter<T> {
  return new TableFormatter<T>(columns, headers, title);
}
