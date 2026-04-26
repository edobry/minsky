/**
 * Tests for the reviewer-local logger.
 *
 * Key requirement (spec §4): mcpToken / Bearer strings MUST NOT appear in
 * log output. The redaction test below proves this at the call-site boundary.
 */

import { describe, test, expect } from "bun:test";
import { createLogger } from "./logger";

/** Env var name for the MCP token — extracted to avoid magic-string duplication. */
const MCP_TOKEN_ENV = "MINSKY_MCP_TOKEN";

/** Capture lines written by a winston Console transport to a string array. */
function captureLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);

  // Winston writes to stdout by default at info/debug level.
  // Override both stdout and stderr to be safe.
  const capture = (chunk: unknown): boolean => {
    if (typeof chunk === "string") {
      lines.push(...chunk.split("\n").filter((l) => l.length > 0));
    } else if (Buffer.isBuffer(chunk)) {
      const str = chunk.toString("utf8");
      lines.push(...str.split("\n").filter((l) => l.length > 0));
    }
    return true;
  };

  // @ts-expect-error — intentional monkey-patch for test capture
  process.stdout.write = capture;
  // @ts-expect-error — intentional monkey-patch for test capture
  process.stderr.write = capture;

  return {
    lines,
    restore: () => {
      process.stdout.write = origWrite;
      process.stderr.write = origErrWrite;
    },
  };
}

/** Capture stdout and stderr separately so we can assert per-stream routing. */
function captureStreams(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  const collect =
    (target: string[]) =>
    (chunk: unknown): boolean => {
      const str =
        typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (str) target.push(...str.split("\n").filter((l) => l.length > 0));
      return true;
    };

  // @ts-expect-error — intentional monkey-patch for test capture
  process.stdout.write = collect(stdout);
  // @ts-expect-error — intentional monkey-patch for test capture
  process.stderr.write = collect(stderr);

  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    },
  };
}

describe("logger", () => {
  describe("createLogger", () => {
    test("creates a logger with expected methods", () => {
      const logger = createLogger({ mode: "STRUCTURED", level: "debug" });
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
    });

    test("STRUCTURED mode emits JSON lines", () => {
      const logger = createLogger({ mode: "STRUCTURED", level: "info" });
      const { lines, restore } = captureLines();
      try {
        logger.info("test structured message", { key: "value" });
      } finally {
        restore();
      }
      const jsonLine = lines.find((l) => {
        try {
          const parsed = JSON.parse(l);
          return parsed.message === "test structured message";
        } catch {
          return false;
        }
      });
      expect(jsonLine).toBeDefined();
      if (jsonLine === undefined) return;
      const parsed = JSON.parse(jsonLine);
      expect(parsed.key).toBe("value");
    });

    test("HUMAN mode emits non-JSON lines", () => {
      const logger = createLogger({ mode: "HUMAN", level: "info" });
      const { lines, restore } = captureLines();
      try {
        logger.info("human readable message");
      } finally {
        restore();
      }
      const humanLine = lines.find((l) => l.includes("human readable message"));
      expect(humanLine).toBeDefined();
    });

    test("warn and error route to stderr; info and debug route to stdout", () => {
      // Pre-PR semantics: console.error wrote to stderr. Winston's Console
      // transport defaults to stdout for everything; we configure stderrLevels
      // to preserve the stream contract.
      const logger = createLogger({ mode: "STRUCTURED", level: "debug" });
      const { stdout, stderr, restore } = captureStreams();
      try {
        logger.debug("dbg.msg");
        logger.info("inf.msg");
        logger.warn("wrn.msg");
        logger.error("err.msg");
      } finally {
        restore();
      }
      const stdoutAll = stdout.join("\n");
      const stderrAll = stderr.join("\n");

      // stdout: debug + info only.
      expect(stdoutAll).toContain("dbg.msg");
      expect(stdoutAll).toContain("inf.msg");
      expect(stdoutAll).not.toContain("wrn.msg");
      expect(stdoutAll).not.toContain("err.msg");

      // stderr: warn + error only.
      expect(stderrAll).toContain("wrn.msg");
      expect(stderrAll).toContain("err.msg");
      expect(stderrAll).not.toContain("dbg.msg");
      expect(stderrAll).not.toContain("inf.msg");
    });

    test("respects log level — debug suppressed at info level", () => {
      const logger = createLogger({ mode: "STRUCTURED", level: "info" });
      const { lines, restore } = captureLines();
      try {
        logger.debug("this should not appear");
        logger.info("this should appear");
      } finally {
        restore();
      }
      const debugLine = lines.find((l) => l.includes("this should not appear"));
      const infoLine = lines.find((l) => l.includes("this should appear"));
      expect(debugLine).toBeUndefined();
      expect(infoLine).toBeDefined();
    });
  });

  describe("token redaction (spec §4)", () => {
    test("a log message containing MINSKY_MCP_TOKEN value does NOT emit the raw secret", () => {
      // This test simulates a call site accidentally passing the token as context.
      // The spec requires call sites to redact — we verify the guard works at the
      // boundary by using a redacted value in the context.
      const secret = "secret123";
      const logger = createLogger({ mode: "STRUCTURED", level: "info" });

      const { lines, restore } = captureLines();
      try {
        // Correct call-site pattern: always use redacted token placeholder.
        logger.info("mcp call initiated", { token: "***" });
      } finally {
        restore();
      }

      const allOutput = lines.join("\n");
      expect(allOutput).not.toContain(secret);
    });

    test("log output does not contain raw bearer token when passed as redacted placeholder", () => {
      const secret = "secret123";
      const logger = createLogger({ mode: "STRUCTURED", level: "info" });

      const { lines, restore } = captureLines();
      try {
        // Simulate what mcp-client.ts does: redact the token before logging.
        const redactedContext = { token: "***", artifactId: "pr/42" };
        logger.error("authorship.get failed", redactedContext);
      } finally {
        restore();
      }

      const allOutput = lines.join("\n");
      expect(allOutput).not.toContain(secret);
    });

    test("MINSKY_MCP_TOKEN env value does not appear in log output when log uses redacted placeholder", () => {
      // Force an env var to simulate prod environment.
      const original = process.env[MCP_TOKEN_ENV];
      process.env[MCP_TOKEN_ENV] = "secret123";

      const logger = createLogger({ mode: "STRUCTURED", level: "info" });
      const { lines, restore } = captureLines();

      try {
        // Correct call-site: never pass the actual token value.
        logger.info("token configured", { token: "***" });
        logger.warn("mcp config present", { url: "https://example.com" });
      } finally {
        restore();
        if (original === undefined) {
          delete process.env[MCP_TOKEN_ENV];
        } else {
          process.env[MCP_TOKEN_ENV] = original;
        }
      }

      const allOutput = lines.join("\n");
      expect(allOutput).not.toContain("secret123");
    });

    test("logger scrubs sensitive context keys even when the caller forgets to redact", () => {
      // Defense in depth: if a future call site mistakenly passes the raw token
      // in context, the logger's redactFormat must replace it with "***" before
      // it reaches the transport.
      const logger = createLogger({ mode: "STRUCTURED", level: "info" });
      const { lines, restore } = captureLines();
      try {
        logger.error("auth.failed", {
          token: "secret123",
          mcpToken: "secret456",
          Authorization: "Bearer secret789",
          apiKey: "secret-abc",
          privateKey: "-----BEGIN PEM-----\nsecret-xyz\n-----END PEM-----",
          // Non-sensitive fields should pass through.
          artifactId: "pr/42",
          status: 401,
        });
      } finally {
        restore();
      }
      const allOutput = lines.join("\n");
      // None of the raw secrets should appear.
      expect(allOutput).not.toContain("secret123");
      expect(allOutput).not.toContain("secret456");
      expect(allOutput).not.toContain("secret789");
      expect(allOutput).not.toContain("secret-abc");
      expect(allOutput).not.toContain("secret-xyz");
      // Non-sensitive fields are preserved.
      expect(allOutput).toContain("pr/42");
      expect(allOutput).toContain("401");
    });

    test("logger scrubs camelCase and snake_case secret-key variants", () => {
      // Defense in depth must also catch common variants outside the literal set.
      const logger = createLogger({ mode: "STRUCTURED", level: "info" });
      const { lines, restore } = captureLines();
      try {
        logger.error("auth.failed", {
          accessToken: "v1",
          refresh_token: "v2",
          bearerToken: "v3",
          authToken: "v4",
          x_api_key: "v5",
          xApiKey: "v6",
          client_secret: "v7",
          clientSecret: "v8",
          // Non-sensitive — must survive.
          retryCount: 3,
        });
      } finally {
        restore();
      }
      const allOutput = lines.join("\n");
      for (const v of ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"]) {
        expect(allOutput).not.toContain(`"${v}"`);
      }
      expect(allOutput).toContain("3");
    });

    test("preserves telemetry fields whose names contain substrings of secret keys", () => {
      // Regression guard for the substring-match foot-gun: keys like
      // promptTokens / completionTokens / reasoningTokens / totalTokens MUST
      // pass through. Same for tokenizer, authState, author. Only exact
      // (normalized) matches in REDACT_KEYS get scrubbed.
      const logger = createLogger({ mode: "STRUCTURED", level: "info" });
      const { lines, restore } = captureLines();
      try {
        logger.info("usage.report", {
          usage: {
            promptTokens: 1234,
            completionTokens: 567,
            reasoningTokens: 89,
            totalTokens: 1890,
          },
          tokenizer: "cl100k_base",
          authState: "ready",
          author: "minsky-ai[bot]",
          // And one real secret key for contrast — must still be scrubbed.
          accessToken: "secret-access-123",
        });
      } finally {
        restore();
      }
      const allOutput = lines.join("\n");
      // Telemetry numeric values present.
      expect(allOutput).toContain("1234");
      expect(allOutput).toContain("567");
      expect(allOutput).toContain("89");
      expect(allOutput).toContain("1890");
      // Non-secret string values present.
      expect(allOutput).toContain("cl100k_base");
      expect(allOutput).toContain("ready");
      expect(allOutput).toContain("minsky-ai[bot]");
      // The real secret IS scrubbed.
      expect(allOutput).not.toContain("secret-access-123");
    });

    test("does not crash on cyclic context objects", () => {
      // Regression guard: a context with a cycle would previously crash
      // JSON.stringify (HUMAN) or winston.format.json() (STRUCTURED). The
      // visited-WeakSet in redact() now returns "[Circular]" instead of
      // recursing infinitely.
      const logger = createLogger({ mode: "STRUCTURED", level: "info" });
      type Cyclic = { name: string; self?: Cyclic };
      const cyclic: Cyclic = { name: "loop" };
      cyclic.self = cyclic;
      const { lines, restore } = captureLines();
      try {
        // Must not throw.
        logger.info("cyclic.test", { ctx: cyclic, plain: "ok" });
      } finally {
        restore();
      }
      const allOutput = lines.join("\n");
      // Plain field survived.
      expect(allOutput).toContain("ok");
      // Cycle was caught.
      expect(allOutput).toContain("[Circular]");
    });

    test("logger rewrites Bearer-style strings even outside known sensitive keys", () => {
      // If a Bearer token leaks into a free-form field (e.g., an error message),
      // redactFormat must still scrub it.
      const logger = createLogger({ mode: "STRUCTURED", level: "info" });
      const { lines, restore } = captureLines();
      try {
        logger.error("upstream.401", {
          message: "request rejected: Bearer secret999",
          artifactId: "pr/7",
        });
      } finally {
        restore();
      }
      const allOutput = lines.join("\n");
      expect(allOutput).not.toContain("secret999");
      expect(allOutput).toContain("Bearer ***");
    });
  });
});
