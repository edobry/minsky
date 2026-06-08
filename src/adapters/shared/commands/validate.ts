/**
 * Shared Validate Commands
 *
 * This module contains shared validation command implementations (lint, typecheck)
 * that can be registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, relative, resolve } from "path";
import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SessionProviderInterface } from "@minsky/domain/session";

// NOTE: `workspace` has NO defaultValue. If it defaulted to process.cwd(), the
// parameter layer would always populate `params.workspace`, so
// resolveValidateWorkspace's "explicit workspace wins" branch would fire every
// time and `task`/`sessionId` routing would never run (the cwd default is instead
// provided by resolveValidateWorkspace's own `cwd` fallback). See mt#2336.
const workspaceParam = {
  workspace: {
    schema: z.string(),
    description:
      "Workspace directory to run validation in. When omitted (and no task/sessionId), " +
      "defaults to the current working directory.",
    required: false,
  },
};

const sessionParams = {
  task: {
    schema: z.string(),
    description: "Task ID whose session workspace should be validated (e.g. 'mt#123')",
    required: false,
  },
  sessionId: {
    schema: z.string(),
    description: "Session ID whose workspace should be validated",
    required: false,
  },
};

export const lintParams = {
  ...workspaceParam,
  ...sessionParams,
};

/**
 * Parameters for validate.typecheck.
 *
 * Unlike the shared `workspaceParam`, `workspace` here has NO default value so the
 * command can distinguish "no workspace given" (run the root tsconfig AND every
 * self-typechecking sub-workspace) from "explicit workspace given" (run only that
 * directory, backward-compatible single-workspace mode).
 */
export const typecheckParams = {
  workspace: {
    schema: z.string(),
    description:
      "Specific workspace directory to typecheck (uses that directory's tsconfig.json). " +
      "When omitted, typechecks the root tsconfig AND every workspace (packages/*, services/*) " +
      "that declares its own `typecheck` script, reporting per-workspace errors.",
    required: false,
  },
  ...sessionParams,
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
  /** The directory that was actually validated — prevents silent main-repo checks. */
  validatedWorkspace: string;
  /**
   * Set only when the eslint runner itself failed (non-JSON stdout) rather than
   * reporting lint findings — carries the exit code + a stderr/stdout tail so the
   * cause is diagnosable (missing config/plugins, cwd misrouting, spawn failure),
   * mirroring the typecheck path's `TSGO_RUNNER` diagnostic.
   */
  diagnostic?: string;
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
  /** The base directory that was actually validated — prevents silent main-repo checks. */
  validatedWorkspace: string;
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
 * Resolve the workspace directory to validate against.
 *
 * Precedence (highest to lowest):
 *   1. `workspace` — explicit path, always wins
 *   2. `task` / `sessionId` — resolved via the injected `resolveSessionDir` callback
 *   3. fallback — `process.cwd()`
 *
 * This function is pure (no direct I/O or DI lookups) — the caller injects the
 * `resolveSessionDir` callback so this can be unit-tested without a real container
 * or filesystem.
 *
 * @param params           - The `workspace`, `task`, and `sessionId` fields from command params.
 * @param resolveSessionDir - Async callback that returns the session workdir given a task/sessionId.
 *                            Called only when `workspace` is absent AND task/sessionId was supplied.
 * @param cwd               - Fallback directory when no routing field is given. Defaults to
 *                            `process.cwd()`; injectable so the fallback is unit-testable without
 *                            referencing the real cwd.
 */
export async function resolveValidateWorkspace(
  params: { workspace?: string; task?: string; sessionId?: string },
  resolveSessionDir: (q: { task?: string; sessionId?: string }) => Promise<string>,
  cwd: string = process.cwd()
): Promise<string> {
  if (params.workspace !== undefined && params.workspace !== "") {
    return params.workspace;
  }
  if (params.task !== undefined || params.sessionId !== undefined) {
    return resolveSessionDir({ task: params.task, sessionId: params.sessionId });
  }
  return cwd;
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

  // Read both streams concurrently to avoid pipe-buffer deadlock, then await the exit code.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  // Parse tsgo output lines matching: file(line,col): error TSxxxx: message
  const errorPattern = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
  const errors: TypecheckError[] = [];

  for (const line of stdout.split("\n")) {
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

  // A non-zero exit with NO parseable type errors means the checker itself failed to run
  // (missing package, config error, spawn failure) — never silently report this as a pass.
  // Surface a synthetic error carrying the exit code and a tail of stderr/stdout for diagnosis.
  // (When type errors WERE parsed, tsgo's non-zero exit is the normal "found errors" path.)
  if (exitCode !== 0 && errors.length === 0) {
    const diagnostic = (stderr.trim() || stdout.trim() || "no output").slice(0, 2000);
    errors.push({
      workspace: workspaceLabel,
      file: projectPath ?? cwd,
      line: 0,
      column: 0,
      code: "TSGO_RUNNER",
      message: `Type checker exited with code ${exitCode} and produced no parseable errors: ${diagnostic}`,
    });
  }

  return errors;
}

/**
 * Minimal filesystem surface used by {@link discoverTypecheckWorkspaces}.
 *
 * Injectable so the discovery logic can be unit-tested against an in-memory tree (no real
 * filesystem). The default implementation ({@link defaultWorkspaceFs}) wraps Node/Bun `fs`.
 * All members are async so a slow/remote filesystem can be modeled without a sync footgun.
 */
export interface WorkspaceFs {
  /** Read a UTF-8 text file. Rejects if the file does not exist or is unreadable. */
  readFile(path: string): Promise<string>;
  /** List the entries of a directory. Rejects if the directory does not exist. */
  readdir(path: string): Promise<string[]>;
  /** Whether a path exists. */
  exists(path: string): Promise<boolean>;
}

const defaultWorkspaceFs: WorkspaceFs = {
  readFile: async (path) => (await readFile(path, "utf8")).toString(),
  readdir: async (path) => readdir(path),
  exists: async (path) => existsSync(path),
};

/**
 * Directory names a `<glob>/*` workspace pattern must never enumerate into — heavy or
 * irrelevant trees that can never be a declared workspace. Guards against a stray pattern
 * like `*` or `./*` walking `node_modules` on some layouts. Dot-directories are also skipped.
 */
const WORKSPACE_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

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
 * Enumerated entries in {@link WORKSPACE_SKIP_DIRS} (and dot-directories) are excluded before
 * any `package.json`/`tsconfig.json` probing.
 */
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
        if (entry.startsWith(".") || WORKSPACE_SKIP_DIRS.has(entry)) {
          continue;
        }
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
    if (!(await fsImpl.exists(join(dir, "tsconfig.json")))) {
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
 * Build a session-directory resolver from the DI container's sessionDeps.
 *
 * Returns a function matching the `resolveValidateWorkspace` callback signature.
 * Throws with a clear message if the container or sessionDeps is missing when
 * a task/sessionId was explicitly requested.
 *
 * Uses `resolveSessionContextWithFeedback` + `getSessionWorkdir` — the same
 * pattern used by sibling session-aware commands.
 */
function buildSessionDirResolver(
  container: AppContainerInterface | undefined
): (q: { task?: string; sessionId?: string }) => Promise<string> {
  return async (q: { task?: string; sessionId?: string }): Promise<string> => {
    if (!container?.has("sessionDeps")) {
      throw new Error(
        "Cannot resolve session workspace: DI container or 'sessionDeps' is unavailable. " +
          "Ensure the container is initialized before calling validate commands with task/sessionId."
      );
    }
    const { resolveSessionContextWithFeedback } = await import(
      "@minsky/domain/session/session-context-resolver"
    );
    const deps = container.get("sessionDeps") as {
      sessionProvider: SessionProviderInterface;
    };
    const resolved = await resolveSessionContextWithFeedback({
      sessionId: q.sessionId,
      task: q.task,
      sessionProvider: deps.sessionProvider,
      allowAutoDetection: false,
    });
    return deps.sessionProvider.getSessionWorkdir(resolved.sessionId);
  };
}

/**
 * Register the validate commands in the shared command registry.
 *
 * @param container Optional DI container — when provided, the `task` and `sessionId`
 *   parameters resolve to the session workspace via `SessionService.getDir`.
 *   Mirrors the pattern used by `registerPrWatchCommands` and `registerProvenanceCommands`.
 */
export function registerValidateCommands(container?: AppContainerInterface): void {
  const resolveSessionDir = buildSessionDirResolver(container);

  // Register validate.lint command
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "validate.lint",
      category: CommandCategory.TOOLS,
      name: "lint",
      description: "Run ESLint and return structured results",
      parameters: lintParams,
      execute: async (params): Promise<LintResult> => {
        const workspacePath = await resolveValidateWorkspace(
          {
            workspace: params.workspace as string | undefined,
            task: params.task as string | undefined,
            sessionId: params.sessionId as string | undefined,
          },
          resolveSessionDir
        );

        const proc = Bun.spawn(["bunx", "eslint", ".", "--format", "json"], {
          cwd: workspacePath,
          stdout: "pipe",
          stderr: "pipe",
        });

        // Read both streams concurrently to avoid pipe-buffer deadlock, then await exit.
        const [output, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;

        // ESLint returns non-zero when issues are found but still outputs JSON on stdout
        let fileResults: EslintFileResult[] = [];
        try {
          fileResults = JSON.parse(output) as EslintFileResult[];
        } catch {
          // Non-JSON stdout means the eslint RUNNER itself failed (missing config/plugins,
          // cwd misrouting, spawn failure) — surface the exit code + a stderr/stdout tail
          // so the cause is diagnosable, mirroring runTypecheckTarget's TSGO_RUNNER path.
          const tail = (stderr.trim() || output.trim() || "no output").slice(0, 2000);
          return {
            success: false,
            errorCount: 1,
            warningCount: 0,
            fileCount: 0,
            ruleBreakdown: {},
            status: "fail",
            diagnostic: `ESLINT_RUNNER: eslint exited with code ${exitCode} and produced non-JSON stdout: ${tail}`,
            validatedWorkspace: workspacePath,
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
          validatedWorkspace: workspacePath,
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
        "`workspace` to typecheck a single directory only. Error `file` paths are root-relative " +
        "in both modes. Pass `task` or `sessionId` to run against a session workspace.",
      parameters: typecheckParams,
      execute: async (params): Promise<TypecheckResult> => {
        const explicitWorkspace = params.workspace as string | undefined;
        const task = params.task as string | undefined;
        const sessionId = params.sessionId as string | undefined;

        // Resolve the base directory for this run.
        // - explicit `workspace` → single-workspace mode (backward compat)
        // - task / sessionId   → session workdir (multi-workspace mode, base = session dir)
        // - neither            → process.cwd() (multi-workspace mode, base = main repo)
        const rootDir = await resolveValidateWorkspace(
          { workspace: explicitWorkspace, task, sessionId },
          resolveSessionDir
        );

        const errors: TypecheckError[] = [];
        const checked: string[] = [];

        // Every target is spawned from the repo root (reuses the root-installed checker binary)
        // and selects the workspace's tsconfig via `-p`, so error `file` paths are consistently
        // root-relative in BOTH single- and multi-workspace modes.
        if (explicitWorkspace) {
          // Single-workspace mode (backward compatible). `-p <rel>/tsconfig.json` keeps file
          // paths root-relative; an explicit root (rel === ".") falls back to the root tsconfig.
          checked.push(explicitWorkspace);
          const rel = relative(rootDir, resolve(rootDir, explicitWorkspace)) || ".";
          const projectPath = rel === "." ? undefined : `${rel}/tsconfig.json`;
          errors.push(...(await runTypecheckTarget(rootDir, explicitWorkspace, projectPath)));
        } else {
          // Multi-workspace mode: root tsconfig + every workspace with its own `typecheck`
          // script. When task/sessionId was given, rootDir is the session workspace; otherwise
          // it is process.cwd() (the main repo).
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
          validatedWorkspace: rootDir,
        };
      },
    })
  );
}
