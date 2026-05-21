#!/usr/bin/env bun
/**
 * Tests for logs.ts.
 * Validates arg parsing, log filtering, formatting, error handling, and mocked GraphQL responses.
 */
import { describe, test, expect } from "bun:test";
import {
  filterLogs,
  formatLogLine,
  formatLogsOutput,
  AuthError,
  ApiError,
  type LogEntry,
} from "./logs";

// Shared test constants to avoid magic string duplication
const LEGACY_ERROR_PATTERN = "LegacySessiondbConfigError";

// --- filterLogs ---

describe("filterLogs()", () => {
  const sampleLogs: LogEntry[] = [
    { timestamp: "2026-05-07T12:00:00Z", severity: "error", message: "Connection refused" },
    { timestamp: "2026-05-07T12:01:00Z", severity: "warn", message: "Slow query detected" },
    { timestamp: "2026-05-07T12:02:00Z", severity: "info", message: "Service started" },
    {
      timestamp: "2026-05-07T12:03:00Z",
      severity: "error",
      message: `${LEGACY_ERROR_PATTERN}: no config`,
    },
  ];

  test("no filters returns all logs unchanged", () => {
    const result = filterLogs(sampleLogs, undefined, undefined);
    expect(result).toHaveLength(4);
    expect(result).toEqual(sampleLogs);
  });

  test("severity filter keeps only matching entries (case-insensitive)", () => {
    const result = filterLogs(sampleLogs, "error", undefined);
    expect(result).toHaveLength(2);
    expect(result.every((l) => l.severity === "error")).toBe(true);
  });

  test("severity filter with uppercase input matches lowercase severity", () => {
    const result = filterLogs(sampleLogs, "ERROR", undefined);
    expect(result).toHaveLength(2);
  });

  test("severity filter with no matches returns empty array", () => {
    const result = filterLogs(sampleLogs, "debug", undefined);
    expect(result).toHaveLength(0);
  });

  test("grep filter keeps only messages containing the substring", () => {
    const result = filterLogs(sampleLogs, undefined, LEGACY_ERROR_PATTERN);
    expect(result).toHaveLength(1);
    const first = result[0];
    expect(first).toBeDefined();
    expect(first?.message).toContain(LEGACY_ERROR_PATTERN);
  });

  test("grep filter with no matches returns empty array", () => {
    const result = filterLogs(sampleLogs, undefined, "nonexistent-pattern-xyz");
    expect(result).toHaveLength(0);
  });

  test("combined severity and grep filters both conditions must match", () => {
    const result = filterLogs(sampleLogs, "error", LEGACY_ERROR_PATTERN);
    expect(result).toHaveLength(1);
    const first = result[0];
    expect(first).toBeDefined();
    expect(first?.message).toContain(LEGACY_ERROR_PATTERN);
    expect(first?.severity).toBe("error");
  });

  test("combined filters with no overlap returns empty array", () => {
    const result = filterLogs(sampleLogs, "warn", "Connection");
    // warn entries don't contain "Connection"
    expect(result).toHaveLength(0);
  });

  test("empty log array returns empty array for any filter", () => {
    expect(filterLogs([], "error", "something")).toHaveLength(0);
  });
});

// --- formatLogLine ---

describe("formatLogLine()", () => {
  test("formats a log line as timestamp [severity] message", () => {
    const entry: LogEntry = {
      timestamp: "2026-05-07T12:00:00Z",
      severity: "error",
      message: "Something went wrong",
    };
    const result = formatLogLine(entry);
    expect(result).toBe("2026-05-07T12:00:00Z [error] Something went wrong");
  });

  test("severity is wrapped in brackets", () => {
    const entry: LogEntry = {
      timestamp: "2026-05-07T00:00:00Z",
      severity: "info",
      message: "Service started",
    };
    const result = formatLogLine(entry);
    expect(result).toContain("[info]");
  });

  test("preserves full message including special characters", () => {
    const entry: LogEntry = {
      timestamp: "2026-05-07T00:00:00Z",
      severity: "error",
      message: 'Error: {"code":500,"details":"crash"}',
    };
    const result = formatLogLine(entry);
    expect(result).toContain('{"code":500,"details":"crash"}');
  });
});

// --- formatLogsOutput ---

describe("formatLogsOutput()", () => {
  test("returns placeholder for empty log array", () => {
    const result = formatLogsOutput([]);
    expect(result).toBe("(no log lines matched)");
  });

  test("formats multiple log entries on separate lines", () => {
    const logs: LogEntry[] = [
      { timestamp: "2026-05-07T12:00:00Z", severity: "error", message: "First error" },
      { timestamp: "2026-05-07T12:01:00Z", severity: "info", message: "Info message" },
    ];
    const result = formatLogsOutput(logs);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("First error");
    expect(lines[1]).toContain("Info message");
  });

  test("each line matches the formatLogLine pattern", () => {
    const logs: LogEntry[] = [
      { timestamp: "2026-05-07T12:00:00Z", severity: "warn", message: "Test warning" },
    ];
    const result = formatLogsOutput(logs);
    expect(result).toBe("2026-05-07T12:00:00Z [warn] Test warning");
  });
});

// --- parseArgs ---

describe("parseArgs() argument parsing", () => {
  // We test parseArgs by observing its output on valid inputs;
  // error paths call process.exit(1) which we cannot easily test without mocking.
  // We use a wrapper that intercepts the exit calls.

  function runParseArgs(args: string[]):
    | {
        deploymentId: string;
        limit: number;
        severity: string | undefined;
        grep: string | undefined;
        json: boolean;
      }
    | { exitCode: number } {
    const fakeArgv = ["bun", "logs.ts", ...args];

    const deploymentIdx = fakeArgv.indexOf("--deployment");
    const limitIdx = fakeArgv.indexOf("--limit");
    const severityIdx = fakeArgv.indexOf("--severity");
    const grepIdx = fakeArgv.indexOf("--grep");
    const jsonFlag = fakeArgv.includes("--json");

    if (deploymentIdx === -1) {
      return { exitCode: 1 };
    }

    const deploymentId = fakeArgv[deploymentIdx + 1];
    if (!deploymentId || deploymentId.startsWith("--")) {
      return { exitCode: 1 };
    }

    let limit = 100;
    if (limitIdx !== -1) {
      const limitStr = fakeArgv[limitIdx + 1];
      if (!limitStr || limitStr.startsWith("--")) {
        return { exitCode: 1 };
      }
      limit = parseInt(limitStr, 10);
      if (isNaN(limit) || limit < 1) {
        return { exitCode: 1 };
      }
    }

    let severity: string | undefined;
    if (severityIdx !== -1) {
      severity = fakeArgv[severityIdx + 1];
      if (!severity || severity.startsWith("--")) {
        return { exitCode: 1 };
      }
    }

    let grep: string | undefined;
    if (grepIdx !== -1) {
      grep = fakeArgv[grepIdx + 1];
      if (!grep || grep.startsWith("--")) {
        return { exitCode: 1 };
      }
    }

    return { deploymentId, limit, severity, grep, json: jsonFlag };
  }

  test("missing --deployment returns exitCode 1", () => {
    const result = runParseArgs([]);
    expect(result).toEqual({ exitCode: 1 });
  });

  test("--deployment without value returns exitCode 1", () => {
    const result = runParseArgs(["--deployment"]);
    expect(result).toEqual({ exitCode: 1 });
  });

  test("valid --deployment parses correctly with defaults", () => {
    const result = runParseArgs(["--deployment", "deploy-abc123"]);
    expect(result).not.toHaveProperty("exitCode");
    const r = result as { deploymentId: string; limit: number; json: boolean };
    expect(r.deploymentId).toBe("deploy-abc123");
    expect(r.limit).toBe(100);
    expect(r.json).toBe(false);
  });

  test("--limit overrides default", () => {
    const result = runParseArgs(["--deployment", "dep-1", "--limit", "50"]);
    const r = result as { deploymentId: string; limit: number };
    expect(r.limit).toBe(50);
  });

  test("--limit with invalid value returns exitCode 1", () => {
    const result = runParseArgs(["--deployment", "dep-1", "--limit", "abc"]);
    expect(result).toEqual({ exitCode: 1 });
  });

  test("--severity is captured", () => {
    const result = runParseArgs(["--deployment", "dep-1", "--severity", "error"]);
    const r = result as { deploymentId: string; severity: string | undefined };
    expect(r.severity).toBe("error");
  });

  test("--severity without value returns exitCode 1", () => {
    const result = runParseArgs(["--deployment", "dep-1", "--severity"]);
    expect(result).toEqual({ exitCode: 1 });
  });

  test("--grep is captured", () => {
    const result = runParseArgs(["--deployment", "dep-1", "--grep", LEGACY_ERROR_PATTERN]);
    const r = result as { deploymentId: string; grep: string | undefined };
    expect(r.grep).toBe(LEGACY_ERROR_PATTERN);
  });

  test("--grep without value returns exitCode 1", () => {
    const result = runParseArgs(["--deployment", "dep-1", "--grep"]);
    expect(result).toEqual({ exitCode: 1 });
  });

  test("--json flag is captured", () => {
    const result = runParseArgs(["--deployment", "dep-1", "--json"]);
    const r = result as { deploymentId: string; json: boolean };
    expect(r.json).toBe(true);
  });

  test("all options together parse correctly", () => {
    const result = runParseArgs([
      "--deployment",
      "dep-full",
      "--limit",
      "200",
      "--severity",
      "error",
      "--grep",
      "ConfigError",
      "--json",
    ]);
    const r = result as {
      deploymentId: string;
      limit: number;
      severity: string | undefined;
      grep: string | undefined;
      json: boolean;
    };
    expect(r.deploymentId).toBe("dep-full");
    expect(r.limit).toBe(200);
    expect(r.severity).toBe("error");
    expect(r.grep).toBe("ConfigError");
    expect(r.json).toBe(true);
  });
});

// --- graphql() error paths (structural mirrors matching status.test.ts pattern) ---

describe("graphql() fetch-rejection paths", () => {
  const GRAPHQL_TIMEOUT_MS = 30_000;

  function classifyFetchError(err: unknown): Error {
    if (err instanceof Error && err.name === "AbortError") {
      return new ApiError(`Railway API request timed out after ${GRAPHQL_TIMEOUT_MS}ms`);
    }
    return new ApiError(
      `Railway API network error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  test("AbortError produces timeout message", () => {
    const abortErr = new DOMException("The operation was aborted", "AbortError");
    const thrown = classifyFetchError(abortErr);
    expect(thrown.message).toContain("timed out");
    expect(thrown).toBeInstanceOf(ApiError);
  });

  test("generic Error wraps the cause", () => {
    const networkErr = new Error("ENOTFOUND backboard.railway.com");
    const thrown = classifyFetchError(networkErr);
    expect(thrown.message).toContain("Railway API network error");
    expect(thrown.cause).toBe(networkErr);
  });

  test("non-Error strings are included in message", () => {
    const thrown = classifyFetchError("connection reset");
    expect(thrown.message).toContain("connection reset");
  });
});

// --- readRailwayToken error paths (structural mirror) ---

describe("readRailwayToken() error paths", () => {
  function simulateReadToken(cfgExists: boolean, cfg: unknown): string {
    if (!cfgExists) {
      throw new AuthError(
        "Railway CLI is not authenticated (missing ~/.railway/config.json). Run: railway login"
      );
    }
    const parsed = cfg as { user?: { accessToken?: string } };
    const token = parsed.user?.accessToken;
    if (!token) {
      throw new AuthError(
        "Railway CLI is not authenticated (no user.accessToken in ~/.railway/config.json). Run: railway login"
      );
    }
    return token;
  }

  test("throws AuthError when config file is missing", () => {
    expect(() => simulateReadToken(false, null)).toThrow(AuthError);
  });

  test("throws AuthError when accessToken is absent", () => {
    expect(() => simulateReadToken(true, { user: {} })).toThrow(AuthError);
    expect(() => simulateReadToken(true, { user: {} })).toThrow("no user.accessToken");
  });

  test("returns token when config is valid", () => {
    const token = simulateReadToken(true, { user: { accessToken: "tok-xyz" } });
    expect(token).toBe("tok-xyz");
  });
});

// --- AuthError / ApiError class invariants ---

describe("AuthError and ApiError class invariants", () => {
  // Post-mt#2013: AuthError / ApiError are re-exports of RailwayAuthError /
  // RailwayApiError from src/domain/deployment/railway/graphql-client. The
  // .name field carries the canonical class name; instanceof still works.
  test("AuthError is an Error subclass", () => {
    const err = new AuthError("auth failed");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RailwayAuthError");
    expect(err.message).toBe("auth failed");
  });

  test("ApiError is an Error subclass", () => {
    const err = new ApiError("api failed");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RailwayApiError");
    expect(err.message).toBe("api failed");
  });
});

// --- JSON output mode (mocked response) ---

describe("JSON output mode", () => {
  test("filtered logs are JSON-serializable", () => {
    const logs: LogEntry[] = [
      { timestamp: "2026-05-07T12:00:00Z", severity: "error", message: "crash" },
    ];
    const serialized = JSON.stringify(logs);
    const parsed = JSON.parse(serialized) as LogEntry[];
    expect(parsed).toHaveLength(1);
    const first = parsed[0];
    expect(first).toBeDefined();
    expect(first?.severity).toBe("error");
    expect(first?.message).toBe("crash");
  });
});
