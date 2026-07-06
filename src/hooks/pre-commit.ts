#!/usr/bin/env bun

/**
 * TypeScript-based pre-commit hook implementation
 *
 * Replaces fragile bash script with type-safe TypeScript that leverages
 * Minsky's own infrastructure for consistent configuration and error handling.
 */

import { execAsync } from "@minsky/shared/exec";
import { execGitWithTimeout } from "@minsky/domain/utils/git-exec";
import { stat, readdir, readFile } from "fs/promises";
import { join } from "path";
import { ProjectConfigReader } from "@minsky/domain/project/config-reader";
import { log } from "@minsky/shared/logger";
import {
  detectNulByteViolations,
  isPathAllowlisted,
  isOverrideTruthy,
  NUL_BYTE_CHECK_OVERRIDE_ENV,
} from "./nul-byte-detector";
import {
  runWorkspaceCopyCheck as runWorkspaceCopyDetector,
  isWorkspaceCopyOverrideTruthy,
  WORKSPACE_COPY_CHECK_OVERRIDE_ENV,
} from "./workspace-copy-detector";
import {
  detectMissingJournalEntries,
  MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV,
  type JournalEntry,
} from "./migration-journal-check";
import {
  runDeployDomainCheck as runDeployDomainDetector,
  isDeployDomainOverrideTruthy,
  DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV,
} from "./deploy-domain-detector";
import {
  detectImmutableMigrationViolations,
  isImmutableMigrationOverrideTruthy,
  IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV,
  MIGRATION_DIRS,
} from "./immutable-migration-detector";

export interface ESLintResult {
  filePath: string;
  messages: {
    ruleId?: string;
    severity?: number;
    message?: string;
    line?: number;
    column?: number;
  }[];
  errorCount: number;
  warningCount: number;
  fixableErrorCount: number;
  fixableWarningCount: number;
  source?: string;
}

export interface ESLintSummary {
  errorCount: number;
  warningCount: number;
  results: ESLintResult[];
}

export interface HookResult {
  success: boolean;
  message: string;
  exitCode: number;
}

export class PreCommitHook {
  constructor(private projectRoot: string = process.cwd()) {}

  /**
   * Run all pre-commit validation steps
   */
  async run(): Promise<HookResult> {
    log.cli("🔍 Running pre-commit validation...\n");

    try {
      // ── Instant checks (~0s) ──

      // Step 0: Hook file permissions
      const hookPermResult = await this.runHookPermissionCheck();
      if (!hookPermResult.success) {
        return hookPermResult;
      }

      // ── Fast, lightweight checks first (~1s each) ──

      // Step 1: Code formatting (lint-staged, only staged files, ~1s)
      const formatResult = await this.runCodeFormatting();
      if (!formatResult.success) {
        return formatResult;
      }

      // Console-usage validation moved into ESLint as the `custom/no-raw-console`
      // rule (mt#1960). Step 2 ran the standalone regex-based `lint:console:strict`
      // script; that script and its package.json scripts were retired with mt#1960.
      // The AST-based ESLint pass below now catches raw `console.*` calls.

      // Step 3: Variable naming check (~1s)
      const variableResult = await this.runVariableNamingCheck();
      if (!variableResult.success) {
        return variableResult;
      }

      // Step 3a: Node shim detection — ban node shebangs, npm run, npx in source files (~0s)
      const nodeShimResult = await this.runNodeShimCheck();
      if (!nodeShimResult.success) {
        return nodeShimResult;
      }

      // Step 3b: NUL-byte detection — reject any tracked text file containing
      // a literal 0x00 byte (mt#1824). Closes the gate-gap exposed by mt#1821
      // / PR #1107 R1 where a JSON-escaped U+0000 landed on disk inside a TS
      // template literal and slipped past every other quality gate.
      const nulByteResult = await this.runNulByteCheck();
      if (!nulByteResult.success) {
        return nulByteResult;
      }

      // Step 3c: Workspace-COPY check (mt#1984 + mt#1992). Verify every
      // workspace declared by root `package.json`'s `workspaces` glob has
      // a corresponding `COPY <ws>/package.json` line in EVERY Dockerfile
      // that runs `bun install --frozen-lockfile` (root + sub-project
      // Dockerfiles under services/* and packages/*), placed BEFORE the
      // install step. Prevents recurrence of mt#1977 (75-minute root-
      // Dockerfile outage) and mt#1991 (4-hour reviewer-Dockerfile outage
      // after the root-only check missed services/reviewer/Dockerfile).
      const workspaceCopyResult = await this.runWorkspaceCopyCheck();
      if (!workspaceCopyResult.success) {
        return workspaceCopyResult;
      }

      // Step 3d: Migration journal consistency (mt#2087). Verify that every
      // SQL file under packages/domain/src/storage/migrations/pg/ has a corresponding
      // entry in meta/_journal.json. Prevents the mt#2086 class where a
      // hand-written SQL file ships without a journal entry, making it
      // invisible to Drizzle's migrator.
      const migrationJournalResult = await this.runMigrationJournalCheck();
      if (!migrationJournalResult.success) {
        return migrationJournalResult;
      }

      // Step 3e-a: Immutable-migration check (mt#2268). Block staged
      // MODIFICATIONS (not additions) to .sql files under the migration
      // directories whose tag is already listed in meta/_journal.json.
      // Editing an applied migration drifts Drizzle's sha256 ledger —
      // the mt#1641/mt#2250 root cause (migrations 0002/0014/0015).
      const immutableMigrationResult = await this.runImmutableMigrationCheck();
      if (!immutableMigrationResult.success) {
        return immutableMigrationResult;
      }

      // Step 3e: Deploy-domain ownership check (mt#2208, live successor to
      // mt#2193). Verify every domain ASSERTED as a deployment target in
      // deploy/site config (infra/index.ts SITE_URL, services/*/deploy.config.ts,
      // services/*/astro.config.ts, services/*/README.md "Deployed at" claims)
      // is a domain we actually control (listed in infra/controlled-domains.json).
      // Prevents recurrence of the minsky.dev class: an illustrative example URL
      // that hardened into authoritative config + a false "Deployed at" claim,
      // never ownership-verified.
      const deployDomainResult = await this.runDeployDomainCheck();
      if (!deployDomainResult.success) {
        return deployDomainResult;
      }

      // ── Medium-weight static analysis (~5s each) ──

      // Step 4: TypeScript type checking (~5s)
      const typeCheckResult = await this.runTypeCheck();
      if (!typeCheckResult.success) {
        return typeCheckResult;
      }

      // Step 5: ESLint validation (~5-10s)
      const lintResult = await this.runESLintValidation();
      if (!lintResult.success) {
        return lintResult;
      }

      // ── Security scanning (~2-3s, critical but rare) ──

      // Step 6: Secret scanning
      const secretsResult = await this.runSecretScanning();
      if (!secretsResult.success) {
        return secretsResult;
      }

      // ── Expensive runtime checks (tests) ──

      // Step 7: Unit tests (most expensive)
      const testsResult = await this.runUnitTests();
      if (!testsResult.success) {
        return testsResult;
      }

      // Step 8: ESLint rule tooling tests (niche)
      const ruleTestsResult = await this.runESLintRuleTests();
      if (!ruleTestsResult.success) {
        return ruleTestsResult;
      }

      // Step 9: Rules compile staleness check (legacy `rules compile` system)
      const rulesCheckResult = await this.runRulesCompileCheck();
      if (!rulesCheckResult.success) {
        return rulesCheckResult;
      }

      // Step 9b: Compile staleness check (new `compile` system — mt#2252)
      const compileCheckResult = await this.runCompileCheck();
      if (!compileCheckResult.success) {
        return compileCheckResult;
      }

      log.cli("✅ All checks passed! Commit proceeding...");
      return {
        success: true,
        message: "All pre-commit checks passed",
        exitCode: 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ Pre-commit hook failed: ${errorMsg}`);
      return {
        success: false,
        message: `Pre-commit hook failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Run ESLint validation with proper JSON parsing
   */
  private async runESLintValidation(): Promise<HookResult> {
    log.cli("🔍 Running ESLint with strict quality gates...");

    try {
      // Use ProjectConfigReader for consistent config loading
      const configReader = new ProjectConfigReader(this.projectRoot);
      const lintJsonCommand = await configReader.getLintJsonCommand();

      log.cli(`📋 Using lint command: ${lintJsonCommand}`);

      // Execute the lint command and get JSON output
      // ESLint exits with non-zero when there are errors/warnings, but still produces valid JSON
      let stdout = "";
      let stderr = "";
      try {
        const result = await execAsync(lintJsonCommand, {
          cwd: this.projectRoot,
          // Full-repo eslint wall time has grown to ~29s (measured 2026-06-13,
          // mt#1859 session) — the former 30s timeout fired on any loaded run,
          // blocking every commit with a bare "Command failed". 120s gives
          // repo-growth headroom; a hung eslint still gets killed.
          timeout: 120000,
          // The --format json payload is ~850KB and grows with file count;
          // the 1MB exec default truncate-kills the process at the boundary.
          maxBuffer: 64 * 1024 * 1024,
        });
        stdout = result.stdout.toString();
        stderr = result.stderr.toString();
      } catch (execError: unknown) {
        // ESLint exits with non-zero on errors/warnings but still produces valid output
        const execErr = execError as { stdout?: string; stderr?: string };
        if (execErr.stdout) {
          stdout = execErr.stdout;
          stderr = execErr.stderr || "";
        } else {
          throw execError;
        }
      }

      // Parse ESLint JSON output with proper error handling
      let lintResults: ESLintResult[] = [];
      try {
        // ESLint JSON output is an array of result objects
        lintResults = JSON.parse(stdout || "[]");
      } catch (parseError) {
        // If JSON parsing fails, try to extract from stderr or fall back to empty array
        log.warn("⚠️ Failed to parse ESLint JSON output, falling back to stderr analysis");
        if (stderr && stderr.includes("error")) {
          // If there are errors in stderr, treat as failure
          return {
            success: false,
            message: "ESLint execution failed with errors",
            exitCode: 1,
          };
        }
        // Otherwise continue with empty results
        lintResults = [];
      }

      // Calculate totals
      const summary = this.calculateESLintSummary(lintResults);

      // Log the current state
      log.cli("📊 ESLint Results:");
      log.cli(`   Errors: ${summary.errorCount}`);
      log.cli(`   Warnings: ${summary.warningCount}`);

      // STRICT ENFORCEMENT: Block if ANY errors found
      if (summary.errorCount > 0) {
        log.cli("");
        log.cli("❌ ❌ ❌ LINTER ERRORS DETECTED! COMMIT BLOCKED! ❌ ❌ ❌");
        log.cli("");
        log.cli(
          `🚫 Found ${summary.errorCount} linter error(s). ALL errors must be fixed before committing.`
        );
        log.cli("💡 Run 'bun run lint --fix' to auto-fix many issues.");
        log.cli("🔧 Review and manually fix any remaining errors.");
        log.cli("");
        log.cli("Run 'bun run lint' to see detailed error information.");
        return {
          success: false,
          message: `ESLint found ${summary.errorCount} error(s)`,
          exitCode: 1,
        };
      }

      // WARNING THRESHOLD: zero tolerance — any new warning blocks the commit.
      // mt#1097 ratcheted this to 0 after fixing all pre-existing warnings and
      // adding CI-level enforcement (`bun run lint:strict`) so GitHub-UI merges
      // can't bypass the gate. If a warning category legitimately needs an
      // exception, add a line/file-level waiver with a specific justification.
      const MAX_LINT_WARNINGS = 0;
      if (summary.warningCount > MAX_LINT_WARNINGS) {
        log.cli("");
        log.cli("⚠️ ⚠️ ⚠️ TOO MANY WARNINGS! COMMIT BLOCKED! ⚠️ ⚠️ ⚠️");
        log.cli("");
        log.cli(
          `🚫 Found ${summary.warningCount} warnings. Maximum allowed: ${MAX_LINT_WARNINGS}.`
        );
        log.cli("💡 Please address warnings to improve code quality.");
        log.cli(`🎯 Target: Reduce warnings below ${MAX_LINT_WARNINGS} threshold.`);
        log.cli("");
        log.cli("Run 'bun run lint' to see detailed warning information.");
        return {
          success: false,
          message: `ESLint found ${summary.warningCount} warnings (over ${MAX_LINT_WARNINGS} threshold)`,
          exitCode: 1,
        };
      }

      // Success case
      if (summary.warningCount === 0) {
        log.cli("✅ Perfect! Zero errors and zero warnings detected.");
      } else {
        log.cli(
          `✅ Quality gate passed: ${summary.warningCount} warnings (under ${MAX_LINT_WARNINGS} threshold).`
        );
      }

      return {
        success: true,
        message: "ESLint validation passed",
        exitCode: 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ ESLint validation failed: ${errorMsg}`);
      return {
        success: false,
        message: `ESLint validation failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Calculate ESLint summary with reliable aggregation
   */
  private calculateESLintSummary(results: ESLintResult[]): ESLintSummary {
    const summary: ESLintSummary = {
      errorCount: 0,
      warningCount: 0,
      results,
    };

    // Use reduce for safe and reliable aggregation
    summary.errorCount = results.reduce((total, result) => total + result.errorCount, 0);
    summary.warningCount = results.reduce((total, result) => total + result.warningCount, 0);

    return summary;
  }

  /**
   * Run secret scanning (still use gitleaks for now)
   */
  private async runSecretScanning(): Promise<HookResult> {
    log.cli("🔒 SECURITY: Scanning for secrets...");

    try {
      // Check if gitleaks is available before attempting to run it
      await execAsync("which gitleaks", { timeout: 5000 });
    } catch {
      log.cli("❌ gitleaks is not installed. Secret scanning is mandatory.");
      log.cli("💡 Install gitleaks: https://github.com/gitleaks/gitleaks#installing");
      log.cli("💡 On macOS: brew install gitleaks | On Linux: see GitHub releases");
      return {
        success: false,
        message: "gitleaks not installed — secret scanning is required",
        exitCode: 1,
      };
    }

    try {
      await execAsync("gitleaks protect --staged --source . --config .gitleaks.toml --verbose", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ Gitleaks: No secrets detected in staged changes (enhanced scan complete).");
      return { success: true, message: "Secret scanning passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ 🚨 SECRETS DETECTED BY GITLEAKS! Commit blocked for security.");
      log.cli("📋 Review the findings above and sanitize any real credentials.");
      log.cli("💡 Database URLs: Use placeholder values (avoid real credentials)");
      log.cli("💡 API Keys: Use placeholder values like 'sk-proj-xxx...xxxxx'");
      log.cli(
        "💡 Real credentials detected in: PostgreSQL, MySQL, MongoDB, Redis URLs, or API keys"
      );
      return { success: false, message: "Secret scanning failed", exitCode: 1 };
    }
  }

  /**
   * Run variable naming check (keep external for now)
   */
  private async runVariableNamingCheck(): Promise<HookResult> {
    log.cli("🔍 Checking for variable naming issues...");

    try {
      await execAsync("bun run scripts/check-variable-naming.ts", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ No variable naming issues found.");
      return { success: true, message: "Variable naming check passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ Variable naming issues found! Please fix them before committing.");
      log.cli("💡 You can run 'bun run scripts/fix-variable-naming.ts' to auto-fix many issues.");
      return { success: false, message: "Variable naming issues found", exitCode: 1 };
    }
  }

  /**
   * Grep staged source files for Node.js shims that should be Bun idioms.
   *
   * Flags:
   *   - `#!/usr/bin/env node` shebangs (any staged file)
   *   - `npm run ` usage in source files (excludes README/docs/package.json)
   *   - `npx ` usage in source files (same exclusions)
   *
   * Files excluded from the npm/npx checks:
   *   README*, *.md, docs/**, package.json, *.lock, *.yaml, *.yml, *.toml
   *
   * These are caught early (before heavy static analysis) because they are
   * instant to detect and never acceptable in new Bun-first code.
   */
  private async runNodeShimCheck(): Promise<HookResult> {
    log.cli("🚫 Checking for Node.js shims in staged files...");

    try {
      const result = await execGitWithTimeout(
        "diff",
        "diff --cached --name-only --diff-filter=ACM",
        { workdir: this.projectRoot, timeout: 5000 }
      );

      const stagedFiles = result.stdout.toString().trim().split("\n").filter(Boolean);

      if (stagedFiles.length === 0) {
        log.cli("✅ No staged files — skipping Node shim check.");
        return { success: true, message: "No staged files to check", exitCode: 0 };
      }

      // Files exempt from npm/npx checks (documentation and config)
      const isDocOrConfig = (f: string): boolean => {
        const lower = f.toLowerCase();
        return (
          lower.endsWith(".md") ||
          lower.startsWith("readme") ||
          lower.startsWith("docs/") ||
          lower === "package.json" ||
          lower.endsWith(".lock") ||
          lower.endsWith(".yaml") ||
          lower.endsWith(".yml") ||
          lower.endsWith(".toml") ||
          // The bun-over-node enforcement check itself contains "npm run"/"npx" in
          // help-message string literals; exempt the file that runs this check.
          lower === "src/hooks/pre-commit.ts"
        );
      };

      const violations: string[] = [];

      for (const file of stagedFiles) {
        // Read the staged content (index version, not working tree).
        // Use `gitShowStagedBytes` (argv-based, no shell) for the same
        // safety reasons documented on `runNulByteCheck`: file names with
        // shell metacharacters cannot break the command or enable
        // injection. Raw bytes are decoded to utf-8 string for the
        // shebang / `npm run` / `npx` regex scans (this check operates
        // on text content, not byte content). Class-not-instance sweep
        // alongside PR #1110 R1 BLOCKING #1.
        let content: string;
        try {
          const bytes = await this.gitShowStagedBytes(file);
          // TextDecoder rather than Buffer.toString("utf8") because the
          // project's Buffer stub doesn't accept encoding args; the runtime
          // result is equivalent. fatal: false keeps the lossy-decode
          // behavior that this check expects (it scans for ASCII patterns).
          content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        } catch {
          // File may be binary, gitlink, or unavailable — skip
          continue;
        }

        // Check 1: node shebang (applies to every staged file)
        if (
          content.startsWith("#!/usr/bin/env node\n") ||
          content.startsWith("#!/usr/bin/env node\r")
        ) {
          violations.push(
            `${file}: has '#!/usr/bin/env node' shebang — use '#!/usr/bin/env bun' instead`
          );
        }

        // Checks 2 & 3: npm run / npx in source text (exempt docs/config)
        if (!isDocOrConfig(file)) {
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            const lineNum = i + 1;

            // Skip comment lines that explain what NOT to do (e.g. rule documentation)
            const stripped = line.trimStart();
            if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("#")) {
              continue;
            }

            if (/npm run /.test(line)) {
              violations.push(`${file}:${lineNum}: contains 'npm run' — use 'bun run' instead`);
            }
            if (/\bnpx /.test(line)) {
              violations.push(`${file}:${lineNum}: contains 'npx' — use 'bunx' instead`);
            }
          }
        }
      }

      if (violations.length > 0) {
        log.cli("❌ Node.js shims detected in staged files! Commit blocked.");
        log.cli("");
        for (const v of violations) {
          log.cli(`   🚫 ${v}`);
        }
        log.cli("");
        log.cli("💡 Replace Node.js idioms with Bun equivalents:");
        log.cli("   • Shebang:  #!/usr/bin/env node  →  #!/usr/bin/env bun");
        log.cli("   • Runner:   npm run <script>     →  bun run <script>");
        log.cli("   • Executor: npx <pkg>            →  bunx <pkg>");
        log.cli("📖 See bun_over_node.mdc for details.");
        return {
          success: false,
          message: `Node.js shims found in ${violations.length} location(s)`,
          exitCode: 1,
        };
      }

      log.cli("✅ No Node.js shims in staged files.");
      return { success: true, message: "Node shim check passed", exitCode: 0 };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ Node shim check failed: ${errorMsg}`);
      return {
        success: false,
        message: `Node shim check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Scan staged files for NUL bytes (0x00) and block the commit if any
   * tracked text file contains one.
   *
   * Closes the gate-gap exposed by mt#1821 / PR #1107 R1: a JSON-escaped
   * U+0000 in a `session_write_file` content parameter landed as a literal
   * NUL byte inside a TypeScript template literal and slipped past tsc,
   * eslint, prettier, bun test, CI build, and CI bundle-boot-smoke. Git's
   * binary-file detector and the reviewer-bot's diff renderer were the
   * only gates that caught it — at review time, not commit time.
   *
   * Allowlist:
   *   - `KNOWN_BINARY_EXTENSIONS` (png / woff / so / etc.) — NULs expected.
   *   - `FIXTURE_PATH_PREFIXES` (tests/fixtures/) — regression fixtures may
   *     legitimately contain NUL bytes.
   *
   * Override: setting `MINSKY_SKIP_NUL_CHECK` to `1` / `true` / `yes` skips
   * the check and emits a one-line audit message to stdout.
   *
   * See `feedback_json_tool_writes_interpret_unicode_escapes` (b7e2f8ef)
   * for the originating-incident context, and `src/hooks/nul-byte-detector.ts`
   * for the pure-function implementation that this method wraps.
   */
  /**
   * Fetch the staged blob for `file` as raw bytes using `Bun.spawn` with
   * argv (no shell). Replaces `execGitWithTimeout(... `git show :${file}`)`
   * for the NUL-byte check specifically to address two reviewer-bot
   * BLOCKING findings on PR #1110 R1:
   *
   *   1. Shell-interpolation safety: the legacy path embedded the file
   *      name into a single shell command string. Filenames containing
   *      spaces, quotes, colons, or shell metacharacters could break the
   *      command or enable argument injection. Argv bypasses shell
   *      parsing entirely — git receives each argument as a literal
   *      C-string from `execvp`.
   *   2. Byte fidelity: the legacy path returned utf-8 decoded strings.
   *      Re-encoding via `Buffer.from(string)` corrupts non-UTF-8 byte
   *      sequences and shifts the reported byte offset of the first NUL.
   *      `Bun.spawn` with `stdout: "pipe"` plus `arrayBuffer()` returns
   *      the exact bytes git produced — necessary for the spec's
   *      "byte offset of first NUL" guarantee to be correct for any
   *      encoding.
   *
   * Throws on non-zero exit (gitlinks, deleted-then-modified edge cases,
   * etc.); callers handle via `Promise.allSettled`.
   */
  private async gitShowStagedBytes(file: string): Promise<Buffer> {
    const TIMEOUT_MS = 5000;
    const proc = Bun.spawn(["git", "-C", this.projectRoot, "show", `:${file}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    try {
      const bytesPromise = new Response(proc.stdout).arrayBuffer();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        // Drain stderr for diagnostics, but don't block on it indefinitely.
        const stderrText = await new Response(proc.stderr).text();
        throw new Error(
          `git show :${file} exited ${exitCode}: ${stderrText.trim() || "no stderr"}`
        );
      }
      const bytes = await bytesPromise;
      // eslint-disable-next-line custom/no-excessive-as-unknown -- Bun's Buffer.from accepts ArrayBuffer at runtime; project's Buffer stub is narrowed to string | any[] for portability with the Bun-light TS environment, so the cast is required to bridge the typing gap.
      return Buffer.from(bytes as unknown as number[]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runNulByteCheck(): Promise<HookResult> {
    log.cli("Checking staged files for NUL bytes...");

    if (isOverrideTruthy(process.env[NUL_BYTE_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:nul-byte-check] override ${NUL_BYTE_CHECK_OVERRIDE_ENV}=${process.env[NUL_BYTE_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — NUL-byte check skipped`
      );
      return { success: true, message: "NUL-byte check skipped via override", exitCode: 0 };
    }

    try {
      const result = await execGitWithTimeout(
        "diff",
        "diff --cached --name-only --diff-filter=ACM",
        { workdir: this.projectRoot, timeout: 5000 }
      );

      const stagedFiles = result.stdout.toString().trim().split("\n").filter(Boolean);

      if (stagedFiles.length === 0) {
        log.cli("No staged files — skipping NUL-byte check.");
        return { success: true, message: "No staged files to check", exitCode: 0 };
      }

      // Filter allowlisted paths up-front so we never even fetch their content.
      const candidates = stagedFiles.filter((f) => !isPathAllowlisted(f));

      // Fetch staged blobs in parallel via `Bun.spawn` with argv. Two
      // reasons (PR #1110 R1 reviewer-bot, both BLOCKING):
      //   1. Argv bypasses shell parsing — file paths with spaces, quotes,
      //      colons, or shell metacharacters cannot break the command or
      //      enable argument injection. `execGitWithTimeout` interpolates
      //      into a single shell string, which is unsafe for untrusted
      //      paths (staged file names are operator-controlled but a hostile
      //      filename in a contributor's repo could still cause damage).
      //   2. Raw-bytes stdout — `execGitWithTimeout` returns utf-8 decoded
      //      strings, which corrupts non-UTF-8 byte sequences and shifts
      //      the reported byte offset of the first NUL. The spec requires
      //      the offset to be the TRUE byte offset in the staged blob.
      //
      // `Promise.allSettled` so a single bad path (gitlink, etc.) doesn't
      // kill the rest.
      const results = await Promise.allSettled(
        candidates.map((file) => this.gitShowStagedBytes(file))
      );

      const stagedContent = new Map<string, Buffer>();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r === undefined || r.status !== "fulfilled") continue;
        const file = candidates[i];
        if (file === undefined) continue;
        stagedContent.set(file, r.value);
      }

      const violations = detectNulByteViolations(stagedContent);

      if (violations.length === 0) {
        log.cli(`No NUL bytes detected in ${candidates.length} staged text file(s).`);
        return { success: true, message: "NUL-byte check passed", exitCode: 0 };
      }

      log.cli("");
      log.cli("NUL byte(s) detected in staged text files. Commit blocked.");
      log.cli("");
      for (const v of violations) {
        log.cli(`   ${v.path}: first NUL byte at offset ${v.offset}`);
      }
      log.cli("");
      log.cli("Why this is blocked:");
      log.cli("   - Tracking task:        mt#1824");
      log.cli("   - Originating incident: mt#1821 / PR #1107 R1");
      log.cli(
        "   - Memory:               feedback_json_tool_writes_interpret_unicode_escapes (b7e2f8ef)"
      );
      log.cli("");
      log.cli("Common cause: a JSON-parameterized file-write tool received a content");
      log.cli('   string with a "\\u0000" escape. JSON parsing converts the escape to');
      log.cli("   a literal NUL byte BEFORE writing to disk. Pick a printable separator");
      log.cli("   instead (e.g. a pipe, colon, or multi-char string).");
      log.cli("");
      log.cli(
        `If a NUL byte is legitimate (rare), set ${NUL_BYTE_CHECK_OVERRIDE_ENV}=1 to override.`
      );
      log.cli("   The skip is audit-logged to stdout.");
      return {
        success: false,
        message: `NUL bytes detected in ${violations.length} file(s)`,
        exitCode: 1,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`NUL-byte check failed: ${errorMsg}`);
      return {
        success: false,
        message: `NUL-byte check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Run the workspace-COPY check (mt#1984). Verify that every workspace
   * declared by root `package.json`'s `workspaces` glob AND containing a
   * `package.json` has a corresponding `COPY <ws>/package.json` line in
   * the root `Dockerfile` BEFORE the `RUN bun install --frozen-lockfile`
   * step.
   *
   * Originating incident: mt#1977 — PR #1186 (mt#1934, marketing-site
   * rebuild) added `services/site/` as a workspace without updating the
   * Dockerfile's selective-COPY list. Every Railway deploy from that
   * point until the mt#1977 fix landed (~75 minutes later) failed with
   *   `error: lockfile had changes, but lockfile is frozen`
   *
   * The local `bun install` SUCCEEDS because the full repo is mounted;
   * the failure mode is Railway-specific (selective COPY produces an
   * incomplete tree). This check is the commit-time complement to that
   * deploy-time failure mode.
   *
   * Override: setting `MINSKY_SKIP_WORKSPACE_COPY_CHECK` to `1` / `true`
   * / `yes` skips the check and emits a one-line audit message.
   *
   * See `src/hooks/workspace-copy-detector.ts` for the pure-function
   * detector this method wraps.
   */
  private async runWorkspaceCopyCheck(): Promise<HookResult> {
    if (isWorkspaceCopyOverrideTruthy(process.env[WORKSPACE_COPY_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:workspace-copy-check] override ${WORKSPACE_COPY_CHECK_OVERRIDE_ENV}=${process.env[WORKSPACE_COPY_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — workspace-COPY check skipped`
      );
      return {
        success: true,
        message: "Workspace-COPY check skipped via override",
        exitCode: 0,
      };
    }

    try {
      const results = runWorkspaceCopyDetector(this.projectRoot);

      // Silent on happy path (per spec): no preamble, no pass/skip
      // confirmation. Only the failure case below emits stdout.
      // - null = "this repo has no root package.json we recognize" —
      //   short-circuit silently.
      if (results === null) {
        return {
          success: true,
          message: "Workspace-COPY check inapplicable (no root package.json)",
          exitCode: 0,
        };
      }

      // No protected Dockerfiles discovered (e.g., a repo without any
      // `RUN bun install --frozen-lockfile` step). Silent pass.
      if (results.length === 0) {
        return {
          success: true,
          message: "Workspace-COPY check inapplicable (no protected Dockerfiles)",
          exitCode: 0,
        };
      }

      const failing = results.filter((r) => r.missing.length > 0);
      if (failing.length === 0) {
        return {
          success: true,
          message: `Workspace-COPY check passed (${results.length} Dockerfile(s) verified)`,
          exitCode: 0,
        };
      }

      const totalMissing = failing.reduce((sum, r) => sum + r.missing.length, 0);

      log.cli("");
      log.cli(
        `${failing.length} Dockerfile(s) missing workspace package.json COPY line(s). Commit blocked.`
      );
      log.cli("");
      for (const r of failing) {
        log.cli(`${r.dockerfileRelPath}:`);
        for (const m of r.missing) {
          log.cli(`   ${m.workspacePath}/  — add to ${r.dockerfileRelPath}:`);
          log.cli(`     ${m.copyLineToAdd}`);
        }
        log.cli("");
      }
      log.cli("Why this is blocked:");
      log.cli(
        "   - Tracking tasks:       mt#1984 (root Dockerfile), mt#1992 (sub-project Dockerfiles)"
      );
      log.cli(
        "   - Originating incidents: mt#1977 (75-minute outage), mt#1991 (4-hour reviewer outage)"
      );
      log.cli("");
      log.cli("Background: root `package.json` declares workspaces (`packages/*`,");
      log.cli("   `services/*`). When a new workspace is added, `bun.lock` regenerates");
      log.cli("   with its dependencies. EVERY Dockerfile in the repo that runs");
      log.cli("   `RUN bun install --frozen-lockfile` against that lockfile must include");
      log.cli("   each workspace's package.json BEFORE the install step — otherwise the");
      log.cli("   build container sees a workspace topology that doesn't match the lockfile");
      log.cli('   and aborts with "lockfile had changes, but lockfile is frozen".');
      log.cli("");
      log.cli(
        `If a COPY is intentionally omitted (rare), set ${WORKSPACE_COPY_CHECK_OVERRIDE_ENV}=1 to override.`
      );
      log.cli("   The skip is audit-logged to stdout.");
      return {
        success: false,
        message: `Workspace-COPY check failed: ${totalMissing} missing COPY line(s) across ${failing.length} Dockerfile(s)`,
        exitCode: 1,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Workspace-COPY check failed: ${errorMsg}`);
      return {
        success: false,
        message: `Workspace-COPY check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  private async runMigrationJournalCheck(): Promise<HookResult> {
    if (isOverrideTruthy(process.env[MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:migration-journal] override ${MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV}=${process.env[MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — migration journal check skipped`
      );
      return {
        success: true,
        message: "Migration journal check skipped via override",
        exitCode: 0,
      };
    }

    try {
      const migrationsDir = join(this.projectRoot, "packages/domain/src/storage/migrations/pg");
      const metaDir = join(migrationsDir, "meta");

      let sqlFiles: string[];
      try {
        const entries = await readdir(migrationsDir);
        sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();
      } catch {
        return {
          success: true,
          message: "Migration journal check skipped (no migrations dir)",
          exitCode: 0,
        };
      }

      if (sqlFiles.length === 0) {
        return {
          success: true,
          message: "Migration journal check skipped (no SQL files)",
          exitCode: 0,
        };
      }

      let journalEntries: JournalEntry[];
      try {
        const raw = String(await readFile(join(metaDir, "_journal.json"), "utf-8"));
        const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
        journalEntries = parsed.entries ?? [];
      } catch {
        return {
          success: false,
          message: "Migration journal check failed: could not read meta/_journal.json",
          exitCode: 1,
        };
      }

      const result = detectMissingJournalEntries(sqlFiles, journalEntries);

      if (result.success) {
        return { success: true, message: result.message, exitCode: 0 };
      }

      log.cli("");
      log.cli(result.message);
      log.cli("");

      return { success: false, message: "Migration journal consistency check failed", exitCode: 1 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Migration journal check error: ${msg}`, exitCode: 1 };
    }
  }

  /**
   * Block staged modifications to already-applied SQL migration files (mt#2268).
   *
   * Drizzle records sha256(full .sql) at apply-time; editing an applied
   * migration causes it to re-apply on the next `migrate --execute`, silently
   * drifting the ledger from actual DB state (mt#1641/mt#2250 root cause).
   *
   * Only staged MODIFICATIONS are blocked — additions are the correct path for
   * new migrations and are always allowed.
   *
   * Override: setting `MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK` to `1` / `true`
   * / `yes` skips the check and emits a one-line audit message to stdout.
   * Use only for the rare legitimate case (e.g. fixing a never-applied
   * migration before its first deploy).
   */
  private async runImmutableMigrationCheck(): Promise<HookResult> {
    if (isImmutableMigrationOverrideTruthy(process.env[IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:immutable-migration] override ${IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV}=${process.env[IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — immutable-migration check skipped`
      );
      return {
        success: true,
        message: "Immutable-migration check skipped via override",
        exitCode: 0,
      };
    }

    try {
      // Get staged files with their status. We include renames (R) as well as
      // modifications (M): a rename-with-edit of an applied migration would
      // otherwise slip past an M-only filter (mt#2268 review). `--name-status`
      // output is `<status>\t<path>` for M, and `R<score>\t<old>\t<new>` for
      // renames — for a rename we flag the OLD (applied) path.
      const result = await execGitWithTimeout(
        "diff",
        "diff --cached --name-status --diff-filter=MR",
        {
          workdir: this.projectRoot,
          timeout: 5000,
        }
      );

      const statusLines = result.stdout.toString().trim().split("\n").filter(Boolean);

      if (statusLines.length === 0) {
        return {
          success: true,
          message: "Immutable-migration check passed (no staged modifications)",
          exitCode: 0,
        };
      }

      // Build staged modifications map (path -> 'M'). Renames map their OLD path
      // to 'M' so the detector treats moving an applied migration as a violation.
      const stagedModifications = new Map<string, string>();
      for (const line of statusLines) {
        const parts = line.split("\t");
        const status = parts[0] ?? "";
        if (status.startsWith("R") && parts.length >= 3) {
          // Rename: parts = [R<score>, oldPath, newPath] — flag the old (applied) path.
          stagedModifications.set(parts[1] as string, "M");
        } else if (status === "M" && parts[1]) {
          stagedModifications.set(parts[1] as string, "M");
        }
      }
      if (stagedModifications.size === 0) {
        return {
          success: true,
          message: "Immutable-migration check passed (no staged modifications)",
          exitCode: 0,
        };
      }

      // Load journal tags for each migration directory.
      const journalTagsByDir = new Map<string, ReadonlySet<string>>();
      for (const dir of MIGRATION_DIRS) {
        const journalPath = join(this.projectRoot, dir, "meta", "_journal.json");
        try {
          const raw = String(await readFile(journalPath, "utf-8"));
          const parsed = JSON.parse(raw) as { entries?: Array<{ tag: string }> };
          const tags = new Set((parsed.entries ?? []).map((e) => e.tag));
          journalTagsByDir.set(dir, tags);
        } catch {
          // No journal for this dir — skip (e.g. dir doesn't exist yet)
        }
      }

      const violations = detectImmutableMigrationViolations(stagedModifications, journalTagsByDir);

      if (violations.length === 0) {
        return {
          success: true,
          message: "Immutable-migration check passed",
          exitCode: 0,
        };
      }

      log.cli("");
      log.cli(
        `${violations.length} applied migration file(s) staged for modification. Commit blocked.`
      );
      log.cli("");
      for (const v of violations) {
        log.cli(`   ${v.filePath}  (tag: ${v.tag})`);
      }
      log.cli("");
      log.cli("Why this is blocked:");
      log.cli(
        "   Applied migrations are IMMUTABLE. Drizzle records sha256(full .sql) at apply-time;"
      );
      log.cli("   editing an applied file causes it to re-apply on the next migrate --execute,");
      log.cli("   silently drifting the schema ledger from actual DB state.");
      log.cli("   Originating incidents: mt#1641, mt#2250 (migrations 0002/0014/0015).");
      log.cli("");
      log.cli("To fix: write a NEW migration that makes the desired schema change.");
      log.cli("   Run `bun run db:generate:pg` to generate it.");
      log.cli("   See .minsky/rules/migration-authoring.mdc for the canonical workflow.");
      log.cli("");
      log.cli(`If a modification is genuinely legitimate (e.g. fixing a never-applied migration),`);
      log.cli(
        `set ${IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV}=1 to override. The skip is audit-logged.`
      );
      return {
        success: false,
        message: `Immutable-migration check failed: ${violations.length} applied migration(s) staged for modification`,
        exitCode: 1,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Immutable-migration check failed: ${errorMsg}`);
      return {
        success: false,
        message: `Immutable-migration check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Run the deploy-domain ownership check (mt#2208, live successor to mt#2193).
   *
   * Verifies every domain ASSERTED as a deployment target in deploy/site config
   * is a domain we control (listed in `infra/controlled-domains.json`). Covers
   * `infra/index.ts` (SITE_URL etc.), `services/<svc>/deploy.config.ts`,
   * `services/<svc>/astro.config.ts`, and "Deployed at"/"serves at" claims in
   * `services/<svc>/README.md`.
   *
   * Originating incident (2026-05-31): `minsky.dev`, an illustrative example URL
   * from Jul-2025 analysis prose, hardened into authoritative deploy config and a
   * false "Deployed at" README claim with no ownership-verification step; an agent
   * later read it back as ground truth. `minsky.dev` is registered to a third
   * party (verified via Cloudflare API + RDAP + crt.sh).
   *
   * The detector strips comments before extracting domains from code files and
   * only extracts phrase-anchored domains from markdown, so the corrected repo's
   * WARNING-comment mentions of `minsky.dev` ("do not set this to a domain we do
   * not control") do not trip the check.
   *
   * Override: setting `MINSKY_SKIP_DEPLOY_DOMAIN_CHECK` to `1` / `true` / `yes`
   * skips the check and emits a one-line audit message. Use only when the
   * domain is genuinely controlled but not yet allowlisted AND the allowlist
   * entry is being added separately.
   *
   * See `src/hooks/deploy-domain-detector.ts` for the pure-function detector
   * this method wraps.
   */
  private async runDeployDomainCheck(): Promise<HookResult> {
    if (isDeployDomainOverrideTruthy(process.env[DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:deploy-domain-check] override ${DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV}=${process.env[DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — deploy-domain ownership check skipped`
      );
      return {
        success: true,
        message: "Deploy-domain check skipped via override",
        exitCode: 0,
      };
    }

    try {
      const result = runDeployDomainDetector(this.projectRoot);

      // null = no allowlist file => check inapplicable for this repo. Silent pass.
      if (result === null) {
        return {
          success: true,
          message: "Deploy-domain check inapplicable (no infra/controlled-domains.json)",
          exitCode: 0,
        };
      }

      if (result.violations.length === 0) {
        return {
          success: true,
          message: `Deploy-domain check passed (${result.scannedFiles.length} file(s) scanned)`,
          exitCode: 0,
        };
      }

      log.cli("");
      log.cli(`${result.violations.length} deploy-domain ownership violation(s). Commit blocked.`);
      log.cli("");
      for (const v of result.violations) {
        log.cli(`   ${v.filePath}:${v.line} asserts deploy domain "${v.host}" (apex: ${v.apex})`);
        log.cli(`     not in infra/controlled-domains.json`);
        if (v.excerpt) {
          log.cli(`     > ${v.excerpt}`);
        }
      }
      log.cli("");
      log.cli("Why this is blocked:");
      log.cli("   - Tracking task:        mt#2208 (live successor to mt#2193)");
      log.cli(
        "   - Originating incident: minsky.dev hardened into config, never ownership-verified"
      );
      log.cli("   - Bridge memory:        ac1a6761 (assertion-without-verification family)");
      log.cli("");
      log.cli("A domain asserted as a deploy target must be one we actually control.");
      log.cli("   If you DO control this domain, verify it (e.g. confirm it is a zone in");
      log.cli("   our Cloudflare account) and add its apex/host to infra/controlled-domains.json.");
      log.cli("");
      log.cli(
        `If the domain is controlled but not yet allowlisted, set ${DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV}=1 to override.`
      );
      log.cli("   The skip is audit-logged to stdout.");
      return {
        success: false,
        message: `Deploy-domain check failed: ${result.violations.length} uncontrolled domain assertion(s)`,
        exitCode: 1,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Deploy-domain check failed: ${errorMsg}`);
      return {
        success: false,
        message: `Deploy-domain check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Run unit tests
   */
  private async runUnitTests(): Promise<HookResult> {
    log.cli("🧪 MANDATORY: Running unit test suite...");
    log.cli("  → Executing unit tests with timeout (excluding integration tests)...");

    try {
      await execAsync(
        // mt#2608: packages/domain (336 test files, the mt#2108 extraction
        // target) had zero pre-commit coverage until this line added it.
        "AGENT=1 bun test --preload ./tests/setup.ts --timeout=15000 --bail ./src ./tests/adapters ./tests/domain ./packages/domain",
        {
          cwd: this.projectRoot,
          timeout: 120000, // mt#2608: packages/domain adds ~40s; bump budget accordingly
          env: { ...process.env, AGENT: "1" },
        }
      );
      log.cli("✅ All tests passing! Test suite validation completed.");
      return { success: true, message: "Unit tests passed", exitCode: 0 };
    } catch (error) {
      log.cli("");
      log.cli("❌ ❌ ❌ TESTS FAILED! COMMIT BLOCKED! ❌ ❌ ❌");
      log.cli("");
      log.cli("🚫 One or more tests are failing. Fix ALL test failures before committing.");
      log.cli("💡 Run 'bun run test' locally to see detailed failure information.");
      log.cli("🔧 Ensure your changes don't break existing functionality.");
      log.cli("");
      log.cli("📋 Common fixes:");
      log.cli("   • Update test expectations if behavior intentionally changed");
      log.cli("   • Fix bugs in your code that break existing tests");
      log.cli("   • Add missing mocks or dependencies");
      log.cli("   • Check for import/export issues");
      return { success: false, message: "Unit tests failed", exitCode: 1 };
    }
  }

  /**
   * Run TypeScript type checking
   */
  private async runTypeCheck(): Promise<HookResult> {
    log.cli("🔎 Running TypeScript type check...");

    try {
      await execAsync("bunx @typescript/native-preview --noEmit", {
        cwd: this.projectRoot,
        timeout: 60000,
      });
      log.cli("✅ TypeScript compilation passed — no type errors.");
      return { success: true, message: "Type check passed", exitCode: 0 };
    } catch (error: unknown) {
      const err = error as { stdout?: string; message?: string };
      const output = err.stdout || err.message || String(error);
      log.cli("❌ TypeScript type errors found! Commit blocked.");
      log.cli(output);
      return { success: false, message: "TypeScript type check failed", exitCode: 1 };
    }
  }

  /**
   * Run test pattern validation (placeholder - keep existing bash logic for now)
   */
  private async runTestPatternValidation(): Promise<HookResult> {
    log.cli("🔍 Checking for test anti-patterns...");
    log.cli("✅ Test pattern validation completed.");
    return { success: true, message: "Test pattern validation passed", exitCode: 0 };
  }

  /**
   * Check that all shebang-bearing entry points staged for commit have execute permission.
   * Covers .claude/hooks/*.ts (hook files) and scripts/cli-entry.ts (CLI binary entry).
   */
  private async runHookPermissionCheck(): Promise<HookResult> {
    log.cli("🔐 Checking hook file permissions...");

    try {
      const result = await execGitWithTimeout(
        "diff",
        "diff --cached --name-only --diff-filter=ACM",
        { workdir: this.projectRoot, timeout: 5000 }
      );

      const stagedFiles = result.stdout.toString().trim().split("\n").filter(Boolean);
      const executableEntryPoints = stagedFiles.filter(
        (f) => (f.startsWith(".claude/hooks/") && f.endsWith(".ts")) || f === "scripts/cli-entry.ts"
      );

      if (executableEntryPoints.length === 0) {
        log.cli("✅ No executable entry points staged.");
        return { success: true, message: "No executable entry points to check", exitCode: 0 };
      }

      const nonExecutable: string[] = [];
      for (const file of executableEntryPoints) {
        // Use fs.stat programmatically instead of `execAsync("test -x \"${file}\" ...")`
        // (mt#1829): file paths from `git diff --cached --name-only` are
        // git-controlled and may contain shell metacharacters. Programmatic
        // stat avoids /bin/sh entirely. mode & 0o100 checks the owner-execute
        // bit, which matches `test -x` for files the developer owns.
        //
        // PR #1122 R1: paths from `git diff` are repository-relative, so resolve
        // them against projectRoot before stat. The prior execAsync call used
        // `cwd: this.projectRoot` which made the shell resolve relative paths;
        // fs.stat resolves against process.cwd() so we must join explicitly.
        let mode: number | undefined;
        try {
          const st = await stat(join(this.projectRoot, file));
          mode = st.mode;
        } catch (err) {
          // ENOENT = file staged-then-deleted in the working tree between
          // diff and stat. Treat as "no check needed"; the git index will
          // commit whatever permission is recorded there.
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            continue;
          }
          throw err;
        }
        if ((mode & 0o100) === 0) {
          nonExecutable.push(file);
        }
      }

      if (nonExecutable.length > 0) {
        log.cli("❌ Executable entry points missing execute permission! Commit blocked.");
        log.cli(`🔧 Fix with: chmod +x ${nonExecutable.join(" ")}`);
        return {
          success: false,
          message: `Files missing +x: ${nonExecutable.join(", ")}`,
          exitCode: 1,
        };
      }

      log.cli("✅ All executable entry points have execute permission.");
      return { success: true, message: "Execute permission check passed", exitCode: 0 };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ Hook permission check failed: ${errorMsg}`);
      return { success: false, message: `Hook permission check failed: ${errorMsg}`, exitCode: 1 };
    }
  }

  /**
   * Run code formatting
   */
  private async runCodeFormatting(): Promise<HookResult> {
    log.cli("🎨 Running code formatter...");

    try {
      await execAsync("bunx lint-staged", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ Code formatting completed.");
      return { success: true, message: "Code formatting passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ Code formatting failed! Please check for syntax errors.");
      return { success: false, message: "Code formatting failed", exitCode: 1 };
    }
  }

  /**
   * Run ESLint rule tooling tests
   */
  private async runESLintRuleTests(): Promise<HookResult> {
    log.cli("🔧 Running ESLint rule tooling tests...");

    try {
      await execAsync("AGENT=1 bun test eslint-rules/fixtures-test.test.js --timeout=5000", {
        cwd: this.projectRoot,
        timeout: 15000,
        env: { ...process.env, AGENT: "1" },
      });
      log.cli("✅ ESLint rule tooling tests completed.");
      return { success: true, message: "ESLint rule tests passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ ESLint rule tooling tests failed! Please fix the fixture validation.");
      return { success: false, message: "ESLint rule tests failed", exitCode: 1 };
    }
  }

  /**
   * Run rules compile --check for compile targets whose output files already exist
   * and were generated by the compiler.
   *
   * Only checks targets that the project has already opted into:
   * - agents.md: if AGENTS.md exists and starts with the generation header
   * - claude.md: if CLAUDE.md exists and starts with the generation header
   * - cursor-rules: if .cursor/rules/ directory exists with .mdc files
   */
  private async runRulesCompileCheck(): Promise<HookResult> {
    log.cli("📋 Checking rules compile outputs are up-to-date...");

    const COMPILE_HEADER = "<!-- Generated by minsky rules compile.";

    // Determine which targets to check based on what's opted in
    const targetsToCheck: string[] = [];

    // Check agents.md
    try {
      const agentsContent = await (
        await import("fs/promises")
      ).readFile(`${this.projectRoot}/AGENTS.md`, "utf-8");
      if (String(agentsContent).startsWith(COMPILE_HEADER)) {
        targetsToCheck.push("agents.md");
      }
    } catch {
      // File doesn't exist or isn't readable — skip
    }

    // Check claude.md
    try {
      const claudeContent = await (
        await import("fs/promises")
      ).readFile(`${this.projectRoot}/CLAUDE.md`, "utf-8");
      if (String(claudeContent).startsWith(COMPILE_HEADER)) {
        targetsToCheck.push("claude.md");
      }
    } catch {
      // File doesn't exist or isn't readable — skip
    }

    // Check cursor-rules (if .cursor/rules/ has any .mdc files)
    try {
      const fsp = await import("fs/promises");
      const entries = await fsp.readdir(`${this.projectRoot}/.cursor/rules`);
      if (entries.some((e) => e.endsWith(".mdc"))) {
        targetsToCheck.push("cursor-rules");
      }
    } catch {
      // Directory doesn't exist — skip
    }

    if (targetsToCheck.length === 0) {
      log.cli("✅ No compiled rule outputs detected — skipping rules compile check.");
      return { success: true, message: "No compile targets to check", exitCode: 0 };
    }

    for (const target of targetsToCheck) {
      try {
        // mt#1829: `target` is from the locally-built `targetsToCheck` array
        // which contains only the hardcoded values "claude.md", "agents.md",
        // and "cursor-rules" (set earlier in this function from
        // existsSync/readdir checks). Bounded enum, no shell metacharacters
        // possible — no safeShellQuote needed.
        await execAsync(`bun run src/cli.ts rules compile --check --target ${target}`, {
          cwd: this.projectRoot,
          timeout: 30000,
        });
      } catch (error) {
        const result = classifyCompileCheckError(error, target);
        for (const line of result.logLines) {
          log.cli(line);
        }
        return { success: false, message: result.message, exitCode: 1 };
      }
    }

    log.cli(`✅ All rules compile outputs are up-to-date (${targetsToCheck.join(", ")}).`);
    return { success: true, message: "Rules compile check passed", exitCode: 0 };
  }

  /**
   * Run `compile --check` for the NEW definition-compile system's targets
   * (distinct from the legacy `rules compile` system handled by
   * runRulesCompileCheck). This closes the mt#2182 gap: the `claude-skills`
   * target silently skipped all sources for weeks with no staleness guard.
   *
   * Targets checked (opted in when their `.minsky/` source dir exists):
   * - `claude-skills`  (.minsky/skills/) — the mt#2182 originating target.
   * - `cursor-rules-ts` (.minsky/rules/) — verified in sync as of mt#2252.
   * - `claude-agents`  (.minsky/agents/) — enabled by mt#2497 after the
   *   source↔output drift was reconciled (auditor/reviewer/fixture sources
   *   regenerated to reproduce their committed outputs). Before mt#2497 this
   *   was excluded because the outputs were richer than their sources, so a
   *   recompile silently reverted ~130 lines of mt#1551/#1606/#1611 content;
   *   the gap let that drift accumulate unguarded. mt#2497 subsumes the prior
   *   tracking task mt#1654 ("Reconcile agent source-of-truth split").
   */
  private async runCompileCheck(): Promise<HookResult> {
    log.cli(
      "📋 Checking compile outputs are up-to-date (claude-skills, cursor-rules-ts, claude-agents)..."
    );

    const fsp = await import("fs/promises");
    const dirExists = async (p: string): Promise<boolean> => {
      try {
        await fsp.access(p);
        return true;
      } catch {
        return false;
      }
    };
    const targetsToCheck = compileCheckTargets({
      skills: await dirExists(`${this.projectRoot}/.minsky/skills`),
      rules: await dirExists(`${this.projectRoot}/.minsky/rules`),
      agents: await dirExists(`${this.projectRoot}/.minsky/agents`),
    });

    if (targetsToCheck.length === 0) {
      log.cli("✅ No new-compile-system outputs detected — skipping compile check.");
      return { success: true, message: "No compile targets to check", exitCode: 0 };
    }

    for (const target of targetsToCheck) {
      try {
        // `target` is from the locally-built `targetsToCheck` array which
        // contains only the hardcoded literals "claude-skills",
        // "cursor-rules-ts", and "claude-agents". Bounded enum, no shell
        // metacharacters — no safeShellQuote needed (mirrors
        // runRulesCompileCheck / mt#1829).
        await execAsync(`bun run src/cli.ts compile --check --target ${target}`, {
          cwd: this.projectRoot,
          timeout: 30000,
        });
      } catch (error) {
        const result = classifyCompileCheckError(error, target, "compile");
        for (const line of result.logLines) {
          log.cli(line);
        }
        return { success: false, message: result.message, exitCode: 1 };
      }
    }

    log.cli(`✅ All compile outputs are up-to-date (${targetsToCheck.join(", ")}).`);
    return { success: true, message: "Compile check passed", exitCode: 0 };
  }
}

/**
 * Maps which `.minsky/` source dirs are present to the compile targets the
 * pre-commit check verifies. Each target is opted in only when its source dir
 * exists, so repos without a given source tree skip that check. Pure +
 * exported for unit testing (mt#2497).
 */
export function compileCheckTargets(present: {
  skills: boolean;
  rules: boolean;
  agents: boolean;
}): string[] {
  const targets: string[] = [];
  if (present.skills) targets.push("claude-skills");
  if (present.rules) targets.push("cursor-rules-ts");
  if (present.agents) targets.push("claude-agents");
  return targets;
}

/**
 * Classify a failed compile-check subprocess error as either genuine staleness
 * or an unrelated compile-command error (e.g., setup-incomplete). Serves BOTH
 * compile systems via `kind`: the legacy `rules compile --check` (kind="rules")
 * and the new `compile --check` (kind="compile"). All user-facing hints derive
 * the command name from `kind` so they never name the wrong system.
 *
 * When the CLI detects stale output it prints a `[<cmd> --check] ... is STALE`
 * marker to stdout before throwing. Any other non-zero exit means the compile
 * command itself failed — telling the operator to "regenerate" would be
 * misleading because the same error will recur.
 *
 * Exported for unit testing; not part of the public hook API.
 */
export function classifyCompileCheckError(
  error: unknown,
  target: string,
  // Which compile system emitted the check: the legacy `rules compile` command
  // or the new `compile` command. Determines both the STALE-marker prefix to
  // match and the regenerate hint to print. Defaults to "rules" for backward
  // compatibility with existing callers/tests.
  kind: "rules" | "compile" = "rules"
): { logLines: string[]; message: string } {
  const execError = error as { stdout?: string; stderr?: string };
  const stdout = execError.stdout ?? "";
  const stderr = execError.stderr ?? "";

  // The two CLIs emit a marker line of the exact form:
  //   [rules compile --check] Target "<target>" is STALE   (legacy)
  //   [compile --check] Target "<target>" is STALE          (new)
  // to stdout only when output is verified out-of-date. Match this with a
  // per-target line-anchored regex so near-misses (a STALE marker for a
  // different target, or incidental prose) do not count.
  const cmd = kind === "rules" ? "rules compile" : "compile";
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const staleLineRe = new RegExp(`\\[${cmd} --check\\] Target "${escapedTarget}" is STALE`, "m");
  const isGenuinelyStale = staleLineRe.test(stdout);

  if (isGenuinelyStale) {
    return {
      logLines: [
        `❌ Compile output for target "${target}" is stale.`,
        `💡 Run "bun run minsky ${cmd} --target ${target}" to regenerate.`,
      ],
      message: `Compile output for target "${target}" is stale`,
    };
  }

  // Compile command errored. Surface the actual error so the operator knows
  // what to fix — re-running the compile command will NOT help.
  const rawDetail = stderr.trim() || stdout.trim();
  const errorDetail = rawDetail || (error instanceof Error ? error.message : String(error));

  // Detect setup-incomplete: the CLI emits "Validation error: Developer setup incomplete"
  // when the Minsky setup has not been run. Telling the operator to "regenerate" is
  // misleading in that case — the correct action is to run the setup command.
  const isSetupIncomplete = /Validation error: Developer setup incomplete/i.test(errorDetail);

  const indented = errorDetail
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");

  if (isSetupIncomplete) {
    return {
      logLines: [
        `❌ Compile check for target "${target}" failed: developer setup is incomplete.`,
        indented,
        `💡 Run "minsky setup --client <client-name>" to complete setup, then retry the commit.`,
        `   (Re-running "${cmd}" will NOT fix this — the setup must be completed first.)`,
      ],
      message: `Compile check for target "${target}" failed: developer setup incomplete`,
    };
  }

  return {
    logLines: [
      `❌ Compile check for target "${target}" failed (not a staleness issue):`,
      indented,
      `💡 Fix the error above before retrying. ("${cmd}" will NOT fix this.)`,
    ],
    message: `Compile check for target "${target}" failed: ${errorDetail.split("\n")[0]}`,
  };
}

// CLI entry point
if (import.meta.main) {
  const hook = new PreCommitHook();
  hook
    .run()
    .then((result) => {
      process.exit(result.exitCode);
    })
    .catch((error) => {
      log.error("❌ Pre-commit hook crashed:", error);
      process.exit(1);
    });
}
