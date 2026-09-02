/**
 * Tests for the ask-body external-reference transform (mt#2918).
 *
 * The functions under test are pure string -> string, so nothing here patches
 * a collaborator: every assertion reads a returned value.
 */
import { describe, expect, test } from "bun:test";
import {
  collectNotionIdsFromUrls,
  elideCodeRegions,
  linkifyExternalRefs,
  normalizeNotionId,
  notionPageUrl,
} from "./external-refs";

/** The RFC page id from ask 755ddc6a, the incident this task exists for. */
const INCIDENT_ID = "3a0937f0-3cb4-81a6-8699-e419a5ce4da0";
/** The same id in the dashless form Notion's own page URLs carry. */
const INCIDENT_ID_BARE = "3a0937f03cb481a68699e419a5ce4da0";
const INCIDENT_URL = `https://app.notion.com/p/${INCIDENT_ID_BARE}`;

describe("normalizeNotionId", () => {
  test("strips dashes and lowercases, matching Notion's own URL form", () => {
    expect(normalizeNotionId(INCIDENT_ID)).toBe(INCIDENT_ID_BARE);
    expect(normalizeNotionId("3A0937F0-3CB4-81A6-8699-E419A5CE4DA0")).toBe(INCIDENT_ID_BARE);
  });

  test("is idempotent on an already-bare id", () => {
    const bare = INCIDENT_ID_BARE;
    expect(normalizeNotionId(bare)).toBe(bare);
  });
});

describe("linkifyExternalRefs — the transform", () => {
  test("replays the 755ddc6a incident: a cued dashed id gains the canonical URL", () => {
    const question = `Please accept the RFC (Notion ${INCIDENT_ID}) so Phase 1 can start.`;
    const { text, unlinkified } = linkifyExternalRefs(question);

    expect(text).toContain(INCIDENT_URL);
    expect(unlinkified).toEqual([]);
    // The author's prose is preserved — the URL is appended, not substituted.
    expect(text).toContain(`Notion ${INCIDENT_ID}`);
  });

  test("accepts the bare 32-hex form", () => {
    const { text } = linkifyExternalRefs(`See Notion ${INCIDENT_ID_BARE} first.`);
    expect(text).toContain(INCIDENT_URL);
  });

  test("accepts the 'Notion page id:' phrasing", () => {
    const { text } = linkifyExternalRefs(`Background: Notion page id: ${INCIDENT_ID}`);
    expect(text).toContain(INCIDENT_URL);
  });

  test("transforms every distinct cued id in one body", () => {
    const second = "389937f0-3cb4-81e6-a224-d369a8b373b3";
    const { text } = linkifyExternalRefs(
      `Compare Notion ${INCIDENT_ID} against Notion ${second} before deciding.`
    );
    expect(text).toContain(INCIDENT_URL);
    expect(text).toContain("https://app.notion.com/p/389937f03cb481e6a224d369a8b373b3");
  });

  test("is idempotent: a second pass adds nothing", () => {
    const once = linkifyExternalRefs(`Accept the RFC (Notion ${INCIDENT_ID}).`).text;
    const twice = linkifyExternalRefs(once).text;
    expect(twice).toBe(once);
  });

  test("leaves an author-supplied URL alone", () => {
    const question = `Accept the RFC: ${INCIDENT_URL} (Notion ${INCIDENT_ID}).`;
    expect(linkifyExternalRefs(question).text).toBe(question);
  });
});

describe("linkifyExternalRefs — what it must NOT touch", () => {
  test("an uncued UUID is left alone — it may be a Minsky entity id", () => {
    // This is an ask id, not a Notion page. Rewriting it into a Notion URL
    // would be actively wrong, which is why the cue is required.
    const question = "Close ask 639b443a-411e-4e88-a03a-beac836cd8aa before deciding.";
    const { text, unlinkified } = linkifyExternalRefs(question);
    expect(text).toBe(question);
    expect(unlinkified).toEqual([]);
  });

  test("a cued id inside an inline code span is displayed, not cited", () => {
    const question = `Run the query with \`Notion ${INCIDENT_ID}\` as the argument.`;
    expect(linkifyExternalRefs(question).text).toBe(question);
  });

  test("a cued id inside a fenced block is left alone", () => {
    const question = [
      "Use this payload:",
      "```json",
      `{ "source": "Notion ${INCIDENT_ID}" }`,
      "```",
      "Then approve.",
    ].join("\n");
    expect(linkifyExternalRefs(question).text).toBe(question);
  });

  test("a git SHA is not artifact-shaped and never matches", () => {
    const question = "Revert commit 60e187806 and Notion is not involved here.";
    const { text, unlinkified } = linkifyExternalRefs(question);
    expect(text).toBe(question);
    expect(unlinkified).toEqual([]);
  });

  test("the word Notion with no id nearby produces neither a link nor a warning", () => {
    const question = "The strategy doc lives in Notion; the decision does not depend on it.";
    const { text, unlinkified } = linkifyExternalRefs(question);
    expect(text).toBe(question);
    expect(unlinkified).toEqual([]);
  });
});

describe("linkifyExternalRefs — the warning population", () => {
  test("a cued but truncated id is reported, not silently dropped", () => {
    const { text, unlinkified } = linkifyExternalRefs("Accept the RFC (Notion 3a0937f0-3cb4).");
    expect(text).not.toContain("app.notion.com");
    expect(unlinkified).toHaveLength(1);
    expect(unlinkified[0]).toContain("3a0937f0-3cb4");
  });

  test("a resolved reference is never also reported as unlinkified", () => {
    const { unlinkified } = linkifyExternalRefs(`Notion ${INCIDENT_ID} is the page.`);
    expect(unlinkified).toEqual([]);
  });
});

describe("elideCodeRegions", () => {
  test("preserves length so match offsets stay valid against the original", () => {
    const text = "before `code span` after";
    expect(elideCodeRegions(text)).toHaveLength(text.length);
  });

  test("preserves newlines so fenced blocks keep their line structure", () => {
    const text = "a\n```\nb\nc\n```\nd";
    const elided = elideCodeRegions(text);
    expect(elided).toHaveLength(text.length);
    expect(elided.split("\n")).toHaveLength(text.split("\n").length);
  });
});

describe("notionPageUrl", () => {
  test("builds the canonical form Notion's own API returns", () => {
    expect(notionPageUrl(INCIDENT_ID_BARE)).toBe(INCIDENT_URL);
  });
});

/**
 * mt#4793 SC2/SC7 — eliding may only ever REMOVE matches, never manufacture one.
 *
 * This module is the only elision site in the family on a WRITE path: `linkifyExternalRefs`
 * rewrites ask body text. `NOTION_CUE` contains `[\s:—–-]*`, a whitespace-tolerant separator, so
 * blanking a code region to SPACES let the cue run through the hole and bind `notion` to an id it
 * was never adjacent to — appending a wrong URL into someone's ask.
 *
 * Asserted as the property, not the filler character, so a future filler change that keeps the
 * guarantee passes and one that breaks it fails.
 */
describe("elideCodeRegions only ever removes matches — it never manufactures one", () => {
  // A cue and an id that are NOT adjacent in the raw text: a code span sits between them.
  const RAW = "Notion `see the setup guide` 1234567890abcdef1234567890abcdef";

  test("a cue separated from an id by a code span does not linkify", () => {
    const { text, unlinkified } = linkifyExternalRefs(RAW);
    // No URL may be appended — the cue and the id were never adjacent.
    expect(text).toBe(RAW);
    expect(text).not.toContain("app.notion.com");
    expect(unlinkified).toEqual([]);
  });

  test("the filler is not in the cue's own separator class", () => {
    const residual = elideCodeRegions(RAW);
    // Same-length, so every offset into the residual is still valid against RAW.
    expect(residual).toHaveLength(RAW.length);
    // The blanked span must not read as separator characters, or the cue spans it.
    const blanked = residual.slice(RAW.indexOf("`"), RAW.lastIndexOf("`") + 1);
    expect(blanked).not.toMatch(/[\s:—–-]/);
  });

  test("a genuinely adjacent cue and id still linkify", () => {
    // One-directional guarantee: elision removes matches, it must not remove real ones.
    const adjacent = "Notion 1234567890abcdef1234567890abcdef";
    expect(linkifyExternalRefs(adjacent).text).toContain("app.notion.com");
  });
});

/**
 * mt#4901 — a body citing a page by a SHORT PREFIX of its id, with the full URL
 * in the ask's own contextRefs.
 *
 * ask#10647 is the incident: its question said `Notion 34f937f0` (8 hex — the
 * malformed branch, since a valid id is 32) while its contextRefs carried the
 * full page URL. The reference was reachable and was reported unlinkifiable.
 */
describe("linkifyExternalRefs — resolving a truncated cue from the ask's own refs (mt#4901)", () => {
  const PREFIX = "34f937f0";
  const FULL = "34f937f03cb48108a95bdf3813f5ca84";
  const URL = `https://app.notion.com/p/${FULL}`;
  const BODY = `That record — Notion ${PREFIX}, "Asks subsystem", locked by you 2026-04-26 — settles it.`;

  test("AT2: the prefix resolves against a contextRefs URL and the URL lands in the text", () => {
    const { text, unlinkified } = linkifyExternalRefs(BODY, { knownRefs: [URL] });
    expect(text).toContain(URL);
    expect(unlinkified).toEqual([]);
  });

  test("AT2 negative control: with no refs supplied, the same body still reports it", () => {
    const { text, unlinkified } = linkifyExternalRefs(BODY);
    expect(text).toBe(BODY);
    expect(unlinkified).toEqual([`Notion ${PREFIX}`]);
  });

  test("idempotent across call paths: a second pass with NO options reports nothing", () => {
    // This is what form-lint itself does — it re-runs the transform over the
    // already-normalized question with no options at all.
    const once = linkifyExternalRefs(BODY, { knownRefs: [URL] }).text;
    const twice = linkifyExternalRefs(once);
    expect(twice.text).toBe(once);
    expect(twice.unlinkified).toEqual([]);
  });

  test("an AMBIGUOUS prefix resolves to nothing rather than guessing between two pages", () => {
    const { text, unlinkified } = linkifyExternalRefs(BODY, {
      knownRefs: [URL, `https://app.notion.com/p/${PREFIX}ffffffffffffffffffffffff`],
    });
    expect(text).toBe(BODY);
    expect(unlinkified).toEqual([`Notion ${PREFIX}`]);
  });

  test("only a NOTION-hosted URL is a resolution source — a bare id elsewhere is not", () => {
    // The safety property: a Notion page id and a Minsky ask/memory/workspace id
    // are the same shape, so harvesting every id-shaped run would let a
    // truncated cue resolve against a Minsky entity and append a dead URL.
    const { text, unlinkified } = linkifyExternalRefs(BODY, {
      knownRefs: [`https://github.com/edobry/minsky/pull/1 mentions ${FULL}`],
    });
    expect(text).toBe(BODY);
    expect(unlinkified).toEqual([`Notion ${PREFIX}`]);
  });

  test("collectNotionIdsFromUrls reads app.notion.com and notion.so, and nothing else", () => {
    expect(collectNotionIdsFromUrls(URL)).toEqual([FULL]);
    expect(collectNotionIdsFromUrls(`https://www.notion.so/Some-Page-${FULL}`)).toEqual([FULL]);
    expect(collectNotionIdsFromUrls(`https://example.com/${FULL}`)).toEqual([]);
  });
});
