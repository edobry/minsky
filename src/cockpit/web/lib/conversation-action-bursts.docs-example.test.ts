/**
 * The fold example in `docs/cockpit-ui.md` is checked against real output (mt#4250).
 *
 * ## Why this test exists
 *
 * The example in that doc was written twice from the format's INTENT and was
 * wrong both times — once with the segments in the wrong order (MCP before
 * shell, where `summarizeBurst` emits verb families first). Nothing caught it:
 * typecheck, lint and 2405 component tests were green, the reviewer required
 * the documentation and approved the PR containing it, and a careful re-read
 * confirms the sentence because the prose and the intent agree. A literal
 * sample of program output is a testable assertion written in a place no test
 * reads — this file is the test that reads it.
 *
 * ## Why it parses the doc rather than duplicating the string
 *
 * Asserting `summarizeBurst(fixture) === "<a string in this file>"` would pin
 * the FORMAT and leave the doc free to drift, which is the defect it is meant
 * to prevent. The doc is the source of truth for its own example, so the test
 * reads it. If someone edits the example by hand, or changes the summary
 * format without updating the example, this fails and names both sides.
 *
 * R8 of `family:assertion-without-verification` (anchor mt#2544). The family's
 * per-surface tier is explicitly NOT containing it (mem#1056), so this ships as
 * the deterministic half of a paired response — the escalation is recorded on
 * the anchor, not replaced by this file.
 */
import { describe, test, expect } from "bun:test";
/*
 * Why the fs disables below are correct rather than a workaround:
 * Reading the REAL doc is the entire point of this file. The rule prevents
 * filesystem INTERFERENCE — tests racing on shared mutable state — and this
 * test only reads one committed, version-controlled file and never writes.
 * Injecting a mock fs would make the test assert against a string supplied by
 * the test itself, which is precisely the drift this file exists to catch.
 */
// eslint-disable-next-line custom/no-real-fs-in-tests
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeBurst } from "./conversation-action-bursts";
import type { PreparedElement } from "../components/ConversationElementRenderers";
import type { PreparedTurn } from "./conversation-turn-assembly";

/** Repo root, from `src/cockpit/web/lib/`. */
const DOC_PATH = join(import.meta.dir, "../../../../docs/cockpit-ui.md");

function turn(elements: PreparedElement[], secondsFromStart: number): PreparedTurn {
  return {
    blockId: `b${secondsFromStart}`,
    role: "assistant",
    timestamp: new Date(Date.UTC(2026, 7, 18, 12, 0, secondsFromStart)).toISOString(),
    elements,
    isSpawnBoundary: false,
  };
}

function call(name: string): PreparedElement {
  return {
    kind: "tool-invocation",
    call: { kind: "tool-call", id: name, name, input: {} },
  } as PreparedElement;
}

/**
 * The burst the doc's example describes, in the doc's own terms: one thinking
 * block, two shell commands, one mutating Minsky call, four reads, spanning a
 * minute. Constructing it here is what makes the comparison meaningful — the
 * doc claims a specific string for a specific shape.
 */
function documentedBurst(): PreparedTurn[] {
  return [
    turn([{ kind: "thinking", thinking: "considering" }], 0),
    turn([call("Bash")], 5),
    turn([call("Bash")], 10),
    turn([call("mcp__minsky__tasks_spec_patch")], 15),
    turn([call("mcp__minsky__tasks_get")], 20),
    turn([call("mcp__minsky__git_log")], 25),
    turn([call("mcp__minsky__memory_search")], 30),
    turn([call("mcp__minsky__tasks_list")], 60),
  ];
}

/** The example line from the doc's fenced block, with its `▸ ` chevron removed. */
function documentedExample(): string {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see the note above the import
  const doc = readFileSync(DOC_PATH, "utf8");
  const match = /^▸ (.+)$/m.exec(doc);
  if (match?.[1] === undefined) {
    throw new Error(
      `no "▸ …" example line found in ${DOC_PATH} — if the fold docs moved or the ` +
        `example was reformatted, update this test rather than deleting it.`
    );
  }
  return match[1];
}

describe("docs/cockpit-ui.md fold example (mt#4250)", () => {
  test("the documented summary line is what summarizeBurst actually emits", () => {
    expect(summarizeBurst(documentedBurst())).toBe(documentedExample());
  });
});
