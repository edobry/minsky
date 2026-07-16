/**
 * ConversationView injected-content rendering tests (mt#2791).
 *
 * Verifies the render-path integration of the injected-content detector
 * (../lib/injected-content.ts) inside ConversationView: harness-injected
 * command wrappers, skill-body preambles, and system-reminder blocks render
 * as collapsed, muted, origin-labeled blocks instead of raw XML/Markdown —
 * covering the spec's four acceptance fixtures plus the mixed-turn split and
 * the expand-all/collapse-all broadcast.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
  return new Date(Date.UTC(2026, 6, 14, 12, 0, index)).toISOString();
}

function userTextBlock(index: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: { role: "user", content: [{ type: "text", text }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
  };
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

function snapshotWithBlocks(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "agent-injected-content-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-07-14T12:00:00.000Z",
  };
}

describe("ConversationView — injected-content collapsing (mt#2791)", () => {
  afterEach(cleanup);

  test("fixture: slash-command opening turn renders one muted 'command: error-handling' collapsed block, not raw XML", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        userTextBlock(
          0,
          "<command-message>error-handling</command-message>\n<command-name>error-handling</command-name>"
        ),
      ])
    );

    expect(screen.getByText("command: error-handling")).toBeDefined();
    // Raw XML never leaks into the DOM text content.
    expect(container.textContent).not.toContain("<command-message>");
    expect(container.textContent).not.toContain("</command-message>");
    // Collapsed by default.
    const toggle = container.querySelector('button[aria-expanded]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  });

  test("fixture: skill-body injection renders a collapsed 'skill body: plan-task' block; expanding shows the full Markdown", () => {
    const body = "Drive a task through PLANNING: investigate the spec, surface gaps, run the gate check.";
    const { container } = renderCV(
      snapshotWithBlocks([
        userTextBlock(
          0,
          "<command-message>plan-task</command-message>\n" +
            "<command-name>plan-task</command-name>\n" +
            "<skill-format>true</skill-format>Base directory for this skill: /Users/edobry/Projects/minsky/.claude/skills/plan-task\n\n" +
            `# plan-task\n\n${body}`
        ),
      ])
    );

    expect(screen.getByText("skill body: plan-task")).toBeDefined();
    // Collapsed: the body markdown is not yet in the DOM.
    expect(screen.queryByText(new RegExp(body))).toBeNull();
    expect(container.textContent).not.toContain("<command-message>");

    fireEvent.click(screen.getByText("skill body: plan-task"));
    expect(screen.getByText(new RegExp(body))).toBeDefined();
  });

  test("fixture: <system-reminder> block renders a collapsed muted block", () => {
    renderCV(
      snapshotWithBlocks([
        userTextBlock(0, "<system-reminder>Background context injected by the harness.</system-reminder>"),
      ])
    );

    expect(screen.getByText("system reminder")).toBeDefined();
    expect(screen.queryByText(/Background context injected/)).toBeNull();
  });

  test("fixture: plain user prose renders unchanged (no injected block, no collapsing)", () => {
    const { container } = renderCV(
      snapshotWithBlocks([userTextBlock(0, "Why does the reviewer bot keep timing out on large diffs?")])
    );

    expect(screen.getByText(/Why does the reviewer bot keep timing out/)).toBeDefined();
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
  });

  test("a mixed turn (command wrapper + genuine prose) collapses only the injected span", () => {
    renderCV(
      snapshotWithBlocks([
        userTextBlock(
          0,
          "<command-message>error-handling</command-message>\n<command-name>error-handling</command-name>\nplease also check the retry logic"
        ),
      ])
    );

    expect(screen.getByText("command: error-handling")).toBeDefined();
    // The genuine prose renders visibly, uncollapsed, alongside the injected block.
    expect(screen.getByText(/please also check the retry logic/)).toBeDefined();
  });

  test("assistant-role text is never treated as injected content, even if it contains the literal markers", () => {
    renderCV(
      snapshotWithBlocks([
        assistantTextBlock(
          0,
          "I saw a `<system-reminder>` tag in the transcript while investigating mt#2791."
        ),
      ])
    );

    // Rendered as plain prose (inline code span from the markdown backticks),
    // never collapsed behind a "system reminder" header.
    expect(screen.queryByText("system reminder")).toBeNull();
    expect(screen.getByText(/I saw a/)).toBeDefined();
  });

  test("expand all / collapse all broadcasts to injected-content blocks alongside tool-invocation blocks", () => {
    renderCV(
      snapshotWithBlocks([
        userTextBlock(0, "<system-reminder>internal context</system-reminder>"),
      ])
    );

    const toggle = () => screen.getByRole("button", { name: /system reminder/ });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByText("Expand all"));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("internal context")).toBeDefined();

    fireEvent.click(screen.getByText("Collapse all"));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});
