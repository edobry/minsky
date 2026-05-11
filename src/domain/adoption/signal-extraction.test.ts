/**
 * Unit tests for the fixed-schema adoption signal extraction module.
 *
 * Each test group covers one signal kind. Tests are fixture-driven:
 * feed a snippet, assert the correct signals are extracted.
 */

import { describe, it, expect } from "bun:test";
import {
  extractAdoptionSignals,
  buildGrepPattern,
} from "@minsky/shared/adoption/signal-extraction";
import type { AdoptionSignal } from "@minsky/shared/adoption/signal-extraction";

// ---------------------------------------------------------------------------
// Constants (avoids magic-string-duplication lint warnings)
// ---------------------------------------------------------------------------

const EVENT_PR_CLOSED = "pull_request.closed";
const EVENT_PR_OPENED = "pull_request.opened";
// Shared constants for lifecycleState tests (avoids magic-string-duplication warnings).
const STATE_TASK_STATUS_IN_PROGRESS = "TaskStatus" + ".IN_PROGRESS";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function signalsOfKind(signals: AdoptionSignal[], kind: AdoptionSignal["kind"]) {
  return signals.filter((s) => s.kind === kind);
}

/** Assert a signal exists with expected name and return it for further assertions. */
function findSignal(
  signals: AdoptionSignal[],
  kind: AdoptionSignal["kind"],
  name: string
): AdoptionSignal {
  const found = signals.find((s) => s.kind === kind && s.name === name);
  if (!found) {
    throw new Error(
      `Expected signal kind=${kind} name=${name} not found in ${JSON.stringify(signals)}`
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// function signals
// ---------------------------------------------------------------------------

describe("extractAdoptionSignals — function", () => {
  it("extracts a plain exported function", () => {
    const spec = `export function myHelper() {\n  return 1;\n}`;
    const signals = extractAdoptionSignals(spec);
    const fns = signalsOfKind(signals, "function");
    expect(fns).toHaveLength(1);
    const sig = findSignal(signals, "function", "myHelper");
    expect(sig.name).toBe("myHelper");
    expect(sig.sourceLine).toBe(1);
  });

  it("extracts an exported async function", () => {
    const spec = `export async function runSweep(deps: Deps) {}`;
    const signals = extractAdoptionSignals(spec);
    const fns = signalsOfKind(signals, "function");
    expect(fns).toHaveLength(1);
    const sig = findSignal(signals, "function", "runSweep");
    expect(sig.name).toBe("runSweep");
  });

  it("extracts multiple functions from different lines", () => {
    const spec = [
      "export function alpha() {}",
      "export function beta() {}",
      "export async function gamma() {}",
    ].join("\n");
    const signals = extractAdoptionSignals(spec);
    const fns = signalsOfKind(signals, "function");
    expect(fns).toHaveLength(3);
    const names = fns.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
  });

  it("does not extract non-exported functions", () => {
    const spec = `function internalHelper() {}`;
    const signals = extractAdoptionSignals(spec);
    expect(signalsOfKind(signals, "function")).toHaveLength(0);
  });

  it("extracts indented exports (PR #1034 R1 NB1: leading whitespace in fenced code blocks)", () => {
    // Markdown fenced code blocks under list items often have 2-4 leading spaces.
    const spec = "Inside a fenced block:\n```ts\n    export function deeplyIndented() {}\n```";
    const signals = extractAdoptionSignals(spec);
    const fns = signalsOfKind(signals, "function");
    expect(fns).toHaveLength(1);
    expect(findSignal(signals, "function", "deeplyIndented").name).toBe("deeplyIndented");
  });

  it("extracts indented exported classes (PR #1034 R1 NB1)", () => {
    const spec = "  export class IndentedClass {}";
    const signals = extractAdoptionSignals(spec);
    const classes = signalsOfKind(signals, "class");
    expect(classes).toHaveLength(1);
    expect(findSignal(signals, "class", "IndentedClass").name).toBe("IndentedClass");
  });

  it("deduplicates repeated occurrences of the same function name", () => {
    const spec = "export function foo() {}\nexport function foo() {}";
    const signals = extractAdoptionSignals(spec);
    const fns = signalsOfKind(signals, "function");
    expect(fns).toHaveLength(1);
  });

  it("reports correct source line number (1-based)", () => {
    const spec = "# Header\n\nexport function myFn() {}";
    const signals = extractAdoptionSignals(spec);
    const sig = findSignal(signals, "function", "myFn");
    expect(sig.sourceLine).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// class signals
// ---------------------------------------------------------------------------

describe("extractAdoptionSignals — class", () => {
  it("extracts an exported class", () => {
    const spec = `export class SessionManager {}`;
    const signals = extractAdoptionSignals(spec);
    const classes = signalsOfKind(signals, "class");
    expect(classes).toHaveLength(1);
    const sig = findSignal(signals, "class", "SessionManager");
    expect(sig.name).toBe("SessionManager");
  });

  it("does not extract non-exported classes", () => {
    const spec = `class InternalHelper {}`;
    expect(signalsOfKind(extractAdoptionSignals(spec), "class")).toHaveLength(0);
  });

  it("extracts multiple exported classes", () => {
    const spec = "export class Foo {}\nexport class Bar {}";
    const classes = signalsOfKind(extractAdoptionSignals(spec), "class");
    expect(classes).toHaveLength(2);
    expect(classes.map((c) => c.name)).toEqual(["Foo", "Bar"]);
  });
});

// ---------------------------------------------------------------------------
// hook signals
// ---------------------------------------------------------------------------

describe("extractAdoptionSignals — hook", () => {
  it("extracts a webhooks.on registration with double quotes", () => {
    const spec = `webhooks.on("${EVENT_PR_CLOSED}", handler);`;
    const signals = extractAdoptionSignals(spec);
    const hooks = signalsOfKind(signals, "hook");
    expect(hooks).toHaveLength(1);
    const sig = findSignal(signals, "hook", EVENT_PR_CLOSED);
    expect(sig.name).toBe(EVENT_PR_CLOSED);
  });

  it("extracts a webhooks.on registration with single quotes", () => {
    const spec = `webhooks.on('push', handler);`;
    const hooks = signalsOfKind(extractAdoptionSignals(spec), "hook");
    expect(hooks).toHaveLength(1);
    const sig = findSignal(extractAdoptionSignals(spec), "hook", "push");
    expect(sig.name).toBe("push");
  });

  it("extracts multiple webhook event registrations", () => {
    const spec = [
      `webhooks.on("${EVENT_PR_OPENED}", handleOpen);`,
      `webhooks.on("${EVENT_PR_CLOSED}", handleClose);`,
    ].join("\n");
    const hooks = signalsOfKind(extractAdoptionSignals(spec), "hook");
    expect(hooks).toHaveLength(2);
    const names = hooks.map((h) => h.name);
    expect(names).toContain(EVENT_PR_OPENED);
    expect(names).toContain(EVENT_PR_CLOSED);
  });

  it("deduplicates duplicate webhook registrations", () => {
    const spec = [
      `webhooks.on("${EVENT_PR_CLOSED}", handler1);`,
      `webhooks.on("${EVENT_PR_CLOSED}", handler2);`,
    ].join("\n");
    const hooks = signalsOfKind(extractAdoptionSignals(spec), "hook");
    expect(hooks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mcpTool signals
// ---------------------------------------------------------------------------

describe("extractAdoptionSignals — mcpTool", () => {
  it("extracts an MCP tool id in dot-namespaced form", () => {
    const spec = `id: "session.list"`;
    const signals = extractAdoptionSignals(spec);
    const tools = signalsOfKind(signals, "mcpTool");
    expect(tools).toHaveLength(1);
    const sig = findSignal(signals, "mcpTool", "session.list");
    expect(sig.name).toBe("session.list");
  });

  it("extracts id with single quotes", () => {
    const spec = `id: 'tasks.get'`;
    const tools = signalsOfKind(extractAdoptionSignals(spec), "mcpTool");
    expect(tools).toHaveLength(1);
    const sig = findSignal(extractAdoptionSignals(spec), "mcpTool", "tasks.get");
    expect(sig.name).toBe("tasks.get");
  });

  it("extracts multiple MCP tool ids", () => {
    const toolIds = ["session.list", "tasks.create", "git.status"];
    const spec = toolIds.map((id) => `id: "${id}"`).join("\n");
    const tools = signalsOfKind(extractAdoptionSignals(spec), "mcpTool");
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("session.list");
    expect(names).toContain("tasks.create");
    expect(names).toContain("git.status");
  });

  it("does not match single-segment IDs (no dot)", () => {
    // A bare word like `id: "foo"` should not be treated as an MCP tool
    const spec = `id: "foo"`;
    const tools = signalsOfKind(extractAdoptionSignals(spec), "mcpTool");
    expect(tools).toHaveLength(0);
  });

  it("extracts deeply-namespaced tool ids", () => {
    const spec = `id: "session.pr.get"`;
    const tools = signalsOfKind(extractAdoptionSignals(spec), "mcpTool");
    expect(tools).toHaveLength(1);
    const sig = findSignal(extractAdoptionSignals(spec), "mcpTool", "session.pr.get");
    expect(sig.name).toBe("session.pr.get");
  });
});

// ---------------------------------------------------------------------------
// commandId signals
// ---------------------------------------------------------------------------

describe("extractAdoptionSignals — commandId", () => {
  it("extracts a commandId key", () => {
    const spec = `commandId: "session.start"`;
    const signals = extractAdoptionSignals(spec);
    const cmdIds = signalsOfKind(signals, "commandId");
    expect(cmdIds).toHaveLength(1);
    const sig = findSignal(signals, "commandId", "session.start");
    expect(sig.name).toBe("session.start");
  });

  it("deduplicates repeated commandId values", () => {
    const spec = `commandId: "session.start"\ncommandId: "session.start"`;
    const cmdIds = signalsOfKind(extractAdoptionSignals(spec), "commandId");
    expect(cmdIds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// lifecycleState signals
// ---------------------------------------------------------------------------

describe("extractAdoptionSignals — lifecycleState", () => {
  // PR #1034 R2 BLOCKING fix: signal name is now the FULL qualified reference
  // (e.g. "STATUS.DONE"), not just the bare state token. This prevents a grep
  // for ".DONE" from matching unrelated enums.

  it("extracts STATUS.DONE as the qualified name", () => {
    const spec = `status === STATUS.DONE`;
    const signals = extractAdoptionSignals(spec);
    const states = signalsOfKind(signals, "lifecycleState");
    expect(states).toHaveLength(1);
    const sig = findSignal(signals, "lifecycleState", "STATUS.DONE");
    expect(sig.name).toBe("STATUS.DONE");
  });

  it("extracts TaskStatus.IN_PROGRESS as the qualified name", () => {
    const spec = `task.status = TaskStatus.IN_PROGRESS`;
    const states = signalsOfKind(extractAdoptionSignals(spec), "lifecycleState");
    expect(states).toHaveLength(1);
    const sig = findSignal(
      extractAdoptionSignals(spec),
      "lifecycleState",
      STATE_TASK_STATUS_IN_PROGRESS
    );
    expect(sig.name).toBe(STATE_TASK_STATUS_IN_PROGRESS);
  });

  it("extracts SessionStatus.MERGED as the qualified name", () => {
    const spec = `session.status === SessionStatus.MERGED`;
    const states = signalsOfKind(extractAdoptionSignals(spec), "lifecycleState");
    expect(states).toHaveLength(1);
    const sig = findSignal(extractAdoptionSignals(spec), "lifecycleState", "SessionStatus.MERGED");
    expect(sig.name).toBe("SessionStatus.MERGED");
  });

  it("treats STATUS.DONE and TaskStatus.DONE as distinct signals (different qualifiers)", () => {
    // PR #1034 R2: bare ".DONE" would conflate these; qualified names keep them distinct.
    const spec = ["if (status === STATUS.DONE) return;", "task.status = TaskStatus.DONE;"].join(
      "\n"
    );
    const states = signalsOfKind(extractAdoptionSignals(spec), "lifecycleState");
    expect(states).toHaveLength(2);
    const names = states.map((s) => s.name);
    expect(names).toContain("STATUS.DONE");
    expect(names).toContain("TaskStatus.DONE");
  });

  it("extracts multiple lifecycle states from different lines", () => {
    const spec = ["if (status === STATUS.DONE) return;", "task.status = STATUS.IN_REVIEW;"].join(
      "\n"
    );
    const states = signalsOfKind(extractAdoptionSignals(spec), "lifecycleState");
    expect(states).toHaveLength(2);
    const names = states.map((s) => s.name);
    expect(names).toContain("STATUS.DONE");
    expect(names).toContain("STATUS.IN_REVIEW");
  });

  it("deduplicates the same lifecycle state appearing multiple times", () => {
    const spec = "STATUS.DONE\nSTATUS.DONE\nSTATUS.DONE";
    const states = signalsOfKind(extractAdoptionSignals(spec), "lifecycleState");
    expect(states).toHaveLength(1);
    expect(states[0]?.name).toBe("STATUS.DONE");
  });
});

// ---------------------------------------------------------------------------
// Mixed spec — multiple signal kinds together
// ---------------------------------------------------------------------------

describe("extractAdoptionSignals — mixed spec", () => {
  it("extracts signals of multiple kinds from a realistic spec snippet", () => {
    // NOTE: function/class patterns require `export` at the start of the line
    // (they are anchored with ^). In real spec text, these typically appear in
    // fenced code blocks where they're at line-start, not inline backtick form.
    const spec = [
      "## Success Criteria",
      "",
      "```typescript",
      "export function startAdoptionSweeper(config, cfg) {}",
      "export class AdoptionSweeper {}",
      `webhooks.on("${EVENT_PR_CLOSED}", handler);`,
      "```",
      "",
      `MCP tool \`id: "session.apply_post_merge_state_sync"\` is callable.`,
      "Task reaches `STATUS.DONE` after a merge.",
    ].join("\n");

    const signals = extractAdoptionSignals(spec);

    expect(signalsOfKind(signals, "function").map((s) => s.name)).toContain("startAdoptionSweeper");
    expect(signalsOfKind(signals, "hook").map((s) => s.name)).toContain(EVENT_PR_CLOSED);
    expect(signalsOfKind(signals, "mcpTool").map((s) => s.name)).toContain(
      "session.apply_post_merge_state_sync"
    );
    expect(signalsOfKind(signals, "lifecycleState").map((s) => s.name)).toContain("STATUS.DONE");
    expect(signalsOfKind(signals, "class").map((s) => s.name)).toContain("AdoptionSweeper");
  });
});

// ---------------------------------------------------------------------------
// Empty / trivial inputs
// ---------------------------------------------------------------------------

describe("extractAdoptionSignals — edge cases", () => {
  it("returns empty array for empty spec text", () => {
    expect(extractAdoptionSignals("")).toHaveLength(0);
  });

  it("returns empty array for spec text with no code patterns", () => {
    const spec = [
      "# Summary",
      "This task adds a new feature to the system.",
      "## Acceptance Tests",
      "- The feature works.",
    ].join("\n");
    expect(extractAdoptionSignals(spec)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildGrepPattern
// ---------------------------------------------------------------------------

describe("buildGrepPattern", () => {
  it("returns function name for function signals", () => {
    const signal: AdoptionSignal = { kind: "function", name: "myHelper", sourceLine: 1 };
    expect(buildGrepPattern(signal)).toBe("myHelper");
  });

  it("returns class name for class signals", () => {
    const signal: AdoptionSignal = { kind: "class", name: "SessionManager", sourceLine: 1 };
    expect(buildGrepPattern(signal)).toBe("SessionManager");
  });

  it("returns quoted event name for hook signals", () => {
    const signal: AdoptionSignal = { kind: "hook", name: EVENT_PR_CLOSED, sourceLine: 1 };
    expect(buildGrepPattern(signal)).toBe(`"${EVENT_PR_CLOSED}"`);
  });

  it("returns quoted tool id for mcpTool signals", () => {
    const signal: AdoptionSignal = { kind: "mcpTool", name: "session.list", sourceLine: 1 };
    expect(buildGrepPattern(signal)).toBe('"session.list"');
  });

  it("returns quoted id for commandId signals", () => {
    const signal: AdoptionSignal = { kind: "commandId", name: "session.start", sourceLine: 1 };
    expect(buildGrepPattern(signal)).toBe('"session.start"');
  });

  it("returns the qualified token for lifecycleState signals (PR #1034 R2 BLOCKING fix)", () => {
    // Previously returned ".DONE" which matched any `.DONE` reference anywhere.
    // Now returns the qualified form so the grep doesn't conflate with
    // unrelated enums.
    const sigStatus: AdoptionSignal = {
      kind: "lifecycleState",
      name: "STATUS.DONE",
      sourceLine: 1,
    };
    expect(buildGrepPattern(sigStatus)).toBe("STATUS.DONE");

    const sigTask: AdoptionSignal = {
      kind: "lifecycleState",
      name: STATE_TASK_STATUS_IN_PROGRESS,
      sourceLine: 1,
    };
    expect(buildGrepPattern(sigTask)).toBe(STATE_TASK_STATUS_IN_PROGRESS);
  });
});
