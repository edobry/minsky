/**
 * CLI Result Formatter
 *
 * Handles output formatting for different command types and results.
 * Extracted from cli-bridge.ts as part of modularization effort.
 */
import { log } from "@minsky/shared/logger";
import { type SharedCommand } from "../../command-registry";
import {
  formatSessionDetails,
  formatSessionSummary,
  formatSessionPrDetails,
  formatDebugEchoDetails,
  formatRuleDetails,
  formatSessionListVerbose,
} from "../cli-result-formatters";

/**
 * Command ids that `formatObjectResult`'s switch renders itself, so they never
 * reach the generic fallback with their primary shape.
 *
 * Exported so the CLI output-coverage audit (`scripts/audit-cli-output-coverage.ts`)
 * can subtract them from the registry without re-deriving the switch by hand;
 * `result-formatter.test.ts` asserts the list and the switch agree.
 */
export const SWITCH_HANDLED_COMMAND_IDS: readonly string[] = [
  "session.get",
  "session.dir",
  "session.list",
  "session.pr.create",
  "session.pr.list",
  "session.pr.get",
  "rules.list",
  "rules.get",
  "rules.search",
  "tasks.search",
  "tasks.similar",
  "debug.echo",
  "session.commit",
];

/**
 * Result keys the generic fallback never renders as payload data. Each is
 * either consumed by a dedicated branch (`success`, `error`, `errors`,
 * `message`, `output`), a directive to the formatter itself (`printed`), or CLI
 * plumbing the command echoes back rather than a finding the operator asked for
 * (`json`, `debug`). Echoing plumbing back was half of what made mt#3478's
 * `--verbose` look implemented when nothing read it.
 */
const NON_PAYLOAD_KEYS = new Set([
  "success",
  "printed",
  "message",
  "output",
  "error",
  "errors",
  "json",
  "debug",
]);

/** Longest single-line rendering of a structured value before it is broken across lines. */
const INLINE_VALUE_MAX_LENGTH = 80;

/**
 * Render one payload value. Scalars print bare; structured values print as JSON
 * — compact when short enough to read on the key's own line, indented block
 * form when not.
 */
function formatPayloadValue(key: string, value: unknown): string {
  if (value === null || typeof value !== "object") {
    return `${key}: ${String(value)}`;
  }
  const compact = JSON.stringify(value);
  if (compact !== undefined && compact.length <= INLINE_VALUE_MAX_LENGTH) {
    return `${key}: ${compact}`;
  }
  const pretty = JSON.stringify(value, null, 2) ?? String(value);
  return `${key}:\n${pretty
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}`;
}

/**
 * Lines rendering every payload key the fallback's other branches do not
 * already account for. Empty when the result carries nothing beyond its status
 * — a bare `{ success: true }` correctly renders as just the success line.
 */
export function formatPayloadKeys(result: Record<string, unknown>): string[] {
  return Object.entries(result)
    .filter(([key, value]) => !NON_PAYLOAD_KEYS.has(key) && value !== undefined)
    .map(([key, value]) => formatPayloadValue(key, value));
}

/**
 * What the bridge observed while the command ran, for branches whose right
 * answer depends on it rather than on the result alone.
 */
export interface ResultRenderOptions {
  /**
   * Whether the command emitted CLI output of its own during `execute`.
   *
   * When it did, the generic fallback must not also render the payload's keys:
   * a command that already printed a report would print its findings twice. The
   * bridge derives this from the visible-CLI-output line counter (`log.cli`,
   * `cliWarn`, `cliError`) rather than from the result, because most
   * self-printing commands set no `printed` flag.
   */
  commandEmittedOutput?: boolean;
}

/**
 * Interface for command result formatters
 */
export interface CommandResultFormatter {
  /**
   * Get a default formatter for command results
   */
  getDefaultFormatter(
    commandDef: SharedCommand,
    options?: ResultRenderOptions
  ): (result: unknown) => void;

  /**
   * Format array results
   */
  formatArrayResult(result: unknown[], commandDef: SharedCommand): void;

  /**
   * Format object results
   */
  formatObjectResult(
    result: Record<string, unknown>,
    commandDef: SharedCommand,
    options?: ResultRenderOptions
  ): void;

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
  getDefaultFormatter(
    commandDef: SharedCommand,
    options?: ResultRenderOptions
  ): (result: unknown) => void {
    return (result: unknown) => {
      if (Array.isArray(result)) {
        this.formatArrayResult(result, commandDef);
      } else if (typeof result === "object" && result !== null) {
        this.formatObjectResult(result as Record<string, unknown>, commandDef, options);
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
  formatObjectResult(
    result: Record<string, unknown>,
    commandDef: SharedCommand,
    options?: ResultRenderOptions
  ): void {
    // Handle specific command types with custom formatters
    switch (commandDef.id) {
      case "session.get":
        if ("session" in result) {
          formatSessionDetails(result.session as Record<string, unknown>);
        } else {
          this.formatGenericObject(result, options);
        }
        break;

      case "session.dir":
        if ("directory" in result) {
          log.cli(`${result.directory}`);
        } else {
          this.formatGenericObject(result, options);
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
          this.formatGenericObject(result, options);
        }
        break;

      // Updated to handle PR subcommands
      case "session.pr.create":
        if ("prBranch" in result) {
          formatSessionPrDetails(result as Record<string, unknown>);
        } else {
          this.formatGenericObject(result, options);
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
          this.formatGenericObject(result, options);
        }
        break;

      case "session.pr.get":
        // Get command handles its own formatting in the command class
        this.formatGenericObject(result, options);
        break;

      case "rules.list":
        if ("rules" in result) {
          this.formatRulesListResult(result.rules as unknown[]);
        } else {
          this.formatGenericObject(result, options);
        }
        break;

      case "rules.get":
        if ("content" in result || "id" in result) {
          formatRuleDetails(result as Record<string, unknown>);
        } else {
          this.formatGenericObject(result, options);
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
          this.formatGenericObject(result, options);
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
          this.formatGenericObject(result, options);
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
        this.formatGenericObject(result, options);
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
  private formatGenericObject(
    result: Record<string, unknown>,
    options?: ResultRenderOptions
  ): void {
    // Try to find meaningful fields to display
    if (result.printed) {
      // The command DECLARES that its own report is complete, so the fallback
      // adds nothing — not the status line, not the payload.
      //
      // Deliberately NOT extended to `options.commandEmittedOutput` (mt#3961).
      // That signal answers "did anything print?", which is not the same
      // question as "was what printed the complete report?", and the gap is not
      // cosmetic. `refs.status` prints its table and returns that same table as
      // a payload — suppressing is right. `authorship.recompute` prints one
      // incidental line ("Running in dry-run mode…") and returns a
      // `RecomputeSummary` that is nothing like it — suppressing would discard
      // the entire finding the operator ran the command to get. Both are
      // "emitted output"; only the command knows which it is, which is why the
      // suppression stays declared here rather than inferred.
      //
      // The inference is still correct for the NARROWER decision it was built
      // for in mt#3870 — whether to re-render payload keys under a report — and
      // that use survives below. The asymmetry is in the failure modes: guessing
      // wrong there leaves the pre-mt#3870 status line, while guessing wrong
      // here prints nothing at all.
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
        // A command with no `message`/`output` projection still has a payload,
        // and printing only the boolean discards it (mt#3478, mt#3870). Render
        // whatever the command actually returned rather than swallowing it: an
        // unstyled key list is worse than a bespoke formatter and strictly
        // better than silence, and for the 140 of 225 commands that declare no
        // `--json` flag it is the operator's only access to the payload at all.
        //
        // Skipped when the command printed its own report during `execute`:
        // there the payload is the machine-readable twin of what the operator
        // just read, and rendering it again duplicates the report.
        if (!options?.commandEmittedOutput) {
          for (const line of formatPayloadKeys(result)) {
            log.cli(line);
          }
        }
      }

      // Handle single error
      if (result.error) {
        log.cli(`Error: ${result.error}`);
      }

      // Handle error array (e.g., from a command returning per-item errors)
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
