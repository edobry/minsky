/**
 * mt#3174 additions to the entity linkifier — kept in a SEPARATE file from
 * entity-linkifier.test.ts, which must pass UNMODIFIED (mt#3174's contract-
 * discipline requirement: the zero-false-positive gating property is
 * load-bearing and that file is the proof it survived this change).
 *
 * Covers two mt#3174 acceptance tests:
 *   - "Prose anchors carry entity identity" — makeAnchor emits the resolved
 *     (type, id) as data- attributes on the hast anchor node.
 *   - "Render a single-line string through [the inline-only path]:
 *     linkified, and the output contains no <p>/<ul>/block wrapper."
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Root, Element } from "hast";
import { buildEntityIndex, rehypeEntityLinks, LinkifiedText } from "./entity-linkifier";

afterEach(cleanup);

const TASK_ID = "mt#2370";
const TASK_PATH = "/tasks/mt%232370";

function makeIndex() {
  return buildEntityIndex({
    taskIds: [TASK_ID],
    sessionIds: ["sess-1"],
    askIds: ["ask-1"],
    memoryIds: ["11112222"],
    changesetIds: ["1234"],
    conversationIds: ["conv-1"],
  });
}

function textNode(value: string) {
  return { type: "text" as const, value };
}
function element(tagName: string, children: Element["children"]): Element {
  return { type: "element", tagName, properties: {}, children };
}

describe("makeAnchor — data-entity-* attributes (mt#3174)", () => {
  test("a resolved task ref's anchor carries data-entity-type=task and data-entity-id", () => {
    const index = makeIndex();
    const tree: Root = { type: "root", children: [element("p", [textNode(`see ${TASK_ID}`)])] };
    rehypeEntityLinks({ index })(tree);
    const p = tree.children[0] as Element;
    const anchor = p.children[1] as Element;
    expect(anchor.tagName).toBe("a");
    expect(anchor.properties?.href).toBe(TASK_PATH);
    expect(anchor.properties?.["data-entity-type"]).toBe("task");
    expect(anchor.properties?.["data-entity-id"]).toBe(TASK_ID);
  });

  test("a resolved changeset (PR) ref's anchor carries data-entity-type=changeset", () => {
    const index = makeIndex();
    const tree: Root = { type: "root", children: [element("p", [textNode("see PR #1234")])] };
    rehypeEntityLinks({ index })(tree);
    const p = tree.children[0] as Element;
    const anchor = p.children[1] as Element;
    expect(anchor.properties?.["data-entity-type"]).toBe("changeset");
    expect(anchor.properties?.["data-entity-id"]).toBe("1234");
  });

  test("a minsky:// URI anchor also carries data-entity-* (not id-set gated)", () => {
    // rehypeEntityLinks no-ops entirely on an EMPTY index (see the "empty
    // index -> tree untouched" case in entity-linkifier.test.ts) — use
    // makeIndex() (non-empty) even though minsky:// resolution itself
    // doesn't need mt#2370 specifically to be gated.
    const index = makeIndex();
    const tree: Root = {
      type: "root",
      children: [element("p", [textNode("see minsky://task/mt%232370 now")])],
    };
    rehypeEntityLinks({ index })(tree);
    const p = tree.children[0] as Element;
    const anchor = p.children[1] as Element;
    expect(anchor.properties?.["data-entity-type"]).toBe("task");
    expect(anchor.properties?.["data-entity-id"]).toBe(TASK_ID);
  });

  test("plain text with no resolvable ref produces no data-entity-* anywhere (tree untouched)", () => {
    const index = makeIndex();
    const tree: Root = { type: "root", children: [element("p", [textNode("no refs here")])] };
    rehypeEntityLinks({ index })(tree);
    const p = tree.children[0] as Element;
    expect(p.children).toHaveLength(1);
    expect((p.children[0] as { type: string }).type).toBe("text");
  });
});

describe("Inline-only linkify path (mt#3174 acceptance test)", () => {
  function renderInline(text: string, index = makeIndex()) {
    return render(
      <MemoryRouter>
        <span data-testid="inline-host">
          <LinkifiedText text={text} index={index} />
        </span>
      </MemoryRouter>
    );
  }

  test("a single-line string with a resolvable ref linkifies with NO block-level wrapper", () => {
    const { container, getByTestId } = renderInline(`truncated row referencing ${TASK_ID} here`);
    const host = getByTestId("inline-host");
    // No block elements anywhere in the render — this is what makes the
    // path safe to drop into a truncated single-line row (mt#2556's
    // avoidance target: <Prose> renders block Markdown via <p>).
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector("ul")).toBeNull();
    expect(container.querySelector("div")).toBeNull();
    const anchor = host.querySelector(`a[href="${TASK_PATH}"]`);
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toBe(TASK_ID);
    expect(host.textContent).toBe(`truncated row referencing ${TASK_ID} here`);
  });

  test("plain text with no refs round-trips as plain text, still no block wrapper", () => {
    const { container, getByTestId } = renderInline("nothing to link here");
    expect(container.querySelector("p")).toBeNull();
    expect(getByTestId("inline-host").textContent).toBe("nothing to link here");
  });

  test("reuses tokenizeEntities unchanged — an unresolved mt# stays plain text (zero false positives)", () => {
    const { getByTestId } = renderInline("see mt#99999999 unresolved");
    const host = getByTestId("inline-host");
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("see mt#99999999 unresolved");
  });
});
