/**
 * Tests for the shared <Prose> Markdown renderer (mt#2550).
 *
 * Verifies: Markdown structure renders (headings/lists/emphasis/code), entity
 * references linkify (composing the mt#2518 tokenizer via the rehype plugin),
 * code spans are NOT linkified, raw HTML is inert (XSS-safe), and plain prose
 * round-trips. Rendered with @testing-library/react under happy-dom (run via
 * `bun run test:components`).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Prose } from "./Prose";
import { buildEntityIndex } from "../lib/entity-linkifier";

afterEach(cleanup);

const TASK_ID = "mt#2370";
const TASK_PATH = "/tasks/mt%232370";

function makeIndex() {
  return buildEntityIndex({ taskIds: [TASK_ID], sessionIds: [], askIds: [], memoryIds: [] });
}

function renderProse(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("Prose — Markdown structure", () => {
  test("renders headings, lists, and emphasis (not raw syntax)", () => {
    const { container } = renderProse(<Prose>{"# Title\n\n- one\n- two\n\n**bold**"}</Prose>);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    // The literal markdown markers must not survive as text.
    expect(container.textContent).not.toContain("**bold**");
  });

  test("renders a fenced code block as <pre>", () => {
    const { container } = renderProse(<Prose>{"```\nconst x = 1;\n```"}</Prose>);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("const x = 1;");
  });

  test("renders a GFM table (remark-gfm enabled)", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |";
    const { container } = renderProse(<Prose>{md}</Prose>);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });
});

describe("Prose — entity linkification", () => {
  test("a known task ref becomes an in-SPA link", () => {
    const { container } = renderProse(
      <Prose entityIndex={makeIndex()}>{`see ${TASK_ID} for details`}</Prose>
    );
    const anchor = container.querySelector(`a[href="${TASK_PATH}"]`);
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toBe(TASK_ID);
  });

  test("a task ref inside inline code is NOT linkified", () => {
    const { container } = renderProse(
      <Prose entityIndex={makeIndex()}>{`use \`${TASK_ID}\` literally`}</Prose>
    );
    expect(container.querySelector(`a[href="${TASK_PATH}"]`)).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(TASK_ID);
  });

  test("without an entityIndex, refs render as plain text (no link)", () => {
    const { container } = renderProse(<Prose>{`see ${TASK_ID}`}</Prose>);
    expect(container.querySelector(`a[href="${TASK_PATH}"]`)).toBeNull();
    expect(container.textContent).toContain(TASK_ID);
  });
});

describe("Prose — minsky:// markdown deeplinks (mt#2797)", () => {
  test("a minsky:// task deeplink renders as an in-SPA link", () => {
    const { container } = renderProse(
      <Prose>{"Implemented [mt#2779](minsky://task/mt%232779) today."}</Prose>
    );
    const a = container.querySelector('a[href="/tasks/mt%232779"]');
    expect(a).not.toBeNull();
    expect(a?.textContent).toBe("mt#2779");
  });

  test("a minsky:// changeset deeplink renders as an in-SPA link", () => {
    const { container } = renderProse(<Prose>{"Merged [PR #1234](minsky://changeset/1234)."}</Prose>);
    expect(container.querySelector('a[href="/changeset/1234"]')).not.toBeNull();
  });

  test("an unparseable minsky:// URI degrades to a non-link styled span", () => {
    const { container } = renderProse(<Prose>{"See [thing](minsky://bogus/xyz)."}</Prose>);
    expect(container.querySelector("a")).toBeNull();
    const span = [...container.querySelectorAll("span")].find((s) => s.textContent === "thing");
    expect(span).not.toBeNull();
  });

  test("javascript: links are still stripped (sanitizer intact)", () => {
    const { container } = renderProse(<Prose>{"[x](javascript:alert(1))"}</Prose>);
    const a = container.querySelector("a");
    expect(a).toBeNull();
  });

  test("external https links still open in a new tab", () => {
    const { container } = renderProse(<Prose>{"[ext](https://example.com/x)"}</Prose>);
    const a = container.querySelector('a[href="https://example.com/x"]');
    expect(a).not.toBeNull();
    expect(a?.getAttribute("target")).toBe("_blank");
  });
});

describe("Prose — safety and edge cases", () => {
  test("raw HTML is inert (no script/img elements created)", () => {
    const { container } = renderProse(
      <Prose>{'before <script>alert(1)</script> <img src="x" onerror="alert(1)"> after'}</Prose>
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // Surrounding prose still renders.
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });

  test("plain prose round-trips as a paragraph", () => {
    const { container } = renderProse(<Prose>{"just some plain text"}</Prose>);
    expect(container.querySelector("p")?.textContent).toBe("just some plain text");
  });

  test("empty / whitespace-only content renders nothing", () => {
    const { container } = renderProse(<Prose>{"   "}</Prose>);
    expect(container.textContent).toBe("");
  });
});
