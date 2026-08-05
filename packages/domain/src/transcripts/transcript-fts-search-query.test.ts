/**
 * Unit tests for the query-shaping helpers behind TranscriptFtsService.searchText().
 *
 * These cover the decisions that do not need a database. The claims that DO
 * depend on Postgres — that a quoted phrase actually enforces adjacency, that
 * the escaping below actually prevents `_` acting as a wildcard once it reaches
 * an ILIKE — are verified against a live server by
 * `scripts/verify-transcript-phrase-search.ts`, because a fake DB cannot
 * evaluate them.
 *
 * @see mt#3713
 */

import { describe, test, expect } from "bun:test";
import {
  DEFAULT_FTS_SEARCH_MODE,
  SNIPPET_MATCH_END,
  SNIPPET_MATCH_START,
  TS_HEADLINE_OPTIONS,
  buildContainsPattern,
  buildLiteralSnippet,
  escapeLikeLiteral,
  parseSearchMode,
  selectLiteralSnippetSource,
  tsQueryFunctionFor,
} from "./transcript-fts-search-query";

describe("parseSearchMode", () => {
  test("accepts each supported mode", () => {
    expect(parseSearchMode("websearch")).toBe("websearch");
    expect(parseSearchMode("plain")).toBe("plain");
    expect(parseSearchMode("exact")).toBe("exact");
  });

  test("falls back to the default for unrecognized input", () => {
    // The HTTP surface passes a raw query-string value straight in, so an
    // unknown mode must degrade rather than error.
    expect(parseSearchMode("fuzzy")).toBe(DEFAULT_FTS_SEARCH_MODE);
    expect(parseSearchMode(undefined)).toBe(DEFAULT_FTS_SEARCH_MODE);
    expect(parseSearchMode(null)).toBe(DEFAULT_FTS_SEARCH_MODE);
    expect(parseSearchMode(42)).toBe(DEFAULT_FTS_SEARCH_MODE);
  });

  test("defaults to websearch, the mode that understands quoted phrases", () => {
    expect(DEFAULT_FTS_SEARCH_MODE).toBe("websearch");
  });
});

describe("tsQueryFunctionFor", () => {
  test("plain uses plainto_tsquery", () => {
    expect(tsQueryFunctionFor("plain")).toBe("plainto_tsquery");
  });

  test("websearch uses websearch_to_tsquery", () => {
    expect(tsQueryFunctionFor("websearch")).toBe("websearch_to_tsquery");
  });

  test("exact uses websearch_to_tsquery for its index prefilter", () => {
    // exact matches by substring, but still builds a tsquery: it gates the
    // ILIKE behind the GIN index rather than scanning the whole table.
    expect(tsQueryFunctionFor("exact")).toBe("websearch_to_tsquery");
  });
});

describe("escapeLikeLiteral", () => {
  test("escapes the underscore wildcard", () => {
    // Without this, `MINSKY_SKIP_FRESHNESS` would match `MINSKYxSKIPxFRESHNESS`
    // and `exact` would not be exact.
    expect(escapeLikeLiteral("MINSKY_SKIP")).toBe("MINSKY\\_SKIP");
  });

  test("escapes the percent wildcard", () => {
    expect(escapeLikeLiteral("100% done")).toBe("100\\% done");
  });

  test("escapes a literal backslash", () => {
    expect(escapeLikeLiteral("a\\b")).toBe("a\\\\b");
  });

  test("escapes the backslash before it can form an unintended escape sequence", () => {
    // A naive implementation that escaped `_` first would turn `\_` into
    // `\\_` and then `\\\_`, changing what the pattern means.
    expect(escapeLikeLiteral("a\\_b")).toBe("a\\\\\\_b");
  });

  test("leaves text with no metacharacters untouched", () => {
    expect(escapeLikeLiteral("branch freshness guard")).toBe("branch freshness guard");
  });
});

describe("buildContainsPattern", () => {
  test("wraps an escaped literal in unescaped wildcards", () => {
    // The surrounding % must stay live — they are the "contains" part.
    expect(buildContainsPattern("a_b")).toBe("%a\\_b%");
  });
});

describe("buildLiteralSnippet", () => {
  const LONG_PREFIX = "x".repeat(400);
  const LONG_SUFFIX = "y".repeat(400);

  test("delimits the match", () => {
    const snippet = buildLiteralSnippet("set MINSKY_FLAG now", "MINSKY_FLAG");
    expect(snippet).toContain(`${SNIPPET_MATCH_START}MINSKY_FLAG${SNIPPET_MATCH_END}`);
  });

  test("preserves the original casing of the matched text", () => {
    const snippet = buildLiteralSnippet("set MINSKY_FLAG now", "minsky_flag");
    expect(snippet).toContain(`${SNIPPET_MATCH_START}MINSKY_FLAG${SNIPPET_MATCH_END}`);
  });

  test("matches case-insensitively", () => {
    expect(buildLiteralSnippet("The Cockpit", "cockpit")).toContain(
      `${SNIPPET_MATCH_START}Cockpit${SNIPPET_MATCH_END}`
    );
  });

  test("cuts a bounded window out of a long text", () => {
    const text = `${LONG_PREFIX}NEEDLE${LONG_SUFFIX}`;
    const snippet = buildLiteralSnippet(text, "NEEDLE");

    expect(snippet).toContain(`${SNIPPET_MATCH_START}NEEDLE${SNIPPET_MATCH_END}`);
    expect(snippet.length).toBeLessThan(text.length / 3);
  });

  test("marks both ends when the window is cut from a longer text", () => {
    const snippet = buildLiteralSnippet(`${LONG_PREFIX}NEEDLE${LONG_SUFFIX}`, "NEEDLE");
    expect(snippet.startsWith("… ")).toBe(true);
    expect(snippet.endsWith(" …")).toBe(true);
  });

  test("does not mark ends that were not cut", () => {
    const snippet = buildLiteralSnippet("short NEEDLE text", "NEEDLE");
    expect(snippet.startsWith("…")).toBe(false);
    expect(snippet.endsWith("…")).toBe(false);
  });

  test("returns the head of the text when the literal is absent", () => {
    // A preview is more useful than an empty string when the match was on the
    // other half of the turn.
    expect(buildLiteralSnippet("some unrelated content", "absent")).toBe("some unrelated content");
  });

  test("returns empty for empty or missing text", () => {
    expect(buildLiteralSnippet(null, "x")).toBe("");
    expect(buildLiteralSnippet(undefined, "x")).toBe("");
    expect(buildLiteralSnippet("", "x")).toBe("");
  });

  test("does not treat an empty literal as a match at position zero", () => {
    expect(buildLiteralSnippet("content", "")).toBe("content");
  });
});

describe("selectLiteralSnippetSource", () => {
  test("prefers the field that contains the literal", () => {
    expect(selectLiteralSnippetSource("no match here", "the NEEDLE is here", "needle")).toBe(
      "the NEEDLE is here"
    );
  });

  test("prefers user text when both contain the literal", () => {
    expect(selectLiteralSnippetSource("needle a", "needle b", "needle")).toBe("needle a");
  });

  test("falls back to the first non-empty field when neither contains it", () => {
    expect(selectLiteralSnippetSource(null, "assistant only", "absent")).toBe("assistant only");
    expect(selectLiteralSnippetSource("", "assistant only", "absent")).toBe("assistant only");
  });

  test("returns null when the turn has no text at all", () => {
    expect(selectLiteralSnippetSource(null, null, "x")).toBeNull();
  });
});

describe("TS_HEADLINE_OPTIONS", () => {
  test("declares the same delimiters the literal-snippet path uses", () => {
    // A snippet should read identically regardless of which mode produced it.
    expect(TS_HEADLINE_OPTIONS).toContain(`StartSel=${SNIPPET_MATCH_START}`);
    expect(TS_HEADLINE_OPTIONS).toContain(`StopSel=${SNIPPET_MATCH_END}`);
  });

  test("bounds the fragment count and size", () => {
    expect(TS_HEADLINE_OPTIONS).toContain("MaxFragments=");
    expect(TS_HEADLINE_OPTIONS).toContain("MaxWords=");
  });
});
