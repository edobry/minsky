/**
 * Tests for the project setup guard.
 */

import { describe, it, expect } from "bun:test";
import { checkProjectSetup, guardProjectSetup, EXEMPT_COMMANDS } from "./guard";
import { ValidationError } from "../../errors/index";

const FAKE_REPO = "/fake/repo";
const CONFIG_YAML = `${FAKE_REPO}/.minsky/config.yaml`;
const CONFIG_LOCAL_YAML = `${FAKE_REPO}/.minsky/config.local.yaml`;

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
    expect(() => checkProjectSetup(FAKE_REPO, deps)).toThrow(
      "This project hasn't been initialized. Run `minsky init` first."
    );
  });

  it("throws ValidationError with minsky setup guidance when config.yaml exists but config.local.yaml is missing", () => {
    const deps = {
      existsSync: makeExistsSync(new Set([CONFIG_YAML])),
    };
    expect(() => checkProjectSetup(FAKE_REPO, deps)).toThrow(ValidationError);
    expect(() => checkProjectSetup(FAKE_REPO, deps)).toThrow(
      "Developer setup incomplete. Run `minsky setup` first."
    );
  });

  it("does not throw when both config.yaml and config.local.yaml exist", () => {
    const deps = {
      existsSync: makeExistsSync(new Set([CONFIG_YAML, CONFIG_LOCAL_YAML])),
    };
    expect(() => checkProjectSetup(FAKE_REPO, deps)).not.toThrow();
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
      "This project hasn't been initialized. Run `minsky init` first."
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
