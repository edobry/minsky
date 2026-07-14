/**
 * Unit tests for RunDetail's URL<->tab mapping (mt#2768 success criterion:
 * "tab state is URL-addressable — deep-link to a specific tab works, hard
 * refresh works"). Pure functions, no component render needed.
 */
import { describe, test, expect } from "bun:test";
import { basePathFor, defaultTabFor, tabFromPathname, pathForTab } from "./RunDetail";

// Shared fixture base paths — hoisted to module scope (not re-declared per
// describe block) to avoid the repo's magic-string-duplication lint rule.
const WS_BASE = "/agents/abc123";
const CONV_BASE = "/conversation/xyz789";

describe("basePathFor", () => {
  test("workspace keySpace -> /agents/:id", () => {
    expect(basePathFor("workspace", "abc123")).toBe("/agents/abc123");
  });

  test("conversation keySpace -> /conversation/:id", () => {
    expect(basePathFor("conversation", "xyz789")).toBe("/conversation/xyz789");
  });

  test("encodes special characters in the id", () => {
    expect(basePathFor("workspace", "a b")).toBe("/agents/a%20b");
  });
});

describe("defaultTabFor", () => {
  test("workspace lands on overview", () => {
    expect(defaultTabFor("workspace")).toBe("overview");
  });

  test("conversation lands on conversation", () => {
    expect(defaultTabFor("conversation")).toBe("conversation");
  });
});

describe("tabFromPathname", () => {
  const wsBase = WS_BASE;
  const convBase = CONV_BASE;

  test("bare workspace base path -> overview (default, landing tab)", () => {
    expect(tabFromPathname(wsBase, wsBase, "workspace")).toBe("overview");
  });

  test("/agents/:id/conversation -> conversation tab", () => {
    expect(tabFromPathname(`${wsBase}/conversation`, wsBase, "workspace")).toBe("conversation");
  });

  test("/agents/:id/context -> context tab", () => {
    expect(tabFromPathname(`${wsBase}/context`, wsBase, "workspace")).toBe("context");
  });

  test("bare conversation base path -> conversation (default, landing tab)", () => {
    expect(tabFromPathname(convBase, convBase, "conversation")).toBe("conversation");
  });

  test("/conversation/:id/overview -> overview tab", () => {
    expect(tabFromPathname(`${convBase}/overview`, convBase, "conversation")).toBe("overview");
  });

  test("/conversation/:id/context -> context tab", () => {
    expect(tabFromPathname(`${convBase}/context`, convBase, "conversation")).toBe("context");
  });

  test("an unrecognized suffix falls back to the default landing tab", () => {
    expect(tabFromPathname(`${wsBase}/bogus`, wsBase, "workspace")).toBe("overview");
    expect(tabFromPathname(`${convBase}/bogus`, convBase, "conversation")).toBe("conversation");
  });
});

describe("pathForTab", () => {
  const wsBase = WS_BASE;
  const convBase = CONV_BASE;

  test("the default tab omits the suffix (workspace: overview)", () => {
    expect(pathForTab(wsBase, "workspace", "overview")).toBe(wsBase);
  });

  test("a non-default tab appends its suffix (workspace: conversation)", () => {
    expect(pathForTab(wsBase, "workspace", "conversation")).toBe(`${wsBase}/conversation`);
  });

  test("a non-default tab appends its suffix (workspace: context)", () => {
    expect(pathForTab(wsBase, "workspace", "context")).toBe(`${wsBase}/context`);
  });

  test("the default tab omits the suffix (conversation: conversation)", () => {
    expect(pathForTab(convBase, "conversation", "conversation")).toBe(convBase);
  });

  test("a non-default tab appends its suffix (conversation: overview)", () => {
    expect(pathForTab(convBase, "conversation", "overview")).toBe(`${convBase}/overview`);
  });

  test("round-trips through tabFromPathname for every tab, both keySpaces", () => {
    for (const keySpace of ["workspace", "conversation"] as const) {
      const base = basePathFor(keySpace, "id1");
      for (const tab of ["overview", "conversation", "context"] as const) {
        const path = pathForTab(base, keySpace, tab);
        expect(tabFromPathname(path, base, keySpace)).toBe(tab);
      }
    }
  });
});
