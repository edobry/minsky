/**
 * ConversationView visual-weight hierarchy tests (mt#4220).
 *
 * The rule under test is stated once in `ConversationElementRenderers.tsx`'s
 * "Weight hierarchy" docblock: failures loudest, then prose, then everything
 * else recedes with NO border, NO tint and NO accent hue.
 *
 * **Tier 3 is no longer one uniform step (mt#4238).** A tool call the registry
 * classifies as `mutates` now sits above a read WITHIN that tier. What this
 * suite pins is tier 3's FLOOR — no border, no tint, no accent hue — which
 * holds at both steps and which mt#4238 layers on top of rather than replaces.
 * The read-vs-write split itself is pinned separately, by
 * `ConversationView.tool-effect-weight.test.tsx`; the fixtures below are `Read`
 * and `Bash`, both of which sit at the recessive step. Before mt#4220 the
 * ordering was inverted — every machine element was a bordered, tinted card
 * (a healthy tool row additionally sky-hued) while assistant prose rendered
 * with no wrapper and no class — so a run of collapsed calls visually
 * overpowered the speech between them.
 *
 * These assertions are deliberately class-shaped rather than geometric: the
 * component suite runs under happy-dom, which has no layout engine, so
 * `getBoundingClientRect()` and friends read 0 here (`src/cockpit/CLAUDE.md`
 * §"Asserting layout geometry"). The rendered-height half of this task's
 * evidence is measured over CDP by `scripts/verify-conversation-weight.ts`
 * instead; what these tests pin is the CSS shape that produced it.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
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
  return new Date(Date.UTC(2026, 7, 17, 12, 0, index)).toISOString();
}

function assistantTextBlock(index: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function assistantToolCallBlock(
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

function userToolResultBlock(
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
    agentSessionId: "agent-weight-hierarchy-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-08-17T12:00:00.000Z",
  };
}

/** The merged tool-invocation block's outer element, addressed by its anchor attr. */
function toolRow(container: HTMLElement, toolUseId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-tool-use-id="${toolUseId}"]`);
  if (!el) throw new Error(`no tool row rendered for ${toolUseId}`);
  return el;
}

const PROSE_TEXT = "Reading the auth module now; nothing blocking so far.";

describe("ConversationView — visual weight hierarchy (mt#4220)", () => {
  afterEach(cleanup);

  test("a healthy tool call is a dim line: no border, no background tint", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        assistantToolCallBlock(0, "call-ok", "Read", { file_path: "/tmp/x.ts" }),
        userToolResultBlock(1, "call-ok", "ok"),
      ])
    );

    const row = toolRow(container, "call-ok");
    const classes = row.className;
    // The whole point: a healthy call carries no enclosure at all.
    expect(classes).not.toMatch(/\bborder\b/);
    expect(classes).not.toMatch(/\bborder-/);
    expect(classes).not.toMatch(/\bbg-/);
  });

  test("a healthy tool call spends no accent hue — name and icon recede to muted", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        assistantToolCallBlock(0, "call-ok", "Read", { file_path: "/tmp/x.ts" }),
        userToolResultBlock(1, "call-ok", "ok"),
      ])
    );

    const row = toolRow(container, "call-ok");
    // The tool NAME is the element that carried `text-sky-300`.
    const nameSpan = row.querySelector<HTMLElement>("span[title]");
    expect(nameSpan).not.toBeNull();
    expect(nameSpan!.className).toContain("text-muted-foreground");
    expect(nameSpan!.className).not.toContain("text-sky");
  });

  test("no sky accent survives on any CONTENT element (class, not instance)", () => {
    // Scans every rendered element rather than the one the previous tests
    // address — the inversion was spread across four renderers, so a
    // per-element assertion would pass while a sibling still glowed.
    const { container } = renderCV(
      snapshotWithBlocks([
        assistantTextBlock(0, PROSE_TEXT),
        assistantToolCallBlock(1, "call-a", "Read", { file_path: "/tmp/a.ts" }),
        userToolResultBlock(2, "call-a", "ok"),
        assistantToolCallBlock(3, "call-b", "Bash", { command: "bun test" }),
        userToolResultBlock(4, "call-b", "1 pass"),
        assistantTextBlock(5, "Tests pass."),
      ])
    );

    // Deliberately NOT a scan of `container.innerHTML`: that would also sweep
    // up the turn's speaker rail, which legitimately keeps its hue (next test).
    const contentEls = container.querySelectorAll<HTMLElement>(
      "[data-tool-use-id], div.break-words"
    );
    expect(contentEls.length).toBeGreaterThanOrEqual(4);
    for (const el of contentEls) {
      expect(el.outerHTML).not.toContain("sky-");
    }
  });

  test("the assistant speaker rail KEEPS its hue — a margin marker, not machinery", () => {
    // The 2px left rail (`ConversationTurnView.tsx` ROLE_STYLES) encodes WHO IS
    // SPEAKING — emerald for the operator, sky for the assistant — in the
    // margin, where it costs the reading area nothing. It is the surface's one
    // legitimate categorical hue besides the violet spawn badge, and mt#4220
    // makes it MORE readable rather than less: with the tool rows no longer
    // sky, sky now means "assistant" and nothing else. A future de-carding pass
    // should not sweep it up as leftover accent.
    //
    // The rail moved one level UP in mt#3845, from the per-turn wrapper to the
    // per-RUN wrapper: consecutive same-actor turns now share one header and one
    // continuous rail, so the hue belongs to the run rather than to each block.
    // mt#4220's invariant is unchanged and this test still asserts it — the
    // assistant rail is still `border-l-sky-500/40` and still the only sky on
    // the surface. Only the element carrying it changed, which is why the
    // selector is the run wrapper (the `[data-turn-index]` element's PARENT)
    // rather than the block. Asserted structurally so a future pass that
    // strips the hue still fails here.
    const { container } = renderCV(snapshotWithBlocks([assistantTextBlock(0, PROSE_TEXT)]));
    const turn = container.querySelector<HTMLElement>("[data-turn-index]");
    expect(turn).not.toBeNull();
    const run = turn!.closest<HTMLElement>(".border-l-2");
    expect(run).not.toBeNull();
    expect(run!.className).toContain("border-l-sky-500/40");
  });

  test("a failure keeps its card and stays expanded — the loudest tier is unchanged", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        assistantToolCallBlock(0, "call-err", "mcp__minsky__tasks_get", { taskId: "mt#9999" }),
        userToolResultBlock(1, "call-err", "task not found", true),
      ])
    );

    const row = toolRow(container, "call-err");
    expect(row.className).toContain("border-destructive/50");
    expect(row.className).toContain("bg-destructive/5");
    // Errors must never read as an ok-looking collapsed line (mt#2790).
    expect(row.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("task not found")).toBeDefined();
  });

  test("assistant prose renders at full foreground strength, not the dimmed default", () => {
    const { container } = renderCV(snapshotWithBlocks([assistantTextBlock(0, PROSE_TEXT)]));

    const paragraph = screen.getByText(PROSE_TEXT);
    // <Prose>'s root is the element carrying the size + colour tokens; the
    // paragraph itself is a child of it.
    const proseRoot = paragraph.closest<HTMLElement>("div.break-words");
    expect(proseRoot).not.toBeNull();
    // twMerge resolves the call-site `text-foreground` over Prose's own
    // `text-foreground/90` — assert the RESOLVED result, since a non-merging
    // `cn` would silently leave both classes present and the override inert.
    expect(proseRoot!.className).toContain("text-foreground");
    expect(proseRoot!.className).not.toContain("text-foreground/90");
    expect(container.innerHTML).not.toContain("text-foreground/90");
  });

  test("prose outweighs the machinery on size as well as colour", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        assistantTextBlock(0, PROSE_TEXT),
        assistantToolCallBlock(1, "call-ok", "Read", { file_path: "/tmp/x.ts" }),
        userToolResultBlock(2, "call-ok", "ok"),
      ])
    );

    const proseRoot = screen.getByText(PROSE_TEXT).closest<HTMLElement>("div.break-words");
    expect(proseRoot!.className).toContain("text-sm");

    // The machinery sits one step down the design-system scale (`small`).
    const toggle = toolRow(container, "call-ok").querySelector<HTMLElement>(
      "button[aria-expanded]"
    );
    expect(toggle!.className).toContain("text-xs");
  });

  test("every disclosure control keeps a visible focus state after de-carding", () => {
    // PR #3078 R1 (non-blocking). De-carding removed the only thing outlining a
    // tool row, and these toggles never had a focus ring — so a keyboard user
    // tabbing onto a borderless row had nothing to see. `src/cockpit/CLAUDE.md`
    // §"Accessibility-first primitives" requires a visible focus state on every
    // interactive element; this asserts the whole class, not one control.
    const { container } = renderCV(
      snapshotWithBlocks([
        assistantTextBlock(0, PROSE_TEXT),
        assistantToolCallBlock(1, "call-a", "Read", { file_path: "/tmp/a.ts" }),
        userToolResultBlock(2, "call-a", "ok"),
      ])
    );

    const controls = container.querySelectorAll<HTMLElement>("button[aria-expanded], summary");
    expect(controls.length).toBeGreaterThanOrEqual(1);
    for (const c of controls) {
      expect(c.className).toContain("focus-visible:ring-2");
      expect(c.className).toContain("focus-visible:ring-ring");
    }
  });

  test("the violet spawn badge survives — it is the one categorical hue kept", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        assistantToolCallBlock(0, "call-spawn", "Agent", { subagent_type: "Explore" }),
        userToolResultBlock(1, "call-spawn", "done"),
      ])
    );
    expect(screen.getAllByText(/subagent \(Explore\)/).length).toBeGreaterThanOrEqual(1);
    expect(container.innerHTML).toContain("violet-");
  });
});
