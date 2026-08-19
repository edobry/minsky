/**
 * Hover-affordance tests for the conversation view's disclosure controls (mt#4251).
 *
 * mt#4220 removed the card border from these rows. It was carrying two jobs —
 * excess weight (correctly removed) and delimiting the row as a clickable
 * object (removed with it) — and the principal reported the result: the rows
 * expand but do not look like they can be clicked. The fix is a hover
 * background, so nothing changes at rest.
 *
 * Three distinct claims are asserted here, and the third is the one that a
 * per-control test would miss:
 *
 * 1. Every control in the class carries the affordance.
 * 2. On the tool row it covers the WHOLE row, and specifically is NOT on the
 *    anchored wrapper `ConversationView.weight-hierarchy.test.tsx` asserts is
 *    free of `bg-` classes at rest — that test must keep passing unmodified.
 * 3. Every control uses the SAME value. mt#4250's action-burst toggle shipped
 *    `bg-muted/40` a day before the four controls beside it got
 *    `docs/design-system.md`'s documented `bg-muted/50`, and two near-identical
 *    hover tints in one view is exactly the drift `HOVER_ROW` exists to stop.
 *
 * Class-shaped rather than geometric for the same reason the weight-hierarchy
 * suite is: happy-dom has no layout engine (`src/cockpit/CLAUDE.md` §"Asserting
 * layout geometry"). The cursor half of the affordance is asserted
 * structurally — see the `<button>` test below for why a computed-style check
 * would be meaningless here.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  CommandInvocation,
  HOVER_ROW,
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

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

/**
 * Every distinct `hover:bg-*` class currently in the DOM.
 *
 * The set, not the list: claim 3 above is that the whole class agrees on ONE
 * value, so a second entry here is the failure regardless of which control
 * introduced it.
 */
function hoverBackgroundClasses(container: HTMLElement): string[] {
  const found = new Set<string>();
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
    for (const cls of Array.from(el.classList)) {
      if (cls.startsWith("hover:bg-")) found.add(cls);
    }
  }
  return Array.from(found).sort();
}

/** The single element carrying the hover affordance, or null when none does. */
function hoverTarget(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[class*="${HOVER_ROW}"]`);
}

describe("disclosure-control hover affordance (mt#4251)", () => {
  afterEach(cleanup);

  test("the tool row's affordance spans the full row, not just the toggle button", () => {
    const { container } = wrap(
      <ToolInvocation
        call={{ kind: "tool-call", id: "call-1", name: "Read", input: { file_path: "/tmp/a.ts" } }}
        entityIndex={EMPTY_INDEX}
        expandSignal={undefined}
      />
    );

    const target = hoverTarget(container);
    expect(target).not.toBeNull();
    // `w-full` is what distinguishes the row container from the `flex-1`
    // toggle: the toggle stops short of the spawn badge and the film link, so
    // hovering it would highlight part of a row that is meant to read as one
    // object.
    expect(target!.className).toContain("w-full");
    expect(target!.tagName).toBe("DIV");
  });

  test("the affordance is NOT on the anchored wrapper the at-rest test inspects", () => {
    const { container } = wrap(
      <ToolInvocation
        call={{ kind: "tool-call", id: "call-1", name: "Read", input: {} }}
        entityIndex={EMPTY_INDEX}
        expandSignal={undefined}
      />
    );

    // `ConversationView.weight-hierarchy.test.tsx` asserts this element matches
    // no `/\bbg-/` — and `hover:bg-muted/50` does match that regex. Putting the
    // affordance here would silently break mt#4220's at-rest guarantee, which
    // this task must preserve rather than trade away.
    const wrapper = container.querySelector<HTMLElement>("[data-tool-use-id]");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).not.toContain("hover:bg-");
  });

  test("the injected-span toggle carries it", () => {
    const { container } = wrap(
      <InjectedContentBlock
        span={{ kind: "system-reminder", label: "system reminder", content: "some content" }}
        entityIndex={EMPTY_INDEX}
        expandSignal={undefined}
      />
    );

    expect(hoverTarget(container)).not.toBeNull();
    expect(hoverTarget(container)!.tagName).toBe("BUTTON");
  });

  test("the thinking summary carries it", () => {
    const { container } = wrap(<ThinkingBlock thinking="some reasoning" entityIndex={EMPTY_INDEX} />);

    const target = hoverTarget(container);
    expect(target).not.toBeNull();
    expect(target!.tagName).toBe("SUMMARY");
  });

  test("the command control carries it on the chevron, which is the only hit-area it has", () => {
    const { container } = wrap(
      <CommandInvocation
        element={{
          kind: "command-invocation",
          command: { kind: "command", label: "command: /plan", content: "/plan mt#1" },
        }}
        entityIndex={EMPTY_INDEX}
        expandSignal={undefined}
      />
    );

    const target = hoverTarget(container);
    expect(target).not.toBeNull();
    // Deliberately NOT the row: the command line beside this chevron is
    // content, and nothing about mt#4251 widens what is clickable.
    expect(target!.tagName).toBe("BUTTON");
    expect(target!.className).not.toContain("w-full");
  });

  test("every control is a <button> or <summary>, which is what makes the pointer a pointer", () => {
    // Tailwind v3's preflight grants `cursor: pointer` to `button` and
    // `[role="button"]` (node_modules/tailwindcss/src/css/preflight.css:343),
    // so no `cursor-pointer` class is needed and asserting computed style
    // would prove nothing here — happy-dom applies no stylesheet. What CAN be
    // pinned is the element type the preflight rule selects on. Re-check this
    // test if cockpit ever moves to Tailwind v4, whose preflight drops the
    // rule and makes an explicit class load-bearing.
    const { container } = wrap(
      <InjectedContentBlock
        span={{ kind: "system-reminder", label: "r", content: "c" }}
        entityIndex={EMPTY_INDEX}
        expandSignal={undefined}
      />
    );

    const target = hoverTarget(container)!;
    expect(["BUTTON", "SUMMARY"]).toContain(target.tagName);
    // The focus ring answers a different question for a different input mode
    // and must survive alongside the hover state, not be replaced by it.
    expect(target.className).toContain("focus-visible:ring-2");
  });

  test("the whole class agrees on ONE hover value, including mt#4250's fold toggle", () => {
    // The fifth control lives in `ConversationTurnView` and only appears once a
    // run of machinery turns is long enough to fold, so this case renders the
    // real view rather than a component. Keeping it in THIS file is the point:
    // the claim is that all five agree, and splitting the assertion across two
    // files is what would let them drift apart again.
    const { container } = render(
      <MemoryRouter>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ConversationView snapshot={burstSnapshot()} />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(screen.getAllByTestId("action-burst-toggle")).toHaveLength(1);
    expect(hoverBackgroundClasses(container)).toEqual([HOVER_ROW]);
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

function assistantToolCallBlock(
  index: number,
  toolUseId: string,
  name: string
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input: {} }] },
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
  for (const id of ["h1", "h2", "h3", "h4"]) {
    blocks.push(assistantToolCallBlock(index, id, "Read"));
    index += 1;
    blocks.push(userToolResultBlock(index, id));
    index += 1;
  }
  blocks.push(assistantTextBlock(index, "Sweep finished."));
  return {
    agentSessionId: "agent-hover-affordance-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-08-19T12:00:00.000Z",
  };
}
