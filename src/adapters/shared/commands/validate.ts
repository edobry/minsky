/**
 * Shared Validate Commands
 *
 * This module contains shared validation command implementations (lint, typecheck)
 * that can be registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";

const workspaceParam = {
  workspace: {
    schema: z.string(),
    description: "Workspace directory to run validation in (defaults to current working directory)",
    required: false,
    defaultValue: process.cwd(),
  },
};

/**
 * Result type for validate.lint command
 */
interface LintResult {
  success: boolean;
  errorCount: number;
  warningCount: number;
  fileCount: number;
  ruleBreakdown: Record<string, number>;
  status: "pass" | "fail";
}

/**
 * Result type for validate.typecheck command
 */
interface TypecheckError {
  file: string;
  line: number;
  column: number;
  message: string;
  code: string;
}

interface TypecheckResult {
  success: boolean;
  errorCount: number;
  errors: TypecheckError[];
  status: "pass" | "fail";
}

/**
 * ESLint JSON output file result shape (partial)
 */
interface EslintFileResult {
  filePath: string;
  messages: Array<{
    ruleId: string | null;
    severity: number;
    message: string;
  }>;
  errorCount: number;
  warningCount: number;
}

/**
 * Register the validate commands in the shared command registry
 */
export function registerValidateCommands(): void {
  // Register validate.lint command
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "validate.lint",
      category: CommandCategory.TOOLS,
      name: "lint",
      description: "Run ESLint and return structured results",
      parameters: workspaceParam,
      execute: async (params): Promise<LintResult> => {
        const workspacePath = (params.workspace as string | undefined) ?? process.cwd();

        const proc = Bun.spawn(["bunx", "eslint", ".", "--format", "json"], {
          cwd: workspacePath,
          stdout: "pipe",
          stderr: "pipe",
        });

        const output = await new Response(proc.stdout).text();
        // Drain stderr to avoid blocking
        await new Response(proc.stderr).text();
        await proc.exited;

        // ESLint returns non-zero when issues are found but still outputs JSON on stdout
        let fileResults: EslintFileResult[] = [];
        try {
          fileResults = JSON.parse(output) as EslintFileResult[];
        } catch {
          // If JSON parse fails, treat as a fatal error (eslint itself crashed)
          return {
            success: false,
            errorCount: 1,
            warningCount: 0,
            fileCount: 0,
            ruleBreakdown: {},
            status: "fail",
          };
        }

        let totalErrors = 0;
        let totalWarnings = 0;
        const ruleBreakdown: Record<string, number> = {};

        for (const fileResult of fileResults) {
          totalErrors += fileResult.errorCount;
          totalWarnings += fileResult.warningCount;

          for (const msg of fileResult.messages) {
            if (msg.ruleId) {
              ruleBreakdown[msg.ruleId] = (ruleBreakdown[msg.ruleId] ?? 0) + 1;
            }
          }
        }

        const status: "pass" | "fail" = totalErrors === 0 ? "pass" : "fail";

        return {
          success: totalErrors === 0,
          errorCount: totalErrors,
          warningCount: totalWarnings,
          fileCount: fileResults.length,
          ruleBreakdown,
          status,
        };
      },
    })
  );

  // Register validate.typecheck command
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "validate.typecheck",
      category: CommandCategory.TOOLS,
      name: "typecheck",
      description: "Run TypeScript type checker and return structured results",
      parameters: workspaceParam,
      execute: async (params): Promise<TypecheckResult> => {
        const workspacePath = (params.workspace as string | undefined) ?? process.cwd();

        const proc = Bun.spawn(["bunx", "@typescript/native-preview", "--noEmit"], {
          cwd: workspacePath,
          stdout: "pipe",
          stderr: "pipe",
        });

        const output = await new Response(proc.stdout).text();
        // Drain stderr to avoid blocking
        await new Response(proc.stderr).text();
        await proc.exited;

        // Parse tsgo output lines matching: file(line,col): error TSxxxx: message
        const errorPattern = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
        const errors: TypecheckError[] = [];

        for (const line of output.split("\n")) {
          const match = errorPattern.exec(line.trim());
          if (match) {
            errors.push({
              file: match[1] as string,
              line: parseInt(match[2] as string, 10),
              column: parseInt(match[3] as string, 10),
              code: match[4] as string,
              message: match[5] as string,
            });
          }
        }

        const status: "pass" | "fail" = errors.length === 0 ? "pass" : "fail";

        return {
          success: errors.length === 0,
          errorCount: errors.length,
          errors,
          status,
        };
      },
    })
  );
}
