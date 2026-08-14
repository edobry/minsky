/**
 * Unit tests for the peek's outside-dismiss verdict (mt#4143).
 *
 * These cover the predicate directly, against real DOM nodes, so the cases that
 * are awkward to stage through a rendered assembly — a target three levels deep
 * inside a pane, a non-Element target — are stated once and plainly. The
 * composed behavior is `PeekHost.test.tsx` §AT7's job.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  PEEK_PANE_ATTR,
  ENTITY_REF_ATTR,
  isInsidePeekPane,
  isInsideEntityRef,
  shouldDismissPeek,
  outsideEventTarget,
} from "./peek-dismiss";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isInsidePeekPane", () => {
  test("true for the pane element itself", () => {
    const host = mount(`<div ${PEEK_PANE_ATTR}="true" id="pane"></div>`);
    expect(isInsidePeekPane(host.querySelector("#pane"))).toBe(true);
  });

  test("true for a node nested deep inside a pane", () => {
    const host = mount(
      `<div ${PEEK_PANE_ATTR}="true"><header><button id="close">x</button></header></div>`
    );
    expect(isInsidePeekPane(host.querySelector("#close"))).toBe(true);
  });

  test("false for a sibling of the pane", () => {
    const host = mount(`<div ${PEEK_PANE_ATTR}="true"></div><p id="chrome">page</p>`);
    expect(isInsidePeekPane(host.querySelector("#chrome"))).toBe(false);
  });
});

describe("isInsideEntityRef", () => {
  test("true for the anchor and for a span inside it", () => {
    const host = mount(`<a ${ENTITY_REF_ATTR}="true" id="ref"><span id="label">mt#1</span></a>`);
    expect(isInsideEntityRef(host.querySelector("#ref"))).toBe(true);
    expect(isInsideEntityRef(host.querySelector("#label"))).toBe(true);
  });

  test("false for an ordinary link", () => {
    const host = mount(`<a id="plain" href="/x">x</a>`);
    expect(isInsideEntityRef(host.querySelector("#plain"))).toBe(false);
  });
});

describe("shouldDismissPeek", () => {
  test("dismisses on neutral page chrome", () => {
    const host = mount(`<p id="chrome">page</p>`);
    expect(shouldDismissPeek(host.querySelector("#chrome"))).toBe(true);
  });

  test("does NOT dismiss inside a pane", () => {
    const host = mount(`<div ${PEEK_PANE_ATTR}="true"><p id="body">body</p></div>`);
    expect(shouldDismissPeek(host.querySelector("#body"))).toBe(false);
  });

  test("does NOT dismiss on an entity ref", () => {
    const host = mount(`<a ${ENTITY_REF_ATTR}="true" id="ref">mt#1</a>`);
    expect(shouldDismissPeek(host.querySelector("#ref"))).toBe(false);
  });

  test("does NOT dismiss on an entity ref that is itself inside a pane", () => {
    // A ref rendered in a pane BODY is the ordinary way to walk from one entity
    // to the next; both exemptions cover it and neither is redundant here.
    const host = mount(
      `<div ${PEEK_PANE_ATTR}="true"><a ${ENTITY_REF_ATTR}="true" id="ref">mt#1</a></div>`
    );
    expect(shouldDismissPeek(host.querySelector("#ref"))).toBe(false);
  });

  test("dismisses on a target that is not an Element at all", () => {
    // `document` is what a focus-leaving-the-window event reports. It is
    // inside no pane and no ref, so dismissing is the correct reading — and
    // reaching for `closest` on it would throw.
    expect(shouldDismissPeek(document)).toBe(true);
    expect(shouldDismissPeek(null)).toBe(true);
    expect(shouldDismissPeek(undefined)).toBe(true);
  });
});

describe("outsideEventTarget", () => {
  test("pulls the original DOM target out of Radix's custom event", () => {
    const el = document.createElement("button");
    expect(outsideEventTarget({ detail: { originalEvent: { target: el } } })).toBe(el);
  });

  test("returns null rather than throwing when the shape is absent", () => {
    expect(outsideEventTarget({})).toBeNull();
    expect(outsideEventTarget({ detail: {} })).toBeNull();
    expect(outsideEventTarget({ detail: { originalEvent: {} } })).toBeNull();
  });
});
