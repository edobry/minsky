/**
 * Tests for JsonView (mt#2552) — recursive tree (Tier 1) + entity-enriched
 * leaves (Tier 2). Rendered with @testing-library/react under happy-dom.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { JsonView } from "./JsonView";
import { buildEntityIndex } from "../lib/entity-linkifier";

afterEach(cleanup);

const TASK_ID = "mt#2370";
const TASK_PATH = "/tasks/mt%232370";

function makeIndex() {
  return buildEntityIndex({ taskIds: [TASK_ID], sessionIds: [], askIds: [], memoryIds: [] });
}
function renderTree(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("JsonView — Tier 1 (structure)", () => {
  test("renders object keys and primitive values", () => {
    const { container } = renderTree(<JsonView data={{ name: "alpha", count: 3, ok: true }} />);
    expect(container.textContent).toContain("name");
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("true");
  });

  test("renders nested arrays", () => {
    const { container } = renderTree(<JsonView data={{ items: ["a", "b"] }} />);
    expect(container.textContent).toContain("items");
    expect(container.textContent).toContain("a");
    expect(container.textContent).toContain("b");
  });

  test("empty object renders braces", () => {
    const { container } = renderTree(<JsonView data={{}} />);
    expect(container.textContent).toContain("{}");
  });

  test("collapse toggle hides nested children", () => {
    const { container, getAllByRole } = renderTree(<JsonView data={{ a: { b: "deep" } }} />);
    expect(container.textContent).toContain("deep");
    fireEvent.click(getAllByRole("button")[0]); // collapse the root node
    expect(container.textContent).not.toContain("deep");
  });
});

describe("JsonView — collapsed-node key previews (mt#2793)", () => {
  test("collapsed object shows up to 4 key names + ellipsis", () => {
    const { container, getAllByRole } = renderTree(
      <JsonView data={{ a: 1, b: 2, c: 3, d: 4, e: 5 }} />
    );
    fireEvent.click(getAllByRole("button")[0]); // collapse the root node
    expect(container.textContent).toContain("a, b, c, d, …");
    // The 5th key is elided, not just truncated silently.
    expect(container.textContent).not.toContain("a, b, c, d, e");
  });

  test("collapsed object with <=4 keys shows all keys, no ellipsis", () => {
    const { container, getAllByRole } = renderTree(<JsonView data={{ a: 1, b: 2 }} />);
    fireEvent.click(getAllByRole("button")[0]);
    expect(container.textContent).toContain("a, b");
    expect(container.textContent).not.toContain("…");
  });

  test("collapsed array shows length and element kind (primitives)", () => {
    const { container, getAllByRole } = renderTree(<JsonView data={[1, 2, 3]} />);
    fireEvent.click(getAllByRole("button")[0]);
    expect(container.textContent).toContain("3 × number");
  });

  test("collapsed array of objects shows the {…} element kind", () => {
    const { container, getAllByRole } = renderTree(
      <JsonView data={[{ x: 1 }, { y: 2 }, { z: 3 }]} />
    );
    fireEvent.click(getAllByRole("button")[0]);
    expect(container.textContent).toContain("3 × {…}");
  });

  test("collapsed array with heterogeneous elements shows 'mixed'", () => {
    const { container, getAllByRole } = renderTree(<JsonView data={[1, "two", { x: 3 }]} />);
    fireEvent.click(getAllByRole("button")[0]);
    expect(container.textContent).toContain("3 × mixed");
  });

  test("expanded nodes are unaffected — full keys and values still render", () => {
    // Root is at depth 0 (< 2), so it starts open by default: no collapse
    // needed to observe unchanged expanded behavior.
    const { container } = renderTree(<JsonView data={{ a: 1, b: 2, c: 3, d: 4, e: 5 }} />);
    expect(container.textContent).toContain("a");
    expect(container.textContent).toContain("e");
    expect(container.textContent).toContain("5");
  });
});

describe("JsonView — Tier 2 (entity-enriched leaves)", () => {
  test("a known entity ref in a string value becomes an in-SPA link", () => {
    const { container } = renderTree(
      <JsonView data={{ task: TASK_ID }} entityIndex={makeIndex()} />
    );
    const a = container.querySelector(`a[href="${TASK_PATH}"]`);
    expect(a).not.toBeNull();
    expect(a?.textContent).toBe(TASK_ID);
  });

  test("a URL string value becomes an external link", () => {
    const { container } = renderTree(<JsonView data={{ url: "https://example.com/x" }} />);
    const a = container.querySelector('a[href="https://example.com/x"]');
    expect(a).not.toBeNull();
    expect(a?.getAttribute("target")).toBe("_blank");
  });

  test("without an entityIndex, refs are plain text (no link)", () => {
    const { container } = renderTree(<JsonView data={{ task: TASK_ID }} />);
    expect(container.querySelector(`a[href="${TASK_PATH}"]`)).toBeNull();
    expect(container.textContent).toContain(TASK_ID);
  });
});

describe("JsonView — multiline string leaves (mt#2788)", () => {
  test("a multiline string renders as a preformatted block with newlines preserved", () => {
    const { container } = renderTree(<JsonView data={{ output: "a\nb\nc" }} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe("a\nb\nc");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(pre?.className).toContain("max-h-48"); // bounded so one output can't dominate
  });

  test("CRLF and bare-CR strings also take the block presentation", () => {
    const crlf = renderTree(<JsonView data={{ output: "a\r\nb" }} />);
    expect(crlf.container.querySelector("pre")).not.toBeNull();
    cleanup();
    const cr = renderTree(<JsonView data={{ output: "a\rb" }} />);
    expect(cr.container.querySelector("pre")).not.toBeNull();
  });

  test("a single-line string stays an inline quoted leaf (no pre)", () => {
    const { container } = renderTree(<JsonView data={{ s: "one line" }} />);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain('"one line"');
  });

  test("entity refs inside a multiline leaf are still linkified", () => {
    const { container } = renderTree(
      <JsonView data={{ output: `line1\nsee ${TASK_ID}\nline3` }} entityIndex={makeIndex()} />
    );
    const a = container.querySelector(`a[href="${TASK_PATH}"]`);
    expect(a).not.toBeNull();
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("line1\nsee ");
    expect(pre?.textContent).toContain("\nline3");
  });
});
