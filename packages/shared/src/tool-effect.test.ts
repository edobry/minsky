import { describe, test, expect } from "bun:test";

import {
  classifyTool,
  canonicalToolId,
  ambiguityReason,
  isKnownUnclassified,
  MCP_COMMAND_EFFECTS,
  NATIVE_TOOL_EFFECTS,
  KNOWN_UNCLASSIFIED,
  AMBIGUOUS_TOOL_REASONS,
} from "./tool-effect";

describe("classifyTool — the specimens the mutating flag misses (AT2)", () => {
  // Every one of these writes, and every one leaves `SharedCommand.mutating`
  // unset — which is the defect this module exists to fix.
  test.each(["tasks.spec.patch", "tasks.status.set", "memory.create", "session.commit"])(
    "%s classifies as mutates",
    (id) => {
      expect(classifyTool(id)).toBe("mutates");
    }
  );
});

describe("classifyTool — reads are a POSITIVE verdict, not an absence (AT3)", () => {
  test.each(["tasks.get", "git.log", "memory.search"])("%s classifies as reads", (id) => {
    expect(classifyTool(id)).toBe("reads");
    // The distinction the boolean could not make: this is "reads", and an
    // unknown tool below is "unclassified". Both were `undefined` before.
    expect(classifyTool(id)).not.toBe("unclassified");
  });
});

/** A name no registry will ever carry — the "we have never heard of this" case. */
const UNREGISTERED_TOOL = "totally.made.up.tool";

describe("classifyTool — unknown stays unknown (AT4, SC6)", () => {
  test("an unregistered name is unclassified", () => {
    expect(classifyTool(UNREGISTERED_TOOL)).toBe("unclassified");
  });

  test("no helper coerces an unknown name to a positive verdict", () => {
    const verdict = classifyTool(UNREGISTERED_TOOL);
    expect(verdict === "mutates" || verdict === "reads").toBe(false);
    expect(ambiguityReason(UNREGISTERED_TOOL)).toBeUndefined();
    expect(isKnownUnclassified(UNREGISTERED_TOOL)).toBe(false);
  });

  test("a recorded gap is distinguishable from an unrecognized tool", () => {
    expect(classifyTool("tasks.analyze")).toBe("unclassified");
    expect(isKnownUnclassified("tasks.analyze")).toBe(true);
    expect(isKnownUnclassified(UNREGISTERED_TOOL)).toBe(false);
  });

  test("an argument-dependent tool is unclassified WITH a reason", () => {
    expect(classifyTool("session.exec")).toBe("unclassified");
    expect(ambiguityReason("session.exec")).toContain("arbitrary shell command");
    expect(classifyTool("Bash")).toBe("unclassified");
    expect(ambiguityReason("Bash")).toContain("arbitrary shell command");
  });
});

describe("classifyTool — harness-native tools (AT5)", () => {
  test.each(["Write", "Edit", "NotebookEdit"])("%s classifies as mutates", (name) => {
    expect(classifyTool(name)).toBe("mutates");
  });

  test("native reads classify as reads", () => {
    expect(classifyTool("Read")).toBe("reads");
    expect(classifyTool("Grep")).toBe("reads");
  });

  test("native tools are not SharedCommands, so no registry field could reach them", () => {
    // Guards the reason this table exists at all: if someone later moves these
    // into the registry, this assertion is where the duplication surfaces.
    for (const name of Object.keys(NATIVE_TOOL_EFFECTS)) {
      expect(MCP_COMMAND_EFFECTS[name]).toBeUndefined();
    }
  });
});

describe("canonicalToolId — the three spellings a caller may hold", () => {
  test("resolves the harness-prefixed underscore form", () => {
    expect(canonicalToolId("mcp__minsky__tasks_spec_patch")).toBe("tasks.spec.patch");
    expect(classifyTool("mcp__minsky__tasks_spec_patch")).toBe("mutates");
  });

  test("resolves the bare underscore alias", () => {
    expect(canonicalToolId("tasks_status_set")).toBe("tasks.status.set");
    expect(classifyTool("tasks_status_set")).toBe("mutates");
  });

  test("passes the canonical dotted form through unchanged", () => {
    expect(canonicalToolId("git.log")).toBe("git.log");
  });

  test("resolves ids whose own segments contain underscores", () => {
    // The lossy case: `session_pr_check_run_submit` cannot be recovered by
    // substituting dots for underscores, which is why resolution is a lookup.
    expect(canonicalToolId("session_pr_check_run_submit")).toBe("session.pr.check_run.submit");
    expect(classifyTool("mcp__minsky__git_stash_drop")).toBe("mutates");
    expect(classifyTool("deployment_wait-for-latest")).toBe("reads");
  });

  test("an unresolvable underscore name is returned as-is, not mangled", () => {
    expect(canonicalToolId("no_such_tool_here")).toBe("no_such_tool_here");
  });
});

describe("table integrity", () => {
  test("no id is both classified and recorded as a known gap", () => {
    const overlap = KNOWN_UNCLASSIFIED.filter((id) => MCP_COMMAND_EFFECTS[id] !== undefined);
    expect(overlap).toEqual([]);
  });

  test("every ambiguous tool is unclassified, never given a verdict", () => {
    for (const name of Object.keys(AMBIGUOUS_TOOL_REASONS)) {
      expect(classifyTool(name)).toBe("unclassified");
    }
  });

  test("every table verdict is one of the two positive states", () => {
    for (const verdict of Object.values(MCP_COMMAND_EFFECTS)) {
      expect(verdict === "mutates" || verdict === "reads").toBe(true);
    }
  });
});
