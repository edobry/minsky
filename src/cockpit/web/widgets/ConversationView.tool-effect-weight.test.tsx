/**
 * ConversationView read-vs-write weight tests (mt#4238).
 *
 * mt#4220 made every healthy tool row recede UNIFORMLY. This task splits that
 * tier in two: a call the registry classifies as `mutates` carries more weight
 * than one it classifies as `reads`, and anything `unclassified` takes the read
 * treatment rather than a guessed one.
 *
 * **These assertions deliberately do NOT hard-code which tools are writes.**
 * The whole point of mt#3847's classifier is that the verdict comes from the
 * registry rather than from a tool name's spelling, so a test that re-encoded a
 * name list here would pass while the render read the wrong source. Instead the
 * cross-check test below asks `classifyTool` at assert time and requires the
 * render to agree with it — and the fixtures are chosen so a substring matcher
 * would get them WRONG (`session_generate_prompt` reads; `rules_generate`
 * mutates).
 *
 * Class-shaped rather than geometric, for the same reason as the mt#4220 suite:
 * the component tests run under happy-dom, which has no layout engine
 * (`src/cockpit/CLAUDE.md` §"Asserting layout geometry").
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { classifyTool } from "@minsky/shared/tool-effect";
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
  return new Date(Date.UTC(2026, 7, 21, 12, 0, index)).toISOString();
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
    agentSessionId: "agent-tool-effect-weight-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-08-21T12:00:00.000Z",
  };
}

/** One rendered call+result block, addressed by its anchor attr. */
function toolRow(container: HTMLElement, toolUseId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-tool-use-id="${toolUseId}"]`);
  if (!el) throw new Error(`no tool row rendered for ${toolUseId}`);
  return el;
}

/** The tool-NAME span — the element carrying the weight step. */
function nameSpan(row: HTMLElement): HTMLElement {
  const el = row.querySelector<HTMLElement>("span[title]");
  if (!el) throw new Error("no tool-name span in row");
  return el;
}

/** Render one call and hand back its name span's class list. */
function nameClassesFor(name: string): string {
  const { container } = renderCV(
    snapshotWithBlocks([callBlock(0, "call-x", name, {}), resultBlock(1, "call-x", "ok")])
  );
  return nameSpan(toolRow(container, "call-x")).className;
}

/** The tool ICON — the second element carrying the step. */
function iconEl(row: HTMLElement): SVGElement {
  const el = row.querySelector<SVGElement>("svg");
  if (!el) throw new Error("no tool icon in row");
  return el;
}

/** The arg/outcome DIGEST — the third. */
function digestEl(row: HTMLElement): HTMLElement {
  const el = row.querySelector<HTMLElement>("span.truncate");
  if (!el) throw new Error("no digest span in row");
  return el;
}

/**
 * Does this class list read as the MUTATION step?
 *
 * Keyed on font-weight rather than on the exact colour token: the weight step
 * is the property both rows always set, so this stays true if the brightness
 * values are retuned (which is expected — they are a visual judgment the
 * principal owns) while still failing if the two steps collapse into one.
 */
function readsAsMutation(classes: string): boolean {
  return classes.includes("font-semibold");
}

describe("ConversationView — read-vs-write weight (mt#4238)", () => {
  afterEach(cleanup);

  test("a write and a read in the same turn carry different weight", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        callBlock(0, "call-read", "WebFetch", { url: "https://news.ycombinator.com/" }),
        resultBlock(1, "call-read", "200 OK"),
        callBlock(2, "call-write", "mcp__minsky__tasks_spec_patch", { taskId: "mt#3842" }),
        resultBlock(3, "call-write", "patched"),
      ])
    );

    const readClasses = nameSpan(toolRow(container, "call-read")).className;
    const writeClasses = nameSpan(toolRow(container, "call-write")).className;

    // The defect this task fixes is that these two were IDENTICAL.
    expect(writeClasses).not.toBe(readClasses);
    expect(readsAsMutation(writeClasses)).toBe(true);
    expect(readsAsMutation(readClasses)).toBe(false);
  });

  test("all THREE elements step together — icon and digest, not just the name", () => {
    // The step is carried by three elements so it survives being read at a
    // glance. Asserting only the name would let two thirds of it regress
    // silently — a partial step is the failure mode this pins, not a missing
    // one (PR #3228 R1).
    const { container } = renderCV(
      snapshotWithBlocks([
        callBlock(0, "call-read", "mcp__minsky__tasks_get", { taskId: "mt#1" }),
        resultBlock(1, "call-read", "ok"),
        callBlock(2, "call-write", "mcp__minsky__tasks_spec_patch", { taskId: "mt#1" }),
        resultBlock(3, "call-write", "patched"),
      ])
    );

    const read = toolRow(container, "call-read");
    const write = toolRow(container, "call-write");

    // Compared to each other rather than to literal token values: the exact
    // brightness is a visual judgment the principal owns and is expected to be
    // retuned, but the two steps must never collapse into one.
    expect(iconEl(write).getAttribute("class")).not.toBe(iconEl(read).getAttribute("class"));
    expect(digestEl(write).className).not.toBe(digestEl(read).className);
    expect(nameSpan(write).className).not.toBe(nameSpan(read).className);
  });

  test("the weight follows the registry verdict, not the tool name's spelling", () => {
    // Every pair here would be classified WRONG by a substring matcher on the
    // name — which is exactly the inference mt#3845 SC3 forbids and mt#3847's
    // module rules out. The expected value is read from `classifyTool` at
    // assert time rather than written down here, so this test cannot drift
    // away from the registry it is checking.
    const fixtures = [
      "mcp__minsky__session_generate_prompt", // "generate" — but it reads
      "mcp__minsky__rules_generate", // same verb — and it mutates
      "mcp__minsky__git_log", // shares its shape with git_reset
      "mcp__minsky__git_reset", // …which mutates
      "mcp__minsky__tasks_status_get",
      "mcp__minsky__tasks_status_set",
      "Read",
      "Write",
    ];

    for (const name of fixtures) {
      cleanup();
      const expectedMutation = classifyTool(name) === "mutates";
      expect({ name, mutation: readsAsMutation(nameClassesFor(name)) }).toEqual({
        name,
        mutation: expectedMutation,
      });
    }
  });

  test("a tool absent from the registry renders at read weight, with no mutation signal", () => {
    // `classifyTool` answers `unclassified` for an unknown name and never
    // coerces that into a positive verdict in either direction.
    const name = "mcp__acme__frobnicate_the_widget";
    expect(classifyTool(name)).toBe("unclassified");
    expect(readsAsMutation(nameClassesFor(name))).toBe(false);
  });

  test("Bash renders at read weight — the documented limit of this surface", () => {
    // Bash is unclassified BY CONSTRUCTION (its effect is whatever the caller
    // passed), so `Bash git commit` cannot be distinguished from `Bash ls`.
    // Pinned as a test so the limit is visible rather than folklore, and so a
    // future change that starts guessing from the command string fails here.
    expect(classifyTool("Bash")).toBe("unclassified");
    expect(readsAsMutation(nameClassesFor("Bash"))).toBe(false);
  });

  test("the mutation step spends no alarm colour — red stays scarce, amber stays Interrupted", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        callBlock(0, "call-write", "mcp__minsky__session_pr_merge", { task: "mt#4238" }),
        resultBlock(1, "call-write", "merged"),
      ])
    );

    const row = toolRow(container, "call-write");
    // `destructive` is reserved for hard alarms and amber for attention debt
    // (docs/design-system.md §5.1). A healthy write is neither.
    expect(row.outerHTML).not.toContain("destructive");
    expect(row.outerHTML).not.toContain("amber");
    // And no raw palette hue of any kind — ToolInvocation is not a status file.
    expect(row.outerHTML).not.toContain("sky-");
    expect(row.outerHTML).not.toContain("emerald-");
  });

  test("mt#4220's floor survives: a write is still a dim LINE, with no border and no tint", () => {
    // The regression this task must not cause. Weight is spent on text, never
    // on re-introducing the enclosure mt#4220 removed.
    const { container } = renderCV(
      snapshotWithBlocks([
        callBlock(0, "call-write", "mcp__minsky__memory_create", { name: "x" }),
        resultBlock(1, "call-write", "created"),
      ])
    );

    const classes = toolRow(container, "call-write").className;
    expect(classes).not.toMatch(/\bborder\b/);
    expect(classes).not.toMatch(/\bborder-/);
    expect(classes).not.toMatch(/\bbg-/);
  });

  test("a FAILED write is loud as a failure, not as a write — tier 1 outranks tier 3", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        callBlock(0, "call-err", "mcp__minsky__tasks_spec_patch", { taskId: "mt#9999" }),
        resultBlock(1, "call-err", "task not found", true),
      ])
    );

    const row = toolRow(container, "call-err");
    expect(row.className).toContain("border-destructive/50");
    expect(nameSpan(row).className).toContain("text-destructive");
    // The effect step must not repaint a failure back down to muted.
    expect(nameSpan(row).className).not.toContain("text-muted-foreground");
  });
});
