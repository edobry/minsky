/**
 * Tests for the entity linkifier (mt#2518).
 *
 * Tests the pure `linkifyText(text, index)` function without rendering React.
 * Checks that the returned ReactNode[] contains the right mix of strings
 * (plain text) and React elements (links).
 *
 * React Router's <Link> is mocked at the module level so the tests don't
 * require a Router context or DOM. The mock captures the `to` prop so we
 * can assert on the generated paths.
 */
import { describe, test, expect } from "bun:test";
import type { ReactElement } from "react";
import { buildEntityIndex, linkifyText } from "./entity-linkifier";

// ---------------------------------------------------------------------------
// Helpers for inspecting ReactNode[] without rendering
// ---------------------------------------------------------------------------

/** Determine if a node is a React element (not a plain string). */
function isLinkNode(node: unknown): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in (node as object);
}

/** Extract the `to` prop from a Link ReactElement (produced by linkifyText). */
function linkTo(node: unknown): string | undefined {
  if (!isLinkNode(node)) return undefined;
  return (node as ReactElement<{ to: string }>).props.to;
}

/** Extract the text content of a Link's children. */
function linkText(node: unknown): string | undefined {
  if (!isLinkNode(node)) return undefined;
  const children = (node as ReactElement<{ children?: unknown }>).props.children;
  return typeof children === "string" ? children : String(children);
}

// Mock react-router-dom Link so we don't need a Router context.
// The real Link just renders an <a> tag; for testing we only care about
// the `to` prop being correct.
// Bun's module mocking is done at import time — we import from a test-local
// re-export instead. Since the function uses `createElement(Link, ...)` we can
// override the module by providing a mock before running.
//
// Alternative: Just check the returned element type and props directly.
// React.createElement returns `{ type, props, ... }` even without rendering,
// so we can inspect `.props.to` on any returned object.

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const TASK_ID = "mt#2370";
const TASK_PATH = "/tasks/mt%232370";
const SESSION_ID = "4d44d12b-58f0-433e-95b3-8b914693fa39";
const ASK_ID = "0a1b2c3d-5678-0000-0000-000000000000";
const MEMORY_ID = "bd38be2c-1234-5678-9abc-def000000000";

function makeIndex() {
  return buildEntityIndex({
    taskIds: [TASK_ID],
    sessionIds: [SESSION_ID],
    askIds: [ASK_ID],
    memoryIds: [MEMORY_ID],
  });
}

// ---------------------------------------------------------------------------
// minsky:// URI tests
// ---------------------------------------------------------------------------

describe("linkifyText — minsky:// URIs", () => {
  test("explicit minsky://task URI becomes a link to /tasks/:id", () => {
    const index = makeIndex();
    const text = "see minsky://task/mt%232370 for details";
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkTo(linkNode)).toBe(TASK_PATH);
    expect(linkText(linkNode)).toBe("minsky://task/mt%232370");
  });

  test("explicit minsky://session URI becomes a link to /agents/:id", () => {
    const index = makeIndex();
    const text = `session minsky://session/${SESSION_ID} was used`;
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkTo(linkNode)).toBe(`/agents/${SESSION_ID}`);
  });

  test("explicit minsky://ask URI becomes a link to /ask/:id", () => {
    const index = makeIndex();
    const text = `minsky://ask/${ASK_ID}`;
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkTo(linkNode)).toBe(`/ask/${ASK_ID}`);
  });

  test("explicit minsky://memory URI becomes a link to /memory/:id", () => {
    const index = makeIndex();
    const text = `see minsky://memory/${MEMORY_ID}`;
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkTo(linkNode)).toBe(`/memory/${MEMORY_ID}`);
  });

  test("minsky:// URI resolves even when id is NOT in the id-set", () => {
    const emptyIndex = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: [],
    });
    const text = "see minsky://task/mt%232370 (not in index)";
    const nodes = linkifyText(text, emptyIndex);

    // Should still create a link because the type is in the URI
    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkTo(linkNode)).toBe(TASK_PATH);
  });

  test("minsky:// URI with unknown type stays plain text", () => {
    const index = makeIndex();
    const text = "see minsky://pr/123 for details";
    const nodes = linkifyText(text, index);

    // No link nodes; the minsky://pr/123 token stays as plain text
    const linkNodes = nodes.filter(isLinkNode);
    expect(linkNodes.length).toBe(0);
    const plainText = nodes.filter((n) => typeof n === "string").join("");
    expect(plainText).toContain("minsky://pr/123");
  });
});

// ---------------------------------------------------------------------------
// Bare task id (mt#NNNN) tests
// ---------------------------------------------------------------------------

describe("linkifyText — bare task ids", () => {
  test("mt#NNNN in id-set becomes a link", () => {
    const index = makeIndex();
    const text = `see ${TASK_ID} for details`;
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkTo(linkNode)).toBe(TASK_PATH);
    expect(linkText(linkNode)).toBe(TASK_ID);
  });

  test("mt#NNNN NOT in id-set stays plain text", () => {
    const index = makeIndex();
    const text = "see mt#9999 for details";
    const nodes = linkifyText(text, index);

    const linkNodes = nodes.filter(isLinkNode);
    expect(linkNodes.length).toBe(0);
    const plain = nodes.join("");
    expect(plain).toContain("mt#9999");
  });

  test("#define is not treated as a task id", () => {
    const index = makeIndex();
    const text = "#define FOO 1";
    const nodes = linkifyText(text, index);

    expect(nodes.filter(isLinkNode).length).toBe(0);
    expect(nodes.join("")).toBe("#define FOO 1");
  });

  test("prefix-less #2370 is not treated as a task id", () => {
    const index = makeIndex();
    const text = "fixed in #2370";
    const nodes = linkifyText(text, index);

    expect(nodes.filter(isLinkNode).length).toBe(0);
    expect(nodes.join("")).toBe("fixed in #2370");
  });
});

// ---------------------------------------------------------------------------
// Bare UUID / session / ask / memory id tests
// ---------------------------------------------------------------------------

describe("linkifyText — bare UUIDs", () => {
  test("full session UUID in id-set becomes a link to /agents/:id", () => {
    const index = makeIndex();
    const text = `session ${SESSION_ID} started`;
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkTo(linkNode)).toBe(`/agents/${SESSION_ID}`);
  });

  test("full ask UUID in id-set becomes a link to /ask/:id", () => {
    const index = makeIndex();
    const text = `ask ${ASK_ID} is pending`;
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkTo(linkNode)).toBe(`/ask/${ASK_ID}`);
  });

  test("full memory UUID in id-set becomes a link to /memory/:id", () => {
    const index = makeIndex();
    const text = `memory ${MEMORY_ID} is relevant`;
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkTo(linkNode)).toBe(`/memory/${MEMORY_ID}`);
  });

  test("UUID NOT in id-set stays plain text", () => {
    const index = makeIndex();
    const unknown = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
    const text = `some uuid ${unknown} here`;
    const nodes = linkifyText(text, index);

    expect(nodes.filter(isLinkNode).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unique-prefix match tests
// ---------------------------------------------------------------------------

describe("linkifyText — unique-prefix match", () => {
  test("8-char prefix of memory id resolves uniquely → link", () => {
    const index = makeIndex();
    // MEMORY_ID = "bd38be2c-1234-5678-9abc-def000000000"
    // 8-char prefix: "bd38be2c"
    const text = "see bd38be2c for memory details";
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    // Links to the FULL memory id
    expect(linkTo(linkNode)).toBe(`/memory/${MEMORY_ID}`);
  });

  test("ambiguous prefix (matches multiple ids) → plain text", () => {
    // Add two memories that share the same 8-char prefix
    const ambiguousIndex = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: ["bd38be2c-0000-0000-0000-000000000001", "bd38be2c-0000-0000-0000-000000000002"],
    });
    const text = "see bd38be2c here";
    const nodes = linkifyText(text, ambiguousIndex);

    expect(nodes.filter(isLinkNode).length).toBe(0);
  });

  test("prefix too short (< 8 chars) → never prefix-matches → plain text", () => {
    const index = makeIndex();
    // "bd38be" is 6 chars — below the 8-char minimum
    const text = "see bd38be for details";
    const nodes = linkifyText(text, index);

    expect(nodes.filter(isLinkNode).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Conservative / zero-false-positive tests
// ---------------------------------------------------------------------------

describe("linkifyText — conservative (zero false positives)", () => {
  test("https:// URL stays plain text", () => {
    const index = makeIndex();
    const text = "see https://example.com for more";
    const nodes = linkifyText(text, index);

    expect(nodes.filter(isLinkNode).length).toBe(0);
    expect(nodes.join("")).toContain("https://example.com");
  });

  test("empty text returns empty array", () => {
    const index = makeIndex();
    expect(linkifyText("", index)).toEqual([]);
  });

  test("plain text with no entity refs returns a single string", () => {
    const index = makeIndex();
    const text = "no refs here";
    const nodes = linkifyText(text, index);

    expect(nodes.length).toBe(1);
    expect(nodes[0]).toBe("no refs here");
  });

  test("text with multiple entity refs in a sentence", () => {
    const index = makeIndex();
    const text = `task ${TASK_ID} and session ${SESSION_ID} are related`;
    const nodes = linkifyText(text, index);

    const linkNodes = nodes.filter(isLinkNode);
    expect(linkNodes.length).toBe(2);

    const paths = linkNodes.map(linkTo);
    expect(paths).toContain(TASK_PATH);
    expect(paths).toContain(`/agents/${SESSION_ID}`);
  });
});

// ---------------------------------------------------------------------------
// buildEntityIndex tests
// ---------------------------------------------------------------------------

describe("buildEntityIndex", () => {
  test("maps task ids to 'task' type", () => {
    const index = buildEntityIndex({
      taskIds: ["mt#1234"],
      sessionIds: [],
      askIds: [],
      memoryIds: [],
    });
    expect(index.get("mt#1234")).toBe("task");
  });

  test("maps session ids to 'session' type", () => {
    const index = buildEntityIndex({
      taskIds: [],
      sessionIds: [SESSION_ID],
      askIds: [],
      memoryIds: [],
    });
    expect(index.get(SESSION_ID)).toBe("session");
  });

  test("maps ask ids to 'ask' type", () => {
    const index = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [ASK_ID],
      memoryIds: [],
    });
    expect(index.get(ASK_ID)).toBe("ask");
  });

  test("maps memory ids to 'memory' type", () => {
    const index = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: [MEMORY_ID],
    });
    expect(index.get(MEMORY_ID)).toBe("memory");
  });
});
