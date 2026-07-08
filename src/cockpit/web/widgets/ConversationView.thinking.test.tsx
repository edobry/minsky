/**
 * ThinkingBlock Markdown-rendering test (mt#2556).
 *
 * Thinking blocks now render the model's reasoning as Markdown via the shared
 * <Prose> (mt#2550), preserving the collapsed-by-default lazy render. This test
 * verifies the expanded body renders Markdown structure (not raw markers), and
 * that the body is NOT rendered while collapsed.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThinkingBlock } from "./ConversationView";
import { buildEntityIndex } from "../lib/entity-linkifier";

afterEach(cleanup);

const EMPTY_INDEX = buildEntityIndex({ taskIds: [], sessionIds: [], askIds: [], memoryIds: [] });
const MD = "# Reasoning\n\n- step one\n- step two\n\n**important** point";

function renderThinking(thinking: string) {
  return render(
    <MemoryRouter>
      <ThinkingBlock thinking={thinking} entityIndex={EMPTY_INDEX} />
    </MemoryRouter>
  );
}

describe("ThinkingBlock (mt#2556)", () => {
  test("body is NOT rendered while collapsed (lazy render preserved)", () => {
    const { container } = renderThinking(MD);
    // collapsed by default → no rendered markdown body, only the summary
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).not.toContain("Reasoning");
    expect(container.querySelector("summary")).not.toBeNull();
  });

  test("renders Markdown structure when expanded", () => {
    const { container } = renderThinking(MD);
    const details = container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));

    expect(container.querySelector("h1")?.textContent).toBe("Reasoning");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("important");
    // Raw markdown markers must not survive as text.
    expect(container.textContent).not.toContain("# Reasoning");
    expect(container.textContent).not.toContain("**important**");
  });

  test("plain-prose thinking renders cleanly", () => {
    const { container } = renderThinking("just plain reasoning, no markdown");
    const details = container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(container.querySelector("p")?.textContent).toBe("just plain reasoning, no markdown");
  });
});
