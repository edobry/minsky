/**
 * Disclosure-control consistency tests (mt#4348).
 *
 * The conversation view used to draw disclosure markers three ways at two
 * positions: `BurstFold` rendered a leading glyph, `ThinkingBlock` rendered NONE
 * and inherited the browser's native `<summary>` marker, and the tool row,
 * injected span and command control each pinned a glyph right with `ml-auto`.
 * The principal, on the mt#4251 render: *"the information hierarchy for the
 * collapsible section's outer and inner elements is non obvious, and the
 * chevrons are on opposite sides."*
 *
 * What is pinned here is the property that makes the view a tree rather than a
 * pile of rows:
 *
 * 1. Every control's marker comes from `DisclosureChevron`, at the LEADING edge.
 * 2. No control re-pins a marker with `ml-auto` — the specific regression.
 * 3. `ThinkingBlock` suppresses the user agent's marker, so no control's
 *    appearance is left to the browser.
 * 4. An expanded `BurstFold` CONTAINS its children; a collapsed one renders no
 *    container at all.
 *
 * Geometry is deliberately absent: happy-dom has no layout engine, so the
 * two-column chevron alignment this produces is measured over CDP instead and
 * recorded in `docs/evidence/mt-4348/`. What these tests pin is the DOM shape
 * that produced it.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  BURST_CHILDREN,
  CommandInvocation,
  InjectedContentBlock,
  ThinkingBlock,
  ToolInvocation,
} from "./ConversationElementRenderers";
import { ConversationView } from "../widgets/ConversationView";
import { buildEntityIndex } from "../lib/entity-linkifier";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

const EMPTY_INDEX = buildEntityIndex({ taskIds: [], sessionIds: [], askIds: [], memoryIds: [] });
const CHEVRONS = ["▸", "▾"];

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

/** Every disclosure glyph rendered inside `root`. */
function chevrons(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("span[aria-hidden]")).filter((s) =>
    CHEVRONS.includes(s.textContent?.trim() ?? "")
  );
}

/**
 * True when the glyph leads its row — nothing renderable precedes it inside the
 * control that owns it.
 *
 * Walks up from the glyph to the row (the button/summary), checking at each
 * level that it is the first element child. That is what "leading" has to mean
 * structurally: a glyph nested three levels deep but first at every level still
 * paints at the left edge, and one that is first inside a trailing wrapper does
 * not.
 */
function leadsItsRow(glyph: HTMLElement, control: HTMLElement): boolean {
  let node: HTMLElement = glyph;
  while (node !== control) {
    const parent = node.parentElement;
    if (parent === null) return false;
    if (parent.firstElementChild !== node) return false;
    node = parent;
  }
  return true;
}

describe("disclosure controls are one system (mt#4348)", () => {
  afterEach(cleanup);

  const cases: Array<{ name: string; render: () => HTMLElement }> = [
    {
      name: "tool row",
      render: () =>
        wrap(
          <ToolInvocation
            call={{ kind: "tool-call", id: "call-1", name: "Read", input: {} }}
            entityIndex={EMPTY_INDEX}
            expandSignal={undefined}
          />
        ).container,
    },
    {
      name: "injected span",
      render: () =>
        wrap(
          <InjectedContentBlock
            span={{ kind: "system-reminder", label: "reminder", content: "body" }}
            entityIndex={EMPTY_INDEX}
            expandSignal={undefined}
          />
        ).container,
    },
    {
      name: "thinking summary",
      render: () => wrap(<ThinkingBlock thinking="reasoning" entityIndex={EMPTY_INDEX} />).container,
    },
    {
      name: "command",
      render: () =>
        wrap(
          <CommandInvocation
            element={{
              kind: "command-invocation",
              command: { kind: "command", label: "command: /plan", content: "/plan mt#1" },
            }}
            entityIndex={EMPTY_INDEX}
            expandSignal={undefined}
          />
        ).container,
    },
  ];

  for (const { name, render: renderCase } of cases) {
    test(`the ${name} draws exactly one chevron, and it leads the row`, () => {
      const container = renderCase();
      const glyphs = chevrons(container);
      expect(glyphs).toHaveLength(1);

      const control = glyphs[0]!.closest<HTMLElement>("button, summary");
      expect(control).not.toBeNull();
      expect(leadsItsRow(glyphs[0]!, control!)).toBe(true);
    });

    test(`the ${name} does not re-pin its chevron to the right edge`, () => {
      // The specific regression: `ml-auto` on the glyph or any wrapper between
      // it and its control pushes the marker to the trailing edge, which is
      // what made the set read as two positions.
      const container = renderCase();
      const glyph = chevrons(container)[0]!;
      const control = glyph.closest<HTMLElement>("button, summary")!;

      let node: HTMLElement = glyph;
      while (node !== control) {
        expect(node.className).not.toContain("ml-auto");
        node = node.parentElement!;
      }
    });
  }

  test("the thinking summary suppresses the user agent's own marker", () => {
    // This control rendered NO chevron before mt#4348 — the triangle was the
    // browser's `<summary>` default, in a glyph and size nothing in this repo
    // chose. `list-none` handles the standard `::marker`; the webkit
    // pseudo-element handles the engines that ignore it.
    const { container } = wrap(<ThinkingBlock thinking="reasoning" entityIndex={EMPTY_INDEX} />);
    const summary = container.querySelector<HTMLElement>("summary")!;

    expect(summary.className).toContain("list-none");
    expect(summary.className).toContain("[&::-webkit-details-marker]:hidden");
  });

  test("an expanded fold contains its children; a collapsed one renders no container", () => {
    const { container } = render(
      <MemoryRouter>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ConversationView snapshot={burstSnapshot()} />
        </QueryClientProvider>
      </MemoryRouter>
    );

    // Collapsed by default: no container, because there is nothing to contain.
    expect(container.querySelector('[data-testid="action-burst-children"]')).toBeNull();

    // `fireEvent`, not a raw DOM `.click()` — the latter dispatches the event
    // outside React's act() wrapper, so the state update has not flushed by the
    // time the next line queries the DOM and the container reads as absent.
    fireEvent.click(screen.getByTestId("action-burst-toggle"));

    const children = container.querySelector<HTMLElement>('[data-testid="action-burst-children"]');
    expect(children).not.toBeNull();
    // Every revealed turn is INSIDE it — the point of the container. Before
    // mt#4348 they were siblings of the toggle and indistinguishable from
    // top-level turns.
    const rows = container.querySelectorAll("[data-tool-use-id]");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of Array.from(rows)) expect(children!.contains(row)).toBe(true);
  });

  test("the fold's rail stays lighter than the run rail it nests inside", () => {
    // `RunView` uses `border-l-2` plus an actor accent. A fold is subordinate to
    // its run, so a rail of equal weight would flatten the very hierarchy the
    // container exists to show.
    expect(BURST_CHILDREN).toContain("border-l ");
    expect(BURST_CHILDREN).not.toContain("border-l-2");
    expect(BURST_CHILDREN).toContain("pl-3");
  });
});

function ts(index: number): string {
  return new Date(Date.UTC(2026, 7, 19, 12, 0, index)).toISOString();
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

function assistantToolCallBlock(index: number, toolUseId: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Read", input: {} }],
    },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function userToolResultBlock(index: number, toolUseId: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok", is_error: false }],
    },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
  };
}

/** prose → four tool calls → prose: long enough to fold (mt#4250's threshold is 3). */
function burstSnapshot(): SessionContextSnapshot {
  const blocks: SessionContextSnapshotBlock[] = [assistantTextBlock(0, "Starting the sweep.")];
  let index = 1;
  for (const id of ["d1", "d2", "d3", "d4"]) {
    blocks.push(assistantToolCallBlock(index, id));
    index += 1;
    blocks.push(userToolResultBlock(index, id));
    index += 1;
  }
  blocks.push(assistantTextBlock(index, "Sweep finished."));
  return {
    agentSessionId: "agent-disclosure-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-08-19T12:00:00.000Z",
  };
}
