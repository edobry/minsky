/**
 * new-conversation shortcut matcher tests (mt#3464).
 *
 * Events are DISPATCHED on real elements and matched inside a real `window`
 * keydown listener rather than passing a hand-built object to the matcher:
 * the guard's whole job is to read `e.target`, and only a dispatched event
 * has a real one.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { isTextEntryTarget, matchesNewConversationShortcut } from "./new-conversation";

/** Dispatch a keydown from `target` and report the matcher's verdict. */
function matchOnDispatch(target: Element, init: KeyboardEventInit): boolean {
  let matched = false;
  const handler = (e: Event) => {
    matched = matchesNewConversationShortcut(e as KeyboardEvent);
  };
  window.addEventListener("keydown", handler);
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  window.removeEventListener("keydown", handler);
  return matched;
}

function mount<T extends HTMLElement>(el: T): T {
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("matchesNewConversationShortcut", () => {
  test("⌘⇧O from a non-text target matches", () => {
    expect(matchOnDispatch(document.body, { key: "O", metaKey: true, shiftKey: true })).toBe(true);
  });

  test("matches case-insensitively (key is shift-adjusted on macOS)", () => {
    expect(matchOnDispatch(document.body, { key: "o", metaKey: true, shiftKey: true })).toBe(true);
  });

  test("⌘O without shift does not match", () => {
    expect(matchOnDispatch(document.body, { key: "O", metaKey: true, shiftKey: false })).toBe(
      false
    );
  });

  test("plain O does not match", () => {
    expect(matchOnDispatch(document.body, { key: "O" })).toBe(false);
  });

  test("Ctrl+Shift+O does NOT match — that chord is Chrome's Bookmarks Manager on Windows/Linux", () => {
    expect(matchOnDispatch(document.body, { key: "O", ctrlKey: true, shiftKey: true })).toBe(false);
  });

  test("⌘⇧N does not match — reserved by Chrome for incognito", () => {
    expect(matchOnDispatch(document.body, { key: "N", metaKey: true, shiftKey: true })).toBe(false);
  });

  test("adding Alt does not match", () => {
    expect(
      matchOnDispatch(document.body, { key: "O", metaKey: true, shiftKey: true, altKey: true })
    ).toBe(false);
  });

  test("suppressed while focus is in a textarea", () => {
    const textarea = mount(document.createElement("textarea"));
    expect(matchOnDispatch(textarea, { key: "O", metaKey: true, shiftKey: true })).toBe(false);
  });

  test("suppressed while focus is in an input", () => {
    const input = mount(document.createElement("input"));
    expect(matchOnDispatch(input, { key: "O", metaKey: true, shiftKey: true })).toBe(false);
  });

  test("suppressed inside a contenteditable region", () => {
    const div = mount(document.createElement("div"));
    div.contentEditable = "true";
    // happy-dom does not always derive `isContentEditable` from the attribute;
    // assert on the property the guard actually reads.
    if (!div.isContentEditable) {
      Object.defineProperty(div, "isContentEditable", { value: true });
    }
    expect(matchOnDispatch(div, { key: "O", metaKey: true, shiftKey: true })).toBe(false);
  });
});

describe("isTextEntryTarget", () => {
  test("null and non-elements are not text entry", () => {
    expect(isTextEntryTarget(null)).toBe(false);
  });

  test("a button is not text entry", () => {
    expect(isTextEntryTarget(mount(document.createElement("button")))).toBe(false);
  });

  test("input, textarea, and select are text entry", () => {
    expect(isTextEntryTarget(mount(document.createElement("input")))).toBe(true);
    expect(isTextEntryTarget(mount(document.createElement("textarea")))).toBe(true);
    expect(isTextEntryTarget(mount(document.createElement("select")))).toBe(true);
  });
});
