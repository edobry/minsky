/**
 * Shared Validate Commands
 *
 * This module contains shared validation command implementations (lint, typecheck)
 * that can be registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
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
 * Parameters for validate.typecheck.
 *
 * Unlike the shared `workspaceParam`, `workspace` here has NO default value so the
 * command can distinguish "no workspace given" (run the root tsconfig AND every
 * self-typechecking sub-workspace) from "explicit workspace given" (run only that
 * directory, backward-compatible single-workspace mode).
 */
const typecheckParams = {
  workspace: {
    schema: z.string(),
    description:
      "Specific workspace directory to typecheck (uses that directory's tsconfig.json). " +
      "When omitted, typechecks the root tsconfig AND every workspace (packages/*, services/*) " +
      "that declares its own `typecheck` script, reporting per-workspace errors.",
    required: false,
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
  /** Workspace this error was reported in (e.g. "." for root, "services/reviewer"). */
  workspace: string;
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
  /** Workspaces that were typechecked (labels), e.g. ["." , "services/reviewer"]. */
  workspaces: string[];
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
 * Run `tsgo --noEmit` for one target and parse its errors.
 *
 * @param cwd            Directory to spawn the checker in.
 * @param workspaceLabel Label attributed to every error produced (e.g. "." or "services/reviewer").
 * @param projectPath    Optional `-p <tsconfig>` path (relative to `cwd`). When omitted, the
 *                       checker uses `cwd`'s own `tsconfig.json`.
 */
async function runTypecheckTarget(
  cwd: string,
  workspaceLabel: string,
  projectPath?: string
): Promise<TypecheckError[]> {
  const args = ["bunx", "@typescript/native-preview", "--noEmit"];
  if (projectPath) {
    args.push("-p", projectPath);
  }

  const proc = Bun.spawn(args, {
    cwd,
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
        workspace: workspaceLabel,
        file: match[1] as string,
        line: parseInt(match[2] as string, 10),
        column: parseInt(match[3] as string, 10),
        code: match[4] as string,
        message: match[5] as string,
      });
    }
  }

  return errors;
}

/**
 * Discover sub-workspaces that own their own typecheck.
 *
 * Reads the root `package.json` `workspaces` globs, enumerates each matching directory,
 * and returns the relative paths of those that BOTH declare a `typecheck` script AND have
 * their own `tsconfig.json`. Discovery is by trigger condition (own `typecheck` script),
 * not by hardcoded path — a future workspace that adds its own typecheck is covered
 * automatically. This mirrors what the CI `build` job runs as separate per-service
 * typecheck steps (`.github/workflows/ci.yml`).
 *
 * Fail-open: any read/parse error skips the offending workspace rather than throwing, so the
 * root typecheck still runs. Glob support matches the conservative pre-commit detector
 * convention: literal paths and single trailing `*` (e.g. `packages/*`, `services/*`).
 * Patterns with `**`, negations, or character classes are skipped rather than mis-interpreted.
 */
/**
 * Minimal filesystem surface used by {@link discoverTypecheckWorkspaces}.
 *
 * Injectable so the discovery logic can be unit-tested against an in-memory tree (no real
 * filesystem). The default implementation ({@link defaultWorkspaceFs}) wraps Node/Bun `fs`.
 */
export interface WorkspaceFs {
  /** Read a UTF-8 text file. Rejects if the file does not exist or is unreadable. */
  readFile(path: string): Promise<string>;
  /** List the entries of a directory. Rejects if the directory does not exist. */
  readdir(path: string): Promise<string[]>;
  /** Whether a path exists. */
  exists(path: string): boolean;
}

const defaultWorkspaceFs: WorkspaceFs = {
  readFile: async (path) => (await readFile(path, "utf8")).toString(),
  readdir: async (path) => readdir(path),
  exists: (path) => existsSync(path),
};

export async function discoverTypecheckWorkspaces(
  rootDir: string,
  fsImpl: WorkspaceFs = defaultWorkspaceFs
): Promise<string[]> {
  let rootPkg: { workspaces?: string[] | { packages?: string[] } };
  try {
    rootPkg = JSON.parse(await fsImpl.readFile(join(rootDir, "package.json"))) as {
      workspaces?: string[] | { packages?: string[] };
    };
  } catch {
    return [];
  }

  const patterns: string[] = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces?.packages ?? []);

  const candidates: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
      const parent = pattern.slice(0, -2);
      let entries: string[];
      try {
        entries = await fsImpl.readdir(join(rootDir, parent));
      } catch {
        continue;
      }
      for (const entry of entries) {
        candidates.push(`${parent}/${entry}`);
      }
    } else if (!pattern.includes("*")) {
      candidates.push(pattern);
    }
    // Patterns with `**`, embedded globs, negations, or character classes are
    // conservatively skipped (under-flag rather than mis-flag).
  }

  const result: string[] = [];
  for (const rel of candidates) {
    const dir = join(rootDir, rel);
    if (!fsImpl.exists(join(dir, "tsconfig.json"))) {
      continue;
    }
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(await fsImpl.readFile(join(dir, "package.json"))) as {
        scripts?: Record<string, string>;
      };
    } catch {
      continue;
    }
    const typecheckScript = pkg.scripts?.typecheck;
    if (typeof typecheckScript === "string" && typecheckScript.trim().length > 0) {
      result.push(rel);
    }
  }

  result.sort();
  return result;
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
      description:
        "Run TypeScript type checker and return structured results. By default covers the root " +
        "tsconfig AND every self-typechecking sub-workspace (e.g. services/reviewer); pass " +
        "`workspace` to typecheck a single directory only.",
      parameters: typecheckParams,
      execute: async (params): Promise<TypecheckResult> => {
        const explicitWorkspace = params.workspace as string | undefined;

        const errors: TypecheckError[] = [];
        const checked: string[] = [];

        if (explicitWorkspace) {
          // Single-workspace mode (backward compatible): run in that directory using its
          // own tsconfig.json.
          checked.push(explicitWorkspace);
          errors.push(...(await runTypecheckTarget(explicitWorkspace, explicitWorkspace)));
        } else {
          // Multi-workspace mode: root tsconfig + every workspace with its own `typecheck`
          // script. All targets are spawned from the root so the root-installed checker
          // binary is reused; per-workspace tsconfigs are selected via `-p`, which yields
          // root-relative error paths (natural workspace attribution).
          const rootDir = process.cwd();
          checked.push(".");
          errors.push(...(await runTypecheckTarget(rootDir, ".")));

          const workspaces = await discoverTypecheckWorkspaces(rootDir);
          for (const ws of workspaces) {
            checked.push(ws);
            errors.push(...(await runTypecheckTarget(rootDir, ws, `${ws}/tsconfig.json`)));
          }
        }

        const status: "pass" | "fail" = errors.length === 0 ? "pass" : "fail";

        return {
          success: errors.length === 0,
          errorCount: errors.length,
          errors,
          status,
          workspaces: checked,
        };
      },
    })
  );
}
