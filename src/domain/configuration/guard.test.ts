/**
 * Tests for the project setup guard.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  checkProjectSetup,
  guardProjectSetup,
  EXEMPT_COMMANDS,
  setHostedMode,
  isHostedMode,
} from "./guard";
import { ValidationError } from "../../errors/index";

const FAKE_REPO = "/fake/repo";
const CONFIG_YAML = `${FAKE_REPO}/.minsky/config.yaml`;
const CONFIG_LOCAL_YAML = `${FAKE_REPO}/.minsky/config.local.yaml`;

const SESSION_REPO = "/home/user/.local/state/minsky/sessions/d4be5fee-86a3-4235-89b8-9a8bbf54c610";
const SESSION_CONFIG_YAML = `${SESSION_REPO}/.minsky/config.yaml`;

// Error message constants to avoid magic string duplication
const ERR_NOT_INITIALIZED = "This project hasn't been initialized. Run `minsky init` first.";
const ERR_SETUP_INCOMPLETE = "Developer setup incomplete. Run `minsky setup` first.";

/**
 * Create a minimal mock existsSync that returns true only for paths in the given set.
 */
function makeExistsSync(existingPaths: Set<string>): (p: string) => boolean {
  return (p: string) => existingPaths.has(p);
}

describe("checkProjectSetup", () => {
  it("throws ValidationError with minsky init guidance when config.yaml is missing", () => {
    const deps = { existsSync: makeExistsSync(new Set()) };
    expect(() => checkProjectSetup(FAKE_REPO, deps)).toThrow(ValidationError);
    expect(() => checkProjectSetup(FAKE_REPO, deps)).toThrow(ERR_NOT_INITIALIZED);
  });

  it("throws ValidationError with minsky setup guidance when config.yaml exists but config.local.yaml is missing", () => {
    const deps = {
      existsSync: makeExistsSync(new Set([CONFIG_YAML])),
    };
    expect(() => checkProjectSetup(FAKE_REPO, deps)).toThrow(ValidationError);
    expect(() => checkProjectSetup(FAKE_REPO, deps)).toThrow(ERR_SETUP_INCOMPLETE);
  });

  it("does not throw when both config.yaml and config.local.yaml exist", () => {
    const deps = {
      existsSync: makeExistsSync(new Set([CONFIG_YAML, CONFIG_LOCAL_YAML])),
    };
    expect(() => checkProjectSetup(FAKE_REPO, deps)).not.toThrow();
  });

  it("does not throw in a session directory even when config.local.yaml is missing", () => {
    // Session directories have config.yaml (checked in) but not config.local.yaml (gitignored)
    const deps = {
      existsSync: makeExistsSync(new Set([SESSION_CONFIG_YAML])),
    };
    expect(() => checkProjectSetup(SESSION_REPO, deps)).not.toThrow();
  });

  it("still requires config.yaml in session directories", () => {
    // Missing config.yaml in a session directory should still throw
    const deps = { existsSync: makeExistsSync(new Set()) };
    expect(() => checkProjectSetup(SESSION_REPO, deps)).toThrow(ValidationError);
    expect(() => checkProjectSetup(SESSION_REPO, deps)).toThrow(ERR_NOT_INITIALIZED);
  });
});

describe("guardProjectSetup", () => {
  const missingDeps = { existsSync: makeExistsSync(new Set()) };
  const fullDeps = {
    existsSync: makeExistsSync(new Set([CONFIG_YAML, CONFIG_LOCAL_YAML])),
  };

  it("does not throw for exempt commands even when project is not initialized", () => {
    for (const commandId of EXEMPT_COMMANDS) {
      expect(() => guardProjectSetup(commandId, FAKE_REPO, missingDeps)).not.toThrow();
    }
  });

  it("throws for non-exempt commands when project is not initialized", () => {
    expect(() => guardProjectSetup("tasks.list", FAKE_REPO, missingDeps)).toThrow(ValidationError);
    expect(() => guardProjectSetup("tasks.list", FAKE_REPO, missingDeps)).toThrow(
      ERR_NOT_INITIALIZED
    );
  });

  it("passes for non-exempt commands when project is fully initialized", () => {
    expect(() => guardProjectSetup("tasks.list", FAKE_REPO, fullDeps)).not.toThrow();
  });
});

describe("EXEMPT_COMMANDS", () => {
  it("contains init, setup, and mcp.register", () => {
    expect(EXEMPT_COMMANDS.has("init")).toBe(true);
    expect(EXEMPT_COMMANDS.has("setup")).toBe(true);
    expect(EXEMPT_COMMANDS.has("mcp.register")).toBe(true);
  });
});

describe("hosted mode", () => {
  const missingDeps = { existsSync: makeExistsSync(new Set()) };

  afterEach(() => {
    // Reset so module state does not leak into other tests.
    setHostedMode(false);
  });

  it("setHostedMode toggles the flag", () => {
    expect(isHostedMode()).toBe(false);
    setHostedMode(true);
    expect(isHostedMode()).toBe(true);
    setHostedMode(false);
    expect(isHostedMode()).toBe(false);
  });

  it("guardProjectSetup is a no-op for non-exempt commands when hosted mode is on", () => {
    setHostedMode(true);
    expect(() => guardProjectSetup("tasks.list", FAKE_REPO, missingDeps)).not.toThrow();
    expect(() => guardProjectSetup("tasks.spec.get", FAKE_REPO, missingDeps)).not.toThrow();
  });

  it("guardProjectSetup still throws when hosted mode is off (preserved stdio behavior)", () => {
    // Default state — no setHostedMode(true) call.
    expect(() => guardProjectSetup("tasks.list", FAKE_REPO, missingDeps)).toThrow(ValidationError);
  });
});
