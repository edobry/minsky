/**
 * Tests for agent harness detection and installed client detection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "path";
import {
  detectAgentHarness,
  hasNativeSubagentSupport,
  detectInstalledClients,
  resolveInitClient,
} from "./harness-detection";

const CLAUDE_AND_CURSOR_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PROJECT_DIR",
  "CURSOR_SESSION_ID",
  "CURSOR_TRACE_ID",
  "VSCODE_PID",
];

function withCleanEnv(envVars: string[]) {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const v of envVars) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of envVars) {
      if (savedEnv[v] === undefined) {
        delete process.env[v];
      } else {
        process.env[v] = savedEnv[v];
      }
    }
  });
}

describe("detectAgentHarness", () => {
  withCleanEnv(CLAUDE_AND_CURSOR_ENV_VARS);

  // CLAUDECODE=1 (no underscore) is the canonical Claude Code 2.1.x env var.
  test("returns 'claude-code' when CLAUDECODE is set", () => {
    process.env.CLAUDECODE = "1";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_ENTRYPOINT is set", () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_SESSION_ID is set", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "abc-123";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_SUBAGENT_MODEL is set", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_EXECPATH is set", () => {
    process.env.CLAUDE_CODE_EXECPATH = "/Users/me/.local/share/claude/versions/2.1.136";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_PROJECT_DIR is set", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when legacy CLAUDE_CODE is set", () => {
    process.env.CLAUDE_CODE = "1";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'cursor' when CURSOR_SESSION_ID is set", () => {
    process.env.CURSOR_SESSION_ID = "abc123";
    expect(detectAgentHarness()).toBe("cursor");
  });

  test("returns 'cursor' when VSCODE_PID is set", () => {
    process.env.VSCODE_PID = "1234";
    expect(detectAgentHarness()).toBe("cursor");
  });

  test("returns 'standalone' when no relevant env vars are set", () => {
    expect(detectAgentHarness()).toBe("standalone");
  });

  // mt#2712 R1: this case was covered by the now-deleted stale duplicate
  // (tests/domain/runtime/harness-detection.test.ts's "claude-code takes
  // priority over cursor") but had no equivalent here -- the canonical
  // suite was not a strict superset. Re-added so the priority behavior
  // stays covered.
  test("claude-code takes priority over cursor when both are set", () => {
    process.env.CLAUDECODE = "1";
    process.env.VSCODE_PID = "1234";
    expect(detectAgentHarness()).toBe("claude-code");
  });
});

describe("hasNativeSubagentSupport", () => {
  withCleanEnv(CLAUDE_AND_CURSOR_ENV_VARS);

  test("returns true when running in claude-code (CLAUDECODE)", () => {
    process.env.CLAUDECODE = "1";
    expect(hasNativeSubagentSupport()).toBe(true);
  });

  // mt#2712 R1: this case was covered by the now-deleted stale duplicate
  // (tests/domain/runtime/harness-detection.test.ts's "returns false for
  // cursor (not yet supported)") but had no equivalent here -- the
  // canonical suite was not a strict superset. Re-added so cursor's
  // no-native-subagent-support behavior stays covered.
  test("returns false for cursor (not yet supported)", () => {
    process.env.CURSOR_SESSION_ID = "abc123";
    expect(hasNativeSubagentSupport()).toBe(false);
  });

  test("returns false in standalone mode", () => {
    expect(hasNativeSubagentSupport()).toBe(false);
  });
});

describe("detectInstalledClients", () => {
  test("returns an array", () => {
    const clients = detectInstalledClients();
    expect(Array.isArray(clients)).toBe(true);
  });

  test("returns stable results on repeated calls", () => {
    // detectInstalledClients probes the real filesystem; verify it is deterministic.
    // Both outcomes (cursor present or absent) are valid depending on the machine.
    const clients1 = detectInstalledClients();
    const clients2 = detectInstalledClients();
    expect(clients1).toEqual(clients2);
  });

  test("returned values are all ManagedClient members", () => {
    const validClients = new Set([
      "cursor",
      "claude-desktop",
      "claude-code",
      "vscode",
      "windsurf",
      "junie",
      "codex",
      "openhands",
    ]);
    const clients = detectInstalledClients();
    for (const c of clients) {
      expect(validClients.has(c)).toBe(true);
    }
  });

  describe("claude-code detection (mt#4676)", () => {
    test("reports claude-code when ~/.claude/ exists", () => {
      const clients = detectInstalledClients({
        pathExists: (p) => p.endsWith(`${path.sep}.claude`),
      });
      expect(clients).toContain("claude-code");
    });

    test("does not report claude-code when ~/.claude/ is absent", () => {
      const clients = detectInstalledClients({ pathExists: () => false });
      expect(clients).not.toContain("claude-code");
    });

    test("ambiguous case: reports both claude-code and cursor when both directories exist", () => {
      // mt#4676's originating repro: CLAUDECODE=1 live, ~/.cursor/ ALSO present
      // (from a prior editor install). detectInstalledClients() itself makes no
      // ordering claim between the two -- resolveInitClient() is what decides
      // which one wins for `init`, and that decision is tested separately below.
      const clients = detectInstalledClients({ pathExists: () => true });
      expect(clients).toContain("claude-code");
      expect(clients).toContain("cursor");
    });
  });
});

describe("resolveInitClient (mt#4676)", () => {
  test("returns claude-code when the environment reports claude-code", () => {
    expect(resolveInitClient("claude-code", [])).toBe("claude-code");
  });

  test("returns cursor when the environment reports cursor", () => {
    expect(resolveInitClient("cursor", [])).toBe("cursor");
  });

  // The exact ambiguous case from mt#4676's repro: CLAUDECODE=1 is live AND
  // ~/.cursor/ exists on disk (a prior editor install). The environment
  // signal must win -- filesystem installed-ness only proves an app is
  // present, not that it is the one driving `init`.
  test("ambiguous case: env says claude-code, filesystem also shows cursor installed -- claude-code wins", () => {
    expect(resolveInitClient("claude-code", ["cursor", "claude-desktop"])).toBe("claude-code");
  });

  test("no regression: env says cursor even though claude-code is also installed -- cursor wins", () => {
    expect(resolveInitClient("cursor", ["claude-code", "cursor"])).toBe("cursor");
  });

  test("standalone: falls back to the first installed client", () => {
    expect(resolveInitClient("standalone", ["claude-desktop", "vscode"])).toBe("claude-desktop");
  });

  test("standalone with nothing installed: defaults to cursor (preserves init's pre-mt#4676 default)", () => {
    expect(resolveInitClient("standalone", [])).toBe("cursor");
  });

  test("defaults to the real detectors when called with no arguments", () => {
    // Doesn't assert a specific value (machine-dependent) -- just that it
    // returns a valid ManagedClient without throwing, proving the default
    // parameters wire up to the real detectAgentHarness()/detectInstalledClients().
    const result = resolveInitClient();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
