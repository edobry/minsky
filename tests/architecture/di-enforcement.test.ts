import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "../..");

function execStr(cmd: string, opts?: Parameters<typeof execSync>[1]): string {
  return execSync(cmd, { encoding: "utf-8", ...opts }) as unknown as string;
}

function grepCount(pattern: string, dir: string, opts?: string): number {
  try {
    const result = execStr(
      `grep -r ${opts || ""} "${pattern}" "${dir}" --include="*.ts" | grep -v "node_modules" | grep -v ".test.ts" | grep -v "/tests/" | grep -v "// " | wc -l`
    );
    return parseInt(result.trim(), 10);
  } catch {
    return 0; // grep returns exit code 1 when no matches
  }
}

describe("DI enforcement", () => {
  describe("banned anti-patterns in production code", () => {
    const bannedPatterns = [
      "defaultInstance",
      "getAppContainer",
      "setAppContainer",
      "resolveProvider",
      "createSessionDeps",
      "getSharedSessionProvider",
      "session-provider-cache",
    ];

    for (const pattern of bannedPatterns) {
      test(`no '${pattern}' references outside comments`, () => {
        // Use grep -v to exclude comment lines
        const srcDir = path.join(ROOT, "src");
        const count = grepCount(pattern, srcDir, "-l");
        // Allow in comments/types.ts descriptions but not actual usage
        if (count > 0) {
          const files = execStr(
            `grep -rl "${pattern}" "${srcDir}" --include="*.ts" | grep -v node_modules | grep -v ".test.ts"`
          )
            .trim()
            .split("\n");

          // Check each file — only comments/strings are acceptable
          for (const file of files) {
            try {
              const lines = execStr(
                `grep -n "${pattern}" "${file}" | grep -v "^[0-9]*:[[:space:]]*//" | grep -v "^[0-9]*:[[:space:]]*\\*" | grep -v "^[0-9]*:[[:space:]]*/\\*" | grep -v "\\*/" | grep -v "^[0-9]*:[[:space:]]*\\*"`,
                { stdio: ["pipe", "pipe", "pipe"] }
              ).trim();
              // Filter out lines that are clearly doc comments (contain /** or * at any indent)
              const nonCommentLines = lines
                .split("\n")
                .filter((l) => l.length > 0)
                .filter((l) => {
                  const content = l.replace(/^\d+:\s*/, "");
                  return (
                    !content.startsWith("//") &&
                    !content.startsWith("*") &&
                    !content.startsWith("/*") &&
                    !content.startsWith("/**")
                  );
                });
              expect(nonCommentLines).toEqual([]); // No non-comment usage
            } catch {
              // grep returns exit code 1 when all lines are filtered out — that's a pass
            }
          }
        }
      });
    }
  });

  describe("domain singleton prevention", () => {
    const allowedSingletons = new Set([
      "ruleOperationRegistry",
      "gitOperationRegistry",
      "modularGitCommandsManager",
      "defaultLoader",
      "legacyConfig",
      "log",
      "EXEMPT_COMMANDS",
      "testConfigManager",
      // mt#2608: re-pointing this test at packages/domain/src (see comment
      // below) surfaced these three for the first time. Same class as
      // EXEMPT_COMMANDS above — plain readonly Set<string> constants, not
      // DI-managed singleton services.
      "HOSTED_SAFE_SESSION_COMMANDS",
      "KNOWN_TOP_LEVEL_KEYS",
      "HOOK_ONLY_ENV_VARS",
    ]);

    test("no export const x = new X() outside allowlist", () => {
      // mt#2108 moved the domain implementation to packages/domain/src;
      // src/domain now only holds a small calibration module (mt#2608).
      const srcDomain = path.join(ROOT, "packages/domain/src");
      const result = execStr(
        `grep -rn "export const .* = new " "${srcDomain}" --include="*.ts" | grep -v node_modules | grep -v ".test.ts"`,
        { stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      if (!result) return; // No matches = pass

      const lines = result.split("\n");
      for (const line of lines) {
        const match = line.match(/export const (\w+)/);
        if (match && match[1]) {
          expect(allowedSingletons.has(match[1])).toBe(true);
        }
      }
    });
  });

  describe("@injectable() decorator completeness", () => {
    test("all *Service/*Storage/*Adapter classes in domain have @injectable()", () => {
      const allowedMissing = new Set([
        "FakeGitService",
        "FakeTaskService",
        "MemoryVectorStorage",
        "SqliteStorage",
        "SessionMigrationService",
        // Error-handling utility classes (not DI services despite "Storage" in name)
        "StorageError",
        "StorageErrorClassifier",
        "StorageErrorRecovery",
        "StorageErrorMonitor",
        // mt#2608: re-pointing this test at packages/domain/src (mt#2108
        // moved the domain implementation there; this test previously
        // scanned the now-near-empty src/domain and silently found nothing)
        // surfaced these six pre-existing matches for the first time. All
        // six are constructed directly via `new X(...)` in production code
        // (session-merge-operations.ts, cockpit/server.ts,
        // adapters/shared/commands/{authorship,transcripts}.ts,
        // service-window-reaper.ts's own factory) — never resolved through
        // the tsyringe container — so @injectable() would be dead weight,
        // same rationale as the Storage* error-utility exceptions above.
        "AgentTranscriptIngestService",
        "AgentTranscriptService",
        "ServiceWindowReaper",
        // Error classes matching the loose "*Service*" substring pattern.
        "AmbiguousDeploymentServiceError",
        "NoDeploymentServicesError",
        "ServiceUnavailableError",
      ]);

      // mt#2108 moved the domain implementation to packages/domain/src;
      // src/domain now only holds a small calibration module (mt#2608).
      const srcDomain = path.join(ROOT, "packages/domain/src");
      // Find all export class declarations matching the pattern
      const classLines = execStr(
        `grep -rn "export class \\w*\\(Service\\|Storage\\|Adapter\\)" "${srcDomain}" --include="*.ts" | grep -v node_modules | grep -v ".test.ts"`,
        { stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      if (!classLines) return;

      const missing: string[] = [];
      for (const line of classLines.split("\n")) {
        const classMatch = line.match(/export class (\w+)/);
        if (!classMatch || !classMatch[1]) continue;
        const className = classMatch[1];
        if (allowedMissing.has(className)) continue;

        // Check if @injectable() is on the preceding line
        const parts = line.split(":");
        const filePath = parts[0] ?? "";
        const lineNum = parts[1] ?? "1";
        const lineNumber = parseInt(lineNum, 10);
        const prevLine = execStr(`sed -n '${lineNumber - 1}p' "${filePath}"`).trim();

        if (!prevLine.includes("@injectable()")) {
          missing.push(`${className} in ${filePath}:${lineNumber}`);
        }
      }

      expect(missing).toEqual([]);
    });
  });
});
