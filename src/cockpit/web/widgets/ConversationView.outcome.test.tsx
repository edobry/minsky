/**
 * Per-turn Outcome chip tests (mt#3261 shipped the slot; mt#3260 adds
 * `Interrupted`).
 *
 * The load-bearing property is what the chip does NOT say. mt#3130's Outcome
 * register has six values, but only two are evidenced by the transcript as
 * parsed today — so an unremarkable turn must render NO chip rather than a
 * confident `Completed`, and a cancelled tool call must read `Interrupted`
 * rather than `Errored` (the harness marks it `isError`, but the operator
 * cancelling is not a failure — the same distinction mt#3131 already applied to
 * the error TALLY, now applied to the RENDER).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

/** The exact prefix `conversation-elements.ts` keys `isInterruptionRejection` off. */
const INTERRUPTION_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected.";

function renderBlocks(blocks: SessionContextSnapshotBlock[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationView drivenSessionId="outcome-test" drivenBlocks={blocks} />
    </QueryClientProvider>
  );
}

function block(
  i: number,
  role: "assistant" | "user",
  content: unknown[],
  rawJsonlType: string,
  extra: Record<string, unknown> = {}
): SessionContextSnapshotBlock {
  return {
    id: `outcome:turn:${i}`,
    type: role === "assistant" ? "assistant-text" : "user-text",
    source: "observed",
    content: { role, content },
    timestamp: new Date(Date.UTC(2026, 6, 13, 12, 0, i)).toISOString(),
    rawJsonlType,
    ...extra,
  } as SessionContextSnapshotBlock;
}

const TOOL_USE_ID = "toolu_interrupted_1";

describe("ConversationView — per-turn Outcome chip", () => {
  afterEach(cleanup);

  test("an ordinary assistant turn carries NO outcome chip (never a false Completed)", () => {
    renderBlocks([block(0, "assistant", [{ type: "text", text: "all done" }], "assistant")]);

    expect(screen.getByText("all done")).toBeDefined();
    expect(screen.queryByTestId("turn-outcome")).toBeNull();
  });

  test("an API-error assistant turn reads Errored", () => {
    renderBlocks([
      block(0, "assistant", [{ type: "text", text: "API Error: upstream exploded" }], "assistant"),
    ]);

    expect(screen.getByTestId("turn-outcome").textContent).toBe("Errored");
  });

  test("a cancelled tool call reads Interrupted, not Errored (mt#3260)", () => {
    renderBlocks([
      block(
        0,
        "assistant",
        [{ type: "tool_use", id: TOOL_USE_ID, name: "Bash", input: { command: "sleep 999" } }],
        "assistant"
      ),
      block(
        1,
        "user",
        [
          {
            type: "tool_result",
            tool_use_id: TOOL_USE_ID,
            is_error: true,
            content: INTERRUPTION_CONTENT,
          },
        ],
        "user"
      ),
    ]);

    const chip = screen.getByTestId("turn-outcome");
    expect(chip.textContent).toBe("Interrupted");
    // Amber, never red — docs/design-system.md's red-scarcity rule, and
    // mt#3130's explicit "amber, NOT red — distinct from error".
    expect(chip.className).toContain("warn-amber");
    expect(chip.className).not.toContain("destructive");
  });

  test("Interrupted wins over Errored when a turn shows both", () => {
    renderBlocks([
      block(
        0,
        "assistant",
        [
          { type: "text", text: "API Error: something" },
          { type: "tool_use", id: TOOL_USE_ID, name: "Bash", input: {} },
        ],
        "assistant"
      ),
      block(
        1,
        "user",
        [
          {
            type: "tool_result",
            tool_use_id: TOOL_USE_ID,
            is_error: true,
            content: INTERRUPTION_CONTENT,
          },
        ],
        "user"
      ),
    ]);

    expect(screen.getByTestId("turn-outcome").textContent).toBe("Interrupted");
  });

  test("a genuine tool failure is NOT relabelled Interrupted", () => {
    renderBlocks([
      block(
        0,
        "assistant",
        [{ type: "tool_use", id: TOOL_USE_ID, name: "Bash", input: {} }],
        "assistant"
      ),
      block(
        1,
        "user",
        [
          {
            type: "tool_result",
            tool_use_id: TOOL_USE_ID,
            is_error: true,
            content: "bash: command not found",
          },
        ],
        "user"
      ),
    ]);

    // No interruption prefix and no API-error text — nothing evidenced, so no chip.
    expect(screen.queryByTestId("turn-outcome")).toBeNull();
  });
});

describe("ConversationView — compaction and retry markers (mt#3260)", () => {
  afterEach(cleanup);

  test("a compact-summary turn renders a labeled boundary, not unmarked user prose", () => {
    renderBlocks([
      block(0, "user", [{ type: "text", text: "SUMMARY OF THE PRIOR CONTEXT" }], "user", {
        isCompactSummary: true,
      }),
    ]);

    expect(screen.getByTestId("compaction-boundary")).toBeDefined();
    expect(screen.getByText(/Context compacted here/)).toBeDefined();
  });

  test("the compaction summary stays reachable — nothing is hidden", () => {
    renderBlocks([
      block(0, "user", [{ type: "text", text: "SUMMARY OF THE PRIOR CONTEXT" }], "user", {
        isCompactSummary: true,
      }),
    ]);

    // Rendered inside the disclosure rather than dropped.
    expect(screen.getByText("SUMMARY OF THE PRIOR CONTEXT")).toBeDefined();
  });

  test("an ordinary user turn is NOT treated as a compaction boundary", () => {
    renderBlocks([block(0, "user", [{ type: "text", text: "just a prompt" }], "user")]);

    expect(screen.queryByTestId("compaction-boundary")).toBeNull();
    expect(screen.getByText("just a prompt")).toBeDefined();
  });

  test("a synthetic-model assistant turn is marked Retrying…", () => {
    renderBlocks([
      block(0, "assistant", [{ type: "text", text: "retried output" }], "assistant", {
        model: "<synthetic>",
      }),
    ]);

    expect(screen.getByTestId("turn-retrying").textContent).toContain("Retrying");
  });

  test("a real-model assistant turn carries no retry marker", () => {
    renderBlocks([
      block(0, "assistant", [{ type: "text", text: "normal output" }], "assistant", {
        model: "claude-opus-5",
      }),
    ]);

    expect(screen.queryByTestId("turn-retrying")).toBeNull();
  });
});
