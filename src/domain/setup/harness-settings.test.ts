/**
 * Tests for harness agent performance settings domain logic.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import * as path from "path";
import {
  applyClaudeCodeSettings,
  applyHarnessSettings,
  detectClaudeCodeInstalled,
} from "./harness-settings";
import { createMockFs } from "../interfaces/mock-fs";
import type { MockFs } from "../interfaces/mock-fs";

const TEST_HOME = "/test-home";
const SETTINGS_PATH = path.join(TEST_HOME, ".claude", "settings.json");
const CLAUDE_DIR = path.join(TEST_HOME, ".claude");

const claudeInstalled = (p: string) => p === CLAUDE_DIR;
const nothingInstalled = (_p: string) => false;

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) throw new Error(message);
}

describe("detectClaudeCodeInstalled", () => {
  test("returns true when ~/.claude directory exists", () => {
    expect(detectClaudeCodeInstalled(TEST_HOME, claudeInstalled)).toBe(true);
  });

  test("returns false when ~/.claude directory does not exist", () => {
    expect(detectClaudeCodeInstalled(TEST_HOME, nothingInstalled)).toBe(false);
  });
});

describe("applyClaudeCodeSettings", () => {
  let mockFs: MockFs;

  beforeEach(() => {
    mockFs = createMockFs();
  });

  test("returns not-detected when Claude Code is not installed", async () => {
    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: nothingInstalled },
      mockFs
    );
    expect(result.status).toBe("not-detected");
    expect(result.harness).toBe("claude-code");
    expect(result.changes).toHaveLength(0);
  });

  test("creates fresh settings.json when file does not exist", async () => {
    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    expect(result.status).toBe("applied");
    expect(result.harness).toBe("claude-code");
    expect(result.settingsPath).toBe(SETTINGS_PATH);

    const written = mockFs.files.get(SETTINGS_PATH);
    assertDefined(written, "Expected settings.json to be written");
    const parsed = JSON.parse(written);
    expect(parsed.model).toBe("sonnet");
    expect(parsed.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("60");
  });

  test("reports all recommended keys as changes on fresh file", async () => {
    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    const changeKeys = result.changes.map((c) => c.key);
    expect(changeKeys).toContain("model");
    expect(changeKeys).toContain("env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
    expect(result.changes).toHaveLength(2);
  });

  test("changes show undefined 'from' for missing keys", async () => {
    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    const modelChange = result.changes.find((c) => c.key === "model");
    expect(modelChange?.from).toBeUndefined();
    expect(modelChange?.to).toBe("sonnet");
  });

  test("merges with existing settings, preserving other keys", async () => {
    mockFs.files.set(
      SETTINGS_PATH,
      JSON.stringify({ theme: "dark", fontSize: 14, env: { MY_CUSTOM_VAR: "hello" } })
    );
    mockFs.directories.add(CLAUDE_DIR);

    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    expect(result.status).toBe("applied");
    const writtenMerge = mockFs.files.get(SETTINGS_PATH);
    assertDefined(writtenMerge, "Expected settings.json to be written");
    const parsed = JSON.parse(writtenMerge);
    expect(parsed.model).toBe("sonnet");
    expect(parsed.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("60");
    expect(parsed.theme).toBe("dark");
    expect(parsed.fontSize).toBe(14);
    expect(parsed.env.MY_CUSTOM_VAR).toBe("hello");
  });

  test("env block is merged not replaced — preserves existing env vars", async () => {
    mockFs.files.set(SETTINGS_PATH, JSON.stringify({ env: { EXISTING_VAR: "keep-me" } }));
    mockFs.directories.add(CLAUDE_DIR);

    await applyClaudeCodeSettings({ homeDir: TEST_HOME, checkExists: claudeInstalled }, mockFs);

    const writtenEnv = mockFs.files.get(SETTINGS_PATH);
    assertDefined(writtenEnv, "Expected settings.json to be written");
    const parsed = JSON.parse(writtenEnv);
    expect(parsed.env.EXISTING_VAR).toBe("keep-me");
    expect(parsed.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("60");
  });

  test("idempotent: reports already-configured when all values match", async () => {
    mockFs.files.set(
      SETTINGS_PATH,
      JSON.stringify({
        model: "sonnet",
        env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "60" },
      })
    );
    mockFs.directories.add(CLAUDE_DIR);

    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    expect(result.status).toBe("already-configured");
    expect(result.changes).toHaveLength(0);
  });

  test("idempotent: does not write file when already configured", async () => {
    const originalContent = JSON.stringify({
      model: "sonnet",
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "60" },
    });
    mockFs.files.set(SETTINGS_PATH, originalContent);
    mockFs.directories.add(CLAUDE_DIR);

    await applyClaudeCodeSettings({ homeDir: TEST_HOME, checkExists: claudeInstalled }, mockFs);

    expect(mockFs.files.get(SETTINGS_PATH)).toBe(originalContent);
  });

  test("reports partial changes when only some settings differ", async () => {
    mockFs.files.set(SETTINGS_PATH, JSON.stringify({ model: "sonnet" }));
    mockFs.directories.add(CLAUDE_DIR);

    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    expect(result.status).toBe("applied");
    expect(result.changes).toHaveLength(1);
    const [envChange] = result.changes;
    assertDefined(envChange, "Expected one env change");
    expect(envChange.key).toBe("env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
    expect(envChange.from).toBeUndefined();
    expect(envChange.to).toBe("60");
  });

  test("reports change when existing model differs from recommended", async () => {
    mockFs.files.set(
      SETTINGS_PATH,
      JSON.stringify({
        model: "opus",
        env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "60" },
      })
    );
    mockFs.directories.add(CLAUDE_DIR);

    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    expect(result.status).toBe("applied");
    const modelChange = result.changes.find((c) => c.key === "model");
    expect(modelChange).toBeDefined();
    expect(modelChange?.from).toBe("opus");
    expect(modelChange?.to).toBe("sonnet");
  });

  test("dry-run: computes changes but does not write file", async () => {
    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled, dryRun: true },
      mockFs
    );

    expect(result.status).toBe("applied");
    expect(result.changes.length).toBeGreaterThan(0);
    expect(mockFs.files.has(SETTINGS_PATH)).toBe(false);
  });

  test("creates ~/.claude directory if it does not exist in mockFs", async () => {
    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    expect(result.status).toBe("applied");
    expect(mockFs.directories.has(CLAUDE_DIR)).toBe(true);
    expect(mockFs.files.has(SETTINGS_PATH)).toBe(true);
  });

  test("handles corrupted settings.json gracefully by treating it as empty", async () => {
    mockFs.files.set(SETTINGS_PATH, "{ this is not json }");
    mockFs.directories.add(CLAUDE_DIR);

    const result = await applyClaudeCodeSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    expect(result.status).toBe("applied");
    expect(result.changes).toHaveLength(2);
  });
});

describe("applyHarnessSettings", () => {
  let mockFs: MockFs;

  beforeEach(() => {
    mockFs = createMockFs();
  });

  test("returns array with claude-code result", async () => {
    const results = await applyHarnessSettings(
      { homeDir: TEST_HOME, checkExists: claudeInstalled },
      mockFs
    );

    expect(results).toHaveLength(1);
    const [claudeResult] = results;
    assertDefined(claudeResult, "Expected one harness result");
    expect(claudeResult.harness).toBe("claude-code");
  });

  test("returns not-detected when no harnesses installed", async () => {
    const results = await applyHarnessSettings(
      { homeDir: TEST_HOME, checkExists: nothingInstalled },
      mockFs
    );

    expect(results).toHaveLength(1);
    const [claudeResult] = results;
    assertDefined(claudeResult, "Expected one harness result");
    expect(claudeResult.status).toBe("not-detected");
  });
});
