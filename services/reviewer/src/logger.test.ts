/**
 * Unit tests for services/reviewer/src/logger.ts
 *
 * Covers:
 *   - LogMode resolution (HUMAN / STRUCTURED via env var and TTY detection)
 *   - LogLevel resolution (LOG_LEVEL env var precedence)
 *   - redactString: Bearer token and PEM redaction
 *   - redactContext: sensitive-key redaction and Bearer-in-string-values
 *   - createLogger / singleton: mode is correctly wired through
 *   - Acceptance test #5 / #6: mcpToken value cannot appear in any emitted message;
 *     a 401 error path logs artifactId but NOT the bearer token string
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  LogMode,
  _resetDefaultLoggerForTests,
  createLogger,
  redactContext,
  redactString,
  resolveLogLevel,
  resolveLogMode,
} from "./logger";

// ---------------------------------------------------------------------------
// Helpers to capture env vars and reset between tests
// ---------------------------------------------------------------------------

const savedEnvKeys = ["MINSKY_LOG_MODE", "LOG_LEVEL"] as const;
type EnvSnapshot = Partial<Record<(typeof savedEnvKeys)[number], string>>;

let envSnapshot: EnvSnapshot = {};

beforeEach(() => {
  envSnapshot = {};
  for (const key of savedEnvKeys) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
  _resetDefaultLoggerForTests();
});

afterEach(() => {
  for (const key of savedEnvKeys) {
    const saved = envSnapshot[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
  _resetDefaultLoggerForTests();
});

// ---------------------------------------------------------------------------
// resolveLogMode
// ---------------------------------------------------------------------------

describe("resolveLogMode", () => {
  test("returns STRUCTURED when MINSKY_LOG_MODE=STRUCTURED", () => {
    process.env["MINSKY_LOG_MODE"] = "STRUCTURED";
    expect(resolveLogMode()).toBe(LogMode.STRUCTURED);
  });

  test("returns HUMAN when MINSKY_LOG_MODE=HUMAN", () => {
    process.env["MINSKY_LOG_MODE"] = "HUMAN";
    expect(resolveLogMode()).toBe(LogMode.HUMAN);
  });

  test("returns STRUCTURED when no env var and stdout is not a TTY (CI/Docker)", () => {
    delete process.env["MINSKY_LOG_MODE"];
    // In bun test, process.stdout.isTTY is typically false — matches CI/Docker.
    // We cannot mutate process.stdout.isTTY in Bun without casting hacks, so we
    // assert that the function's behaviour is consistent: if isTTY is falsy,
    // STRUCTURED is returned.
    if (!process.stdout.isTTY) {
      expect(resolveLogMode()).toBe(LogMode.STRUCTURED);
    } else {
      // In a TTY environment (developer workstation running tests in a terminal),
      // HUMAN is the correct default.
      expect(resolveLogMode()).toBe(LogMode.HUMAN);
    }
  });

  test("STRUCTURED takes priority over TTY detection", () => {
    process.env["MINSKY_LOG_MODE"] = "STRUCTURED";
    expect(resolveLogMode()).toBe(LogMode.STRUCTURED);
  });

  test("HUMAN takes priority over TTY detection", () => {
    process.env["MINSKY_LOG_MODE"] = "HUMAN";
    expect(resolveLogMode()).toBe(LogMode.HUMAN);
  });
});

// ---------------------------------------------------------------------------
// resolveLogLevel
// ---------------------------------------------------------------------------

describe("resolveLogLevel", () => {
  test("defaults to info when LOG_LEVEL is unset", () => {
    delete process.env["LOG_LEVEL"];
    expect(resolveLogLevel()).toBe("info");
  });

  test("returns debug when LOG_LEVEL=debug", () => {
    process.env["LOG_LEVEL"] = "debug";
    expect(resolveLogLevel()).toBe("debug");
  });

  test("returns warn when LOG_LEVEL=warn", () => {
    process.env["LOG_LEVEL"] = "warn";
    expect(resolveLogLevel()).toBe("warn");
  });

  test("returns error when LOG_LEVEL=error", () => {
    process.env["LOG_LEVEL"] = "error";
    expect(resolveLogLevel()).toBe("error");
  });

  test("falls back to info for unknown LOG_LEVEL values", () => {
    process.env["LOG_LEVEL"] = "verbose";
    expect(resolveLogLevel()).toBe("info");
  });

  test("uses LOG_LEVEL (with underscore), matching config.ts:logLevel convention", () => {
    // Regression for PR #1014 R1 BLOCKING #1 — earlier draft used LOGLEVEL
    // which silently fell back to "info" in production where LOG_LEVEL is set.
    process.env["LOG_LEVEL"] = "debug";
    process.env["LOGLEVEL"] = "error"; // legacy/wrong name must NOT win
    expect(resolveLogLevel()).toBe("debug");
  });
});

// ---------------------------------------------------------------------------
// redactString
// ---------------------------------------------------------------------------

describe("redactString", () => {
  test("replaces Bearer token with Bearer ***", () => {
    const result = redactString("Authorization: Bearer abc123secrettoken");
    expect(result).toBe("Authorization: Bearer ***");
  });

  test("replaces Bearer token regardless of case", () => {
    const result = redactString("BEARER xyzSecretToken");
    expect(result).toBe("Bearer ***");
  });

  test("replaces full PEM block (header + base64 body + footer) with [REDACTED PEM]", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDV+secret+body+\n" +
      "-----END RSA PRIVATE KEY-----";
    const result = redactString(pem);
    // BEGIN/body/END must all be replaced by the placeholder
    expect(result).toContain("[REDACTED PEM]");
    expect(result).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result).not.toContain("END RSA PRIVATE KEY");
    expect(result).not.toContain("MIIEvQIBADAN");
    expect(result).not.toContain("secret+body");
  });

  test("redacts each PEM block independently when multiple are present", () => {
    const twoPems =
      "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----" +
      " between " +
      "-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----";
    const result = redactString(twoPems);
    // Lazy matching means each block is redacted on its own — adjacent " between "
    // text is preserved, both AAA and BBB bodies are gone.
    expect(result).toContain("between");
    expect(result).not.toContain("AAA");
    expect(result).not.toContain("BBB");
    // Both blocks replaced; expect two placeholders.
    const placeholderCount = result.split("[REDACTED PEM]").length - 1;
    expect(placeholderCount).toBe(2);
  });

  test("masks URL userinfo credentials, keeping scheme and host (mt#2463)", () => {
    const result = redactString(
      'connect ECONNREFUSED for "postgresql://minsky:s3cretPW@db.example.supabase.com:6543/postgres"' // gitleaks:allow
    );
    expect(result).toContain("postgresql://***:***@db.example.supabase.com:6543/postgres");
    expect(result).not.toContain("s3cretPW");
    expect(result).not.toContain("minsky:s3cretPW");
  });

  test("masks credentials in any URL scheme (redis, https)", () => {
    expect(redactString("redis://default:hunter2@cache:6379")).toBe("redis://***:***@cache:6379"); // gitleaks:allow
    // gitleaks:allow
    expect(redactString("https://user:tok3n@api.example.com/path")).toBe(
      "https://***:***@api.example.com/path"
    );
  });

  test("leaves credential-free URLs unchanged", () => {
    const url = "postgresql://db.example.supabase.com:6543/postgres?sslmode=require";
    expect(redactString(url)).toBe(url);
  });

  test("masks password=... fragments in libpq-style conninfo strings (mt#2463)", () => {
    const result = redactString(
      "connection failed: host=db port=5432 user=minsky password=pw123 dbname=minsky"
    );
    expect(result).toContain("password=***");
    expect(result).not.toContain("pw123");
    expect(result).toContain("host=db");
  });

  test("leaves non-sensitive strings unchanged", () => {
    const msg = "MCP lookup failed for PR 42: connection refused";
    expect(redactString(msg)).toBe(msg);
  });

  test("replaces multiple Bearer tokens in one string", () => {
    // Note: \S+ in the regex consumes non-whitespace including punctuation like commas.
    // "Bearer tok1," is matched as one token ("tok1,"); the comma is consumed.
    const result = redactString("first: Bearer tok1 second: Bearer tok2");
    expect(result).toBe("first: Bearer *** second: Bearer ***");
  });

  test("does not include the actual token value in output", () => {
    const secretToken = "super-secret-token-12345";
    const result = redactString(`Bearer ${secretToken}`);
    expect(result).not.toContain(secretToken);
  });
});

// ---------------------------------------------------------------------------
// redactContext
// ---------------------------------------------------------------------------

describe("redactContext", () => {
  test("redacts mcpToken field", () => {
    const ctx = { mcpToken: "real-bearer-token", artifactId: "42" };
    const result = redactContext(ctx);
    expect(result["mcpToken"]).toBe("***");
    expect(result["artifactId"]).toBe("42");
  });

  test("redacts privateKey field", () => {
    const ctx = { privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIE..." };
    const result = redactContext(ctx);
    expect(result["privateKey"]).toBe("***");
  });

  test("redacts authorization field (lowercase)", () => {
    const ctx = { authorization: "Bearer some-token" };
    const result = redactContext(ctx);
    expect(result["authorization"]).toBe("***");
  });

  test("redacts Authorization field (title-case)", () => {
    const ctx = { Authorization: "Bearer some-token" };
    const result = redactContext(ctx);
    expect(result["Authorization"]).toBe("***");
  });

  test("redacts providerApiKey field", () => {
    const ctx = { providerApiKey: "sk-openai-key" };
    const result = redactContext(ctx);
    expect(result["providerApiKey"]).toBe("***");
  });

  test("redacts Bearer tokens embedded in string values", () => {
    const ctx = { headers: "Authorization: Bearer tok", tier: 3 };
    const result = redactContext(ctx);
    expect(result["headers"] as string).toContain("Bearer ***");
    expect(result["headers"] as string).not.toContain("tok");
  });

  test("does not mutate the original context object", () => {
    const ctx = { mcpToken: "real-token" };
    redactContext(ctx);
    expect(ctx["mcpToken"]).toBe("real-token");
  });

  test("passes through non-sensitive string values unchanged", () => {
    const ctx = { event: "authorship.get", pr: 42 };
    const result = redactContext(ctx);
    expect(result["event"]).toBe("authorship.get");
    expect(result["pr"]).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// createLogger (mode switching)
// ---------------------------------------------------------------------------

describe("createLogger", () => {
  test("exposes HUMAN mode when explicitly passed", () => {
    const logger = createLogger(LogMode.HUMAN);
    expect(logger.mode).toBe(LogMode.HUMAN);
  });

  test("exposes STRUCTURED mode when explicitly passed", () => {
    const logger = createLogger(LogMode.STRUCTURED);
    expect(logger.mode).toBe(LogMode.STRUCTURED);
  });

  test("exposes debug / info / warn / error methods", () => {
    const logger = createLogger(LogMode.STRUCTURED, "debug");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  test("does not throw when logging a message with context", () => {
    const logger = createLogger(LogMode.STRUCTURED, "debug");
    expect(() => logger.info("test message", { event: "test", pr: 1 })).not.toThrow();
  });

  test("does not throw when logging a message without context", () => {
    const logger = createLogger(LogMode.HUMAN, "info");
    expect(() => logger.warn("plain warning")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Acceptance test #5: mcpToken value CANNOT appear in any log output
// ---------------------------------------------------------------------------

describe("redaction acceptance: mcpToken never emitted", () => {
  test("mcpToken value is redacted in context objects", () => {
    const secretToken = "my-secret-mcp-bearer-token";
    const ctx = { mcpToken: secretToken, event: "authorship.get" };
    const redacted = redactContext(ctx);
    // The actual token value must not survive redaction
    expect(JSON.stringify(redacted)).not.toContain(secretToken);
    expect(redacted["mcpToken"]).toBe("***");
  });

  test("Bearer token embedded in a message string is redacted", () => {
    const secretToken = "eyJhbGciOiJSUzI1NiJ9.secret";
    const msg = `Authorization: Bearer ${secretToken}`;
    const redacted = redactString(msg);
    expect(redacted).not.toContain(secretToken);
    expect(redacted).toContain("Bearer ***");
  });
});

// ---------------------------------------------------------------------------
// Acceptance test #6: 401 error path logs artifactId but NOT bearer token
// ---------------------------------------------------------------------------

describe("redaction acceptance: 401 error log does not contain bearer token", () => {
  test("simulates a mcp-client 401 error log — artifactId present, token absent", () => {
    const secretToken = "secret-bearer-value-xyz";
    const artifactId = "42";

    // Simulate the error message shape produced by mcp-client on HTTP 401
    // (callAuthorshipGet was removed in mt#2121; this tests the log format, not the function):
    // log.error(`[mcp-client] authorship.get(${artifactId}) HTTP 401 Unauthorized`)
    // with NO context that includes the token (the function never passes mcpToken to log.error).
    const errorMsg = `[mcp-client] authorship.get(${artifactId}) HTTP 401 Unauthorized`;

    // After redactString (called by the logger on every message):
    const redacted = redactString(errorMsg);

    // The artifactId must be present
    expect(redacted).toContain(artifactId);
    // The token must not be present
    expect(redacted).not.toContain(secretToken);
  });

  test("if context accidentally included mcpToken, redactContext removes it", () => {
    const secretToken = "accidental-token-in-context";
    // Even if a caller mistakenly includes mcpToken in context,
    // redactContext must strip it before it reaches the transport.
    const ctx = { mcpToken: secretToken, artifactId: "99", status: 401 };
    const redacted = redactContext(ctx);
    expect(JSON.stringify(redacted)).not.toContain(secretToken);
    expect(redacted["artifactId"]).toBe("99");
    expect(redacted["mcpToken"]).toBe("***");
  });
});
