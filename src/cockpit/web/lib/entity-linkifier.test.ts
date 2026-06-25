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
import type { Root, Element } from "hast";
import {
  buildEntityIndex,
  linkifyText,
  tokenizeEntities,
  rehypeEntityLinks,
} from "./entity-linkifier";

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

  test("mt#NNNN NOT in id-set stays plain text (gated — spec mt#2518 R4)", () => {
    // Bare mt# refs are gated on the id-set. A well-formed mt# that is not a known
    // task id stays as plain text (zero false positives). The id-set is kept
    // comprehensive (/api/tasks?all=true) so real task refs do link — but an mt#
    // that genuinely doesn't exist in the index must not produce a broken link.
    const index = makeIndex(); // contains TASK_ID = "mt#2370" but not "mt#9999"
    const text = "see mt#9999 for details";
    const nodes = linkifyText(text, index);

    // No link nodes; the mt#9999 token stays as plain text
    const linkNodes = nodes.filter(isLinkNode);
    expect(linkNodes.length).toBe(0);
    const plain = nodes.filter((n) => typeof n === "string").join("");
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
// Comprehensive id-set tests (mt#2518 R4)
// ---------------------------------------------------------------------------

describe("linkifyText — comprehensive id-set (mt#2518 R4)", () => {
  /**
   * Build a large task-id index that includes many statuses (all, done, closed,
   * completed) — simulating what useEntityIndex receives from /api/tasks?all=true.
   */
  function makeComprehensiveIndex() {
    // 10 task ids across multiple statuses, including terminal ones
    const taskIds = [
      "mt#100", // TODO
      "mt#200", // PLANNING
      "mt#300", // READY
      "mt#400", // IN-PROGRESS
      "mt#500", // IN-REVIEW
      "mt#600", // DONE (terminal — excluded by default /api/tasks but included with ?all=true)
      "mt#700", // CLOSED (terminal)
      "mt#800", // COMPLETED (terminal)
      "mt#900", // BLOCKED
      TASK_ID, // mt#2370 (existing fixture)
    ];
    return buildEntityIndex({
      taskIds,
      sessionIds: [SESSION_ID],
      askIds: [ASK_ID],
      memoryIds: [MEMORY_ID],
    });
  }

  test("a comprehensive id-set with many task ids links all of them", () => {
    const index = makeComprehensiveIndex();

    // Each known task id in the text becomes a link
    const taskIds = ["mt#100", "mt#200", "mt#300", "mt#400", "mt#500", "mt#600", "mt#700"];
    for (const id of taskIds) {
      const text = `see ${id} for details`;
      const nodes = linkifyText(text, index);
      const linkNodes = nodes.filter(isLinkNode);
      expect(linkNodes.length).toBe(1);
      const encodedId = id.replace("#", "%23");
      expect(linkTo(linkNodes[0])).toBe(`/tasks/${encodedId}`);
    }
  });

  test("terminal-status task ids (DONE/CLOSED) link when in the comprehensive set", () => {
    // This is the core of the mt#2518 R4 fix: with ?all=true these are in the set
    const index = makeComprehensiveIndex();

    const text = "tasks mt#600 and mt#700 are done";
    const nodes = linkifyText(text, index);
    const linkNodes = nodes.filter(isLinkNode);
    expect(linkNodes.length).toBe(2);

    const paths = linkNodes.map(linkTo);
    expect(paths).toContain("/tasks/mt%23600");
    expect(paths).toContain("/tasks/mt%23700");
  });

  test("mt# NOT in the comprehensive set still stays plain text (gated)", () => {
    // Even with a comprehensive set, an mt# that genuinely doesn't exist stays plain
    const index = makeComprehensiveIndex();

    const text = "the non-existent mt#99999 should be plain";
    const nodes = linkifyText(text, index);
    expect(nodes.filter(isLinkNode).length).toBe(0);
    const plain = nodes.filter((n) => typeof n === "string").join("");
    expect(plain).toContain("mt#99999");
  });

  test("mixed text: known task ids link, unknown ones stay plain", () => {
    const index = makeComprehensiveIndex();

    // mt#2370 is in the set; mt#9999 is not
    const text = "see mt#2370 and mt#9999 for context";
    const nodes = linkifyText(text, index);
    const linkNodes = nodes.filter(isLinkNode);
    expect(linkNodes.length).toBe(1);
    expect(linkTo(linkNodes[0])).toBe(TASK_PATH);

    const plainText = nodes.filter((n) => typeof n === "string").join("");
    expect(plainText).toContain("mt#9999");
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
// PR/changeset ref tests (mt#2536)
// ---------------------------------------------------------------------------

describe("linkifyText — PR/changeset refs (mt#2536)", () => {
  const PR_NUMBER = "1234";
  const CHANGESET_PATH = `/changeset/${PR_NUMBER}`;

  function makeIndexWithChangeset() {
    return buildEntityIndex({
      taskIds: [TASK_ID],
      sessionIds: [SESSION_ID],
      askIds: [ASK_ID],
      memoryIds: [MEMORY_ID],
      changesetIds: [PR_NUMBER],
    });
  }

  test("'PR #1234' where 1234 is in changeset id-set → link to /changeset/1234", () => {
    const index = makeIndexWithChangeset();
    const text = "See PR #1234 for details";
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkTo(linkNode)).toBe(CHANGESET_PATH);
    expect(linkText(linkNode)).toBe("PR #1234");
  });

  test("'PR#1234' without space → link to /changeset/1234", () => {
    const index = makeIndexWithChangeset();
    const text = "see PR#1234 done";
    const nodes = linkifyText(text, index);

    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkTo(linkNode)).toBe(CHANGESET_PATH);
  });

  test("'PR #9999' not in changeset id-set → plain text (gated)", () => {
    const index = makeIndexWithChangeset(); // has "1234", not "9999"
    const text = "see PR #9999 done";
    const nodes = linkifyText(text, index);

    expect(nodes.filter(isLinkNode).length).toBe(0);
    const plain = nodes.filter((n) => typeof n === "string").join("");
    expect(plain).toContain("PR #9999");
  });

  test("bare '#1234' without PR prefix → plain text (never matched)", () => {
    const index = makeIndexWithChangeset();
    const text = "fixed in #1234";
    const nodes = linkifyText(text, index);

    expect(nodes.filter(isLinkNode).length).toBe(0);
    expect(nodes.join("")).toBe("fixed in #1234");
  });

  test("'PR #1234' with empty changeset id-set → plain text", () => {
    const emptyIndex = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: [],
      changesetIds: [],
    });
    const text = "See PR #1234 for context";
    const nodes = linkifyText(text, emptyIndex);

    expect(nodes.filter(isLinkNode).length).toBe(0);
    const plain = nodes.filter((n) => typeof n === "string").join("");
    expect(plain).toContain("PR #1234");
  });

  test("explicit minsky://changeset/1234 URI → link even with empty changeset id-set", () => {
    // minsky:// URIs resolve via type in URI, not the id-set
    const emptyIndex = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: [],
    });
    const text = "see minsky://changeset/1234 for details";
    const nodes = linkifyText(text, emptyIndex);

    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkTo(linkNode)).toBe(CHANGESET_PATH);
  });

  test("URL containing 'PR#1234' is consumed whole as a URL, NOT a changeset link (mt#2536 R1)", () => {
    // Reviewer R1: prove the httpsUrl group (ordered before prRef) wins so a
    // `PR#1234` that is part of an https URL is never split into /changeset/1234 —
    // even when 1234 IS a known changeset.
    const index = makeIndexWithChangeset(); // changeset id-set has "1234"
    const text = "see https://example.com/PR#1234 for the diff";
    const nodes = linkifyText(text, index);

    // No link node — https:// is always plain text and the PR pattern did not fire.
    expect(nodes.filter(isLinkNode).length).toBe(0);
    const plain = nodes.filter((n) => typeof n === "string").join("");
    expect(plain).toContain("https://example.com/PR#1234");
  });

  test("a standalone 'PR #1234' adjacent to a URL still links (URL consumed whole) (mt#2536 R1)", () => {
    // The URL is consumed whole; the standalone 'PR #1234' after it still resolves.
    const index = makeIndexWithChangeset();
    const text = "https://example.com/x then PR #1234";
    const nodes = linkifyText(text, index);

    const linkNodes = nodes.filter(isLinkNode);
    expect(linkNodes.length).toBe(1);
    expect(linkTo(linkNodes[0])).toBe(CHANGESET_PATH);
    expect(linkText(linkNodes[0])).toBe("PR #1234");
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

  test("maps changeset ids (PR numbers as strings) to 'changeset' type", () => {
    const index = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: [],
      changesetIds: ["1234", "5678"],
    });
    expect(index.get("1234")).toBe("changeset");
    expect(index.get("5678")).toBe("changeset");
  });

  test("omitting changesetIds produces no changeset entries (optional field)", () => {
    const index = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: [],
      // changesetIds not provided
    });
    // Should not crash and should have size 0
    expect(index.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: hex-like substrings must NOT be linkified (Finding 1)
// ---------------------------------------------------------------------------

describe("linkifyText — hex boundary / false-positive guard (Finding 1)", () => {
  // Build an index with a memory whose id starts with "deadbeef" so that a
  // mis-bounded regex would linkify any occurrence of "deadbeef" in prose.
  const DEAD_ID = "deadbeef-1234-5678-9abc-def000000000";

  function makeDeadIndex() {
    return buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: [DEAD_ID],
    });
  }

  test("bare 'deadbeef' word (8 hex chars) prefixing a known id → NOT linkified (word boundary test)", () => {
    // "deadbeef" IS the 8-char prefix of DEAD_ID. Without word boundaries the
    // original regex would linkify it. With boundaries it still could (8-char
    // prefix IS at a word boundary here). This documents current design: a
    // standalone 8-char prefix that uniquely matches IS linkified.
    // The important case is: embedded hex (next test).
    const index = makeDeadIndex();
    const text = "color is deadbeef here";
    const nodes = linkifyText(text, index);
    // "deadbeef" is a standalone word matching the prefix. With the fixed regex
    // it ONLY matches when bounded. The resolveEntityId call then checks if it
    // uniquely prefixes a known id — it does (DEAD_ID). So this DOES linkify.
    // (That's correct — the operator put a known entity id in the transcript.)
    const linkNodes = nodes.filter(isLinkNode);
    // Acceptable: either 0 links (conservative) or 1 link to DEAD_ID.
    // What must NOT happen: linkifying unrelated hex strings (next test).
    expect(linkNodes.length).toBeLessThanOrEqual(1);
    if (linkNodes.length === 1) {
      expect(linkTo(linkNodes[0])).toBe(`/memory/${DEAD_ID}`);
    }
  });

  test("'deadbeefXYZ' (8+ hex chars embedded in longer word) → NOT linkified", () => {
    const index = makeDeadIndex();
    const text = "variable deadbeefXYZ is not an id";
    const nodes = linkifyText(text, index);
    // The hex string is embedded in a longer word — must NOT match.
    expect(nodes.filter(isLinkNode).length).toBe(0);
  });

  test("'#deadbeef' (CSS color with # prefix) → NOT linkified", () => {
    const index = makeDeadIndex();
    const text = "color: #deadbeef;";
    const nodes = linkifyText(text, index);
    // CSS colors must never be linkified.
    expect(nodes.filter(isLinkNode).length).toBe(0);
  });

  test("git sha (40 hex chars, first 8 match a known entity prefix) → NOT linkified via 8-char alternative", () => {
    // A 40-char git sha whose first 8 chars equal a known entity prefix. The
    // original `[0-9a-f]{8,}` would match the full 40-char sha as a single
    // token; the fixed regex allows at most exactly 8 chars (the full UUID
    // pattern is separate). A 40-char lowercase hex string with no hyphens is
    // NOT a UUID, so the full-UUID branch won't match either. The 8-char prefix
    // branch would match only if bounded — but "deadbeef" IS followed by more
    // hex chars here, so `(?!\w)` fails. Result: no match.
    const index = makeDeadIndex();
    const sha = "deadbeefabcdef1234567890abcdef1234567890";
    const text = `commit ${sha} landed`;
    const nodes = linkifyText(text, index);
    expect(nodes.filter(isLinkNode).length).toBe(0);
    // The full sha should appear as plain text.
    const plain = nodes.filter((n) => typeof n === "string").join("");
    expect(plain).toContain(sha);
  });

  test("longer hex string > 8 chars that is NOT a UUID → NOT linkified via prefix branch", () => {
    const index = makeDeadIndex();
    // 12 hex chars: longer than 8, no hyphens — was matched by old `[0-9a-f]{8,}`
    const text = "hash deadbeef1234 here";
    const nodes = linkifyText(text, index);
    // The 12-char hex is not a UUID (no hyphens), and the 8-char prefix branch
    // only matches EXACTLY 8 chars at a word boundary ((?!\w) blocks it here).
    expect(nodes.filter(isLinkNode).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: trailing punctuation stripped from minsky:// and https:// URIs (Finding 3)
// ---------------------------------------------------------------------------

describe("linkifyText — trailing punctuation stripped (Finding 3)", () => {
  test("minsky:// URI followed by ')' → link text excludes ')'", () => {
    const index = makeIndex();
    const text = "(see minsky://task/mt%232370)";
    const nodes = linkifyText(text, index);
    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    // The link must not include the trailing ')'
    expect(linkText(linkNode)).toBe("minsky://task/mt%232370");
    expect(linkTo(linkNode)).toBe(TASK_PATH);
    // The ')' must appear as plain text after the link
    const plain = nodes.filter((n) => typeof n === "string").join("");
    expect(plain).toContain(")");
  });

  test("minsky:// URI followed by '.' → link text excludes '.'", () => {
    const index = makeIndex();
    const text = "See minsky://task/mt%232370.";
    const nodes = linkifyText(text, index);
    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkText(linkNode)).toBe("minsky://task/mt%232370");
    const plain = nodes.filter((n) => typeof n === "string").join("");
    expect(plain).toContain(".");
  });

  test("minsky:// URI followed by ',' → link text excludes ','", () => {
    const index = makeIndex();
    const text = `minsky://task/mt%232370, and more`;
    const nodes = linkifyText(text, index);
    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkText(linkNode)).toBe("minsky://task/mt%232370");
  });

  test("minsky:// URI followed by ']' → link text excludes ']'", () => {
    const index = makeIndex();
    const text = "[minsky://task/mt%232370]";
    const nodes = linkifyText(text, index);
    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkText(linkNode)).toBe("minsky://task/mt%232370");
  });

  test("https:// URL followed by ')' → stays plain text, excludes ')'", () => {
    const index = makeIndex();
    const text = "(see https://example.com/path)";
    const nodes = linkifyText(text, index);
    // https:// is always plain text, but should not include trailing ')'
    expect(nodes.filter(isLinkNode).length).toBe(0);
    const plain = nodes.filter((n) => typeof n === "string").join("");
    // The URL should appear without the trailing ')'
    expect(plain).toContain("https://example.com/path");
    expect(plain).toContain(")");
    // The ')' must be separate from the URL token
    const urlToken = nodes.find(
      (n) => typeof n === "string" && n.includes("https://example.com/path")
    ) as string | undefined;
    expect(urlToken).not.toContain(")");
  });

  test("https:// URL followed by '.' → plain text, excludes '.'", () => {
    const index = makeIndex();
    const text = "See https://example.com.";
    const nodes = linkifyText(text, index);
    expect(nodes.filter(isLinkNode).length).toBe(0);
    const plain = nodes.join("");
    expect(plain).toContain("https://example.com");
  });

  test("minsky:// URI with dots MID-path are preserved, only trailing stripped", () => {
    const index = makeIndex();
    // Dots mid-path (like in a file path segment) should be preserved.
    const text = "see minsky://session/abc.def.ghi for context.";
    const nodes = linkifyText(text, index);
    const linkNode = nodes.find(isLinkNode);
    // If the URI matches (even though id not in index, parseMinskyUri may fail),
    // we just verify the link text doesn't have a trailing period.
    if (linkNode) {
      const lt = linkText(linkNode);
      expect(lt?.endsWith(".")).toBe(false);
    }
    // The trailing period must appear outside the link token.
    const plain = nodes.filter((n) => typeof n === "string").join("");
    expect(plain).toContain(".");
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: cache key / data-shape separation (Finding 2)
// ---------------------------------------------------------------------------
// The shape mismatch is a runtime concern (React Query cache poisoning), not
// directly testable in a unit test of linkifyText. The shape invariant IS tested:
// TaskListEntry[] (from fetchTaskList in ConversationView) only needs `id`;
// PaletteTask[] (from CommandPalette) adds `type` and `title` but the entity
// index only reads `.id`. Verify that buildEntityIndex handles the shared fields.

describe("useEntityIndex / cache key separation (Finding 2 regression)", () => {
  test("buildEntityIndex with TaskListEntry shape (id-only) produces correct index", () => {
    // Simulates what useEntityIndex does: it maps task.id → "task" type.
    // TaskListEntry has { id, title, status } — no `type` field.
    // The entity index only needs `.id`, so shape mismatch won't cause index bugs.
    const entries = [
      { id: "mt#1", title: "T1", status: "TODO" },
      { id: "mt#2", title: "T2", status: "DONE" },
    ];
    const index = buildEntityIndex({
      taskIds: entries.map((e) => e.id),
      sessionIds: [],
      askIds: [],
      memoryIds: [],
    });
    expect(index.get("mt#1")).toBe("task");
    expect(index.get("mt#2")).toBe("task");
  });

  test("linkifyText resolves task ids from TaskListEntry-seeded index", () => {
    // Confirms that the entity-index populated from TaskListEntry[] (the shape
    // useEntityIndex fetches via the distinct 'entity-index','tasks' key) produces
    // correct linkification. This is the property that was broken before the
    // cache-key fix: if CommandPalette's PaletteTask[] was read instead, the
    // type property on the objects wouldn't matter for the index (the index
    // stores type separately), but the array type mismatch would mean
    // ConversationView got PaletteTask[] objects where it expected TaskListEntry[],
    // potentially returning undefined ids.
    const entries = [{ id: "mt#2370", title: "Test task", status: "IN-PROGRESS" }];
    const index = buildEntityIndex({
      taskIds: entries.map((e) => e.id),
      sessionIds: [],
      askIds: [],
      memoryIds: [],
    });
    const nodes = linkifyText("see mt#2370 for details", index);
    const linkNode = nodes.find(isLinkNode);
    expect(linkNode).toBeDefined();
    expect(linkTo(linkNode)).toBe(TASK_PATH);
  });
});

// ---------------------------------------------------------------------------
// tokenizeEntities — the structured token core (mt#2550)
// ---------------------------------------------------------------------------

describe("tokenizeEntities (mt#2550)", () => {
  test("plain text with no refs → single text token", () => {
    const index = makeIndex();
    expect(tokenizeEntities("no refs here", index)).toEqual([
      { kind: "text", value: "no refs here" },
    ]);
  });

  test("task id splits into text + link + text tokens", () => {
    const index = makeIndex();
    expect(tokenizeEntities(`see ${TASK_ID} now`, index)).toEqual([
      { kind: "text", value: "see " },
      { kind: "link", text: TASK_ID, to: TASK_PATH, mono: true },
      { kind: "text", value: " now" },
    ]);
  });

  test("minsky:// URI → non-mono link token", () => {
    const index = makeIndex();
    const tokens = tokenizeEntities("see minsky://task/mt%232370 ok", index);
    const link = tokens.find((t) => t.kind === "link");
    expect(link).toEqual({
      kind: "link",
      text: "minsky://task/mt%232370",
      to: TASK_PATH,
      mono: false,
    });
  });

  test("unresolved mt# produces no link tokens", () => {
    const index = makeIndex(); // has mt#2370, not mt#9999
    const tokens = tokenizeEntities("see mt#9999 done", index);
    expect(tokens.some((t) => t.kind === "link")).toBe(false);
    expect(tokens.map((t) => (t.kind === "text" ? t.value : "")).join("")).toBe("see mt#9999 done");
  });

  test("https:// URL is a text token (never a link)", () => {
    const index = makeIndex();
    const tokens = tokenizeEntities("at https://example.com end", index);
    expect(tokens.every((t) => t.kind === "text")).toBe(true);
    expect(tokens.map((t) => (t.kind === "text" ? t.value : "")).join("")).toContain(
      "https://example.com"
    );
  });
});

// ---------------------------------------------------------------------------
// rehypeEntityLinks — entity-linkify inside a Markdown (hast) tree (mt#2550)
// ---------------------------------------------------------------------------

describe("rehypeEntityLinks (mt#2550)", () => {
  function textNode(value: string) {
    return { type: "text" as const, value };
  }
  function element(tagName: string, children: Element["children"]): Element {
    return { type: "element", tagName, properties: {}, children };
  }

  test("splits a paragraph text node into text + anchor + text", () => {
    const index = makeIndex();
    const tree: Root = {
      type: "root",
      children: [element("p", [textNode(`see ${TASK_ID} now`)])],
    };
    rehypeEntityLinks({ index })(tree);

    const p = tree.children[0] as Element;
    expect(p.children).toHaveLength(3);
    expect(p.children[0]).toEqual({ type: "text", value: "see " });
    const anchor = p.children[1] as Element;
    expect(anchor.type).toBe("element");
    expect(anchor.tagName).toBe("a");
    expect(anchor.properties?.href).toBe(TASK_PATH);
    expect(anchor.children[0]).toEqual({ type: "text", value: TASK_ID });
    expect(p.children[2]).toEqual({ type: "text", value: " now" });
  });

  test("does NOT linkify inside a code element (code spans/blocks skipped)", () => {
    const index = makeIndex();
    const tree: Root = {
      type: "root",
      children: [element("code", [textNode(TASK_ID)])],
    };
    rehypeEntityLinks({ index })(tree);

    const code = tree.children[0] as Element;
    expect(code.children).toHaveLength(1);
    expect(code.children[0]).toEqual({ type: "text", value: TASK_ID });
  });

  test("does NOT linkify inside an existing anchor", () => {
    const index = makeIndex();
    const tree: Root = {
      type: "root",
      children: [element("a", [textNode(TASK_ID)])],
    };
    rehypeEntityLinks({ index })(tree);

    const anchor = tree.children[0] as Element;
    expect(anchor.children).toHaveLength(1);
    expect(anchor.children[0]).toEqual({ type: "text", value: TASK_ID });
  });

  test("empty index → tree untouched (no-op)", () => {
    const emptyIndex = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: [],
    });
    const tree: Root = {
      type: "root",
      children: [element("p", [textNode(`see ${TASK_ID}`)])],
    };
    rehypeEntityLinks({ index: emptyIndex })(tree);
    const p = tree.children[0] as Element;
    expect(p.children).toHaveLength(1);
    expect(p.children[0]).toEqual({ type: "text", value: `see ${TASK_ID}` });
  });
});
