/**
 * Consequence-vs-capability rendering tests (mt#4437).
 *
 * mt#4238 weighted a tool call by what its tool CAN do — `classifyTool(name)`,
 * a lookup that cannot be wrong about the class and cannot be right about the
 * event. So a `tasks_status_set` returning `changed: false` rendered
 * identically to one that flipped a status, and the row asserted an effect that
 * never occurred.
 *
 * What this suite pins is the inverse of mt#4238's registry test: a mutating
 * NAME whose RESULT reports no change must NOT render at the actuation step.
 * The signal is indexical — derived from the payload the call actually
 * produced — so it cannot claim an actuation that did not happen.
 *
 * The `unknown` cases are the other half and matter just as much: an unpaired
 * result, an error, and a payload carrying no delta must all keep today's
 * capability weight rather than being rendered as no-ops. Stepping down on an
 * ABSENCE of evidence would be a different false claim, not a fix.
 *
 * Assertions are class-shaped, not geometric: the component suite runs under
 * happy-dom, which has no layout engine (`src/cockpit/CLAUDE.md` §"Asserting
 * layout geometry").
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationView } from "./ConversationView";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderCV(snapshot: SessionContextSnapshot) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createTestQueryClient()}>
        <ConversationView snapshot={snapshot} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function ts(index: number): string {
  return new Date(Date.UTC(2026, 7, 23, 12, 0, index)).toISOString();
}

function callBlock(
  index: number,
  toolUseId: string,
  name: string,
  input: unknown
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function resultBlock(
  index: number,
  toolUseId: string,
  content: unknown,
  isError = false
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
  };
}

function snapshotWithBlocks(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "agent-consequence-weight-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-08-23T12:00:00.000Z",
  };
}

function toolRow(container: HTMLElement, toolUseId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-tool-use-id="${toolUseId}"]`);
  if (!el) throw new Error(`no tool row rendered for ${toolUseId}`);
  return el;
}

function nameSpan(row: HTMLElement): HTMLElement {
  const el = row.querySelector<HTMLElement>("span[title]");
  if (!el) throw new Error("no tool-name span in row");
  return el;
}

function digestText(row: HTMLElement): string {
  const el = row.querySelector<HTMLElement>("span.truncate");
  if (!el) throw new Error("no digest span in row");
  return el.textContent ?? "";
}

const STATUS_SET = "mcp__minsky__tasks_status_set";

/** Render one call (optionally with a result) and return its row. */
function rowFor(name: string, input: unknown, result?: { content: unknown; isError?: boolean }) {
  const blocks: SessionContextSnapshotBlock[] = [callBlock(0, "call-x", name, input)];
  if (result) blocks.push(resultBlock(1, "call-x", result.content, result.isError ?? false));
  const { container } = renderCV(snapshotWithBlocks(blocks));
  return toolRow(container, "call-x");
}

function nameClasses(
  name: string,
  input: unknown,
  result?: { content: unknown; isError?: boolean }
): string {
  return nameSpan(rowFor(name, input, result)).className;
}

const CHANGED = JSON.stringify({
  success: true,
  taskId: "mt#4437",
  previousStatus: "TODO",
  newStatus: "PLANNING",
  changed: true,
});

const UNCHANGED = JSON.stringify({
  success: true,
  taskId: "mt#4437",
  previousStatus: "PLANNING",
  newStatus: "PLANNING",
  changed: false,
});

describe("consequence drives the weight step, not the tool name", () => {
  afterEach(cleanup);

  test("a no-change result renders differently from one that changed something", () => {
    const changed = nameClasses(STATUS_SET, { taskId: "mt#4437" }, { content: CHANGED });
    const unchanged = nameClasses(STATUS_SET, { taskId: "mt#4437" }, { content: UNCHANGED });
    expect(changed).not.toBe(unchanged);
  });

  test("a mutating NAME with a no-change result does not render at actuation weight", () => {
    // The inverse of mt#4238's registry test: the name says `mutates`, and the
    // payload overrides it.
    expect(nameClasses(STATUS_SET, { taskId: "mt#4437" }, { content: UNCHANGED })).not.toContain(
      "font-semibold"
    );
  });

  test("a real change keeps the actuation weight mt#4238 established", () => {
    expect(nameClasses(STATUS_SET, { taskId: "mt#4437" }, { content: CHANGED })).toContain(
      "font-semibold"
    );
  });

  test("an UNPAIRED result renders at capability weight and never as a no-op", () => {
    // mt#3481's windowing case. Absence of a result is not evidence of absence
    // of effect, so this must look like the changed case, not the no-op case.
    const unpaired = nameClasses(STATUS_SET, { taskId: "mt#4437" });
    expect(unpaired).toContain("font-semibold");
    expect(unpaired).not.toBe(nameClasses(STATUS_SET, { taskId: "mt#4437" }, { content: UNCHANGED }));
  });

  test("an ERRORED call is not treated as a no-op", () => {
    // A call can mutate and then fail, so an error must not read as "nothing
    // happened". It renders at the DESTRUCTIVE tier, which sits above the whole
    // read/write step (mt#4220) — so what this pins is that the error treatment
    // is what shows, and that it is not the recessive no-op rendering.
    const errored = nameClasses(
      STATUS_SET,
      { taskId: "mt#4437" },
      { content: "boom", isError: true }
    );
    expect(errored).toContain("text-destructive");
    expect(errored).not.toBe(nameClasses(STATUS_SET, { taskId: "mt#4437" }, { content: UNCHANGED }));
  });

  test("a payload carrying no delta keeps capability weight", () => {
    // `tasks_spec_patch` reports success without saying whether content changed.
    expect(
      nameClasses(
        "mcp__minsky__tasks_spec_patch",
        { taskId: "mt#4437" },
        { content: JSON.stringify({ success: true, taskId: "mt#4437", message: "ok" }) }
      )
    ).toContain("font-semibold");
  });
});

describe("consequence digests report the delta, not the target", () => {
  afterEach(cleanup);

  test("a status transition renders both sides", () => {
    const text = digestText(rowFor(STATUS_SET, { taskId: "mt#4437" }, { content: CHANGED }));
    expect(text).toContain("TODO");
    expect(text).toContain("PLANNING");
  });

  test("a no-op status set shows the same value on both sides", () => {
    // The no-op is expressed as DATA, not as a coined vocabulary word — mt#3130
    // owns the on-screen vocabulary and has no term for this.
    const text = digestText(rowFor(STATUS_SET, { taskId: "mt#4437" }, { content: UNCHANGED }));
    expect(text).toContain("PLANNING → PLANNING");
  });

  test("a commit reports files and line delta rather than a byte count", () => {
    const text = digestText(
      rowFor(
        "mcp__minsky__session_commit",
        { message: "x" },
        { content: JSON.stringify({ filesChanged: 2, insertions: 26, deletions: 2 }) }
      )
    );
    expect(text).toContain("2 files");
    expect(text).toContain("+26");
    expect(text).not.toContain("ok ·");
  });

  test("an empty commit reports zero files, not a receipt size", () => {
    const text = digestText(
      rowFor(
        "mcp__minsky__session_commit",
        { message: "x" },
        { content: JSON.stringify({ filesChanged: 0, insertions: 0, deletions: 0 }) }
      )
    );
    expect(text).toContain("0 files");
  });

  test("memory_create reports the minted id", () => {
    const text = digestText(
      rowFor(
        "mcp__minsky__memory_create",
        { name: "x" },
        { content: JSON.stringify({ id: "uuid-x", shortId: "mem#1188" }) }
      )
    );
    expect(text).toContain("mem#1188");
  });
});
