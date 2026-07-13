/**
 * Tests for ToolPayload (mt#2552) — the content-type dispatcher + Tier-3 registry.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToolPayload, TOOL_RESULT_RENDERERS } from "./ToolPayload";

afterEach(cleanup);

function renderPayload(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("ToolPayload — deterministic 2-way dispatch", () => {
  test("a JSON object renders as a tree, not <pre>", () => {
    const { container } = renderPayload(<ToolPayload value={{ a: 1 }} />);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain("a");
  });

  test("plain text renders as <pre>", () => {
    const { container } = renderPayload(<ToolPayload value={"raw log line"} />);
    expect(container.querySelector("pre")?.textContent).toBe("raw log line");
  });

  test("markdown/raw text stays <pre> (no prose branch)", () => {
    const { container } = renderPayload(<ToolPayload value={"# not rendered as a heading"} />);
    expect(container.querySelector("pre")?.textContent).toBe("# not rendered as a heading");
  });

  test("a JSON string is parsed and rendered as a tree", () => {
    const { container } = renderPayload(<ToolPayload value={'{"k":"v"}'} />);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain("k");
  });

  test("empty payload renders nothing", () => {
    const { container } = renderPayload(<ToolPayload value={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("ToolPayload — Tier-3 registry", () => {
  test("registry ships the tasks_list seed renderer", () => {
    expect(typeof TOOL_RESULT_RENDERERS.tasks_list).toBe("function");
  });

  test("tasks_list renderer renders a compact linked task list", () => {
    const data = [
      { id: "mt#2370", title: "A task", status: "DONE" },
      { id: "mt#2371", title: "Another", status: "TODO" },
    ];
    const { container } = renderPayload(<ToolPayload value={data} toolName="tasks_list" />);
    expect(container.querySelector('a[href="/tasks/mt%232370"]')).not.toBeNull();
    expect(container.querySelector('a[href="/tasks/mt%232371"]')).not.toBeNull();
    expect(container.textContent).toContain("A task");
  });

  test("tasks_list falls back to the generic tree on shape mismatch", () => {
    const { container } = renderPayload(
      <ToolPayload value={{ foo: "bar" }} toolName="tasks_list" />
    );
    // No task link; generic tree shows the object key instead.
    expect(container.querySelector('a[href^="/tasks/"]')).toBeNull();
    expect(container.textContent).toContain("foo");
  });

  test("an unregistered tool name uses the generic tree", () => {
    const { container } = renderPayload(
      <ToolPayload value={{ a: 1 }} toolName="some_unregistered_tool" />
    );
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain("a");
  });
});
