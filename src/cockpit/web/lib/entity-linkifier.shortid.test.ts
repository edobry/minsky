/**
 * Short-id (`mem#N` / `ask#N` / `ws#N`) linkification tests (mt#3259).
 *
 * Before this token class existed, every short id in every prose surface
 * rendered as dead plain text: `TOKEN_RE` recognized `minsky://` URIs,
 * `mt#NNNN`, UUID/hex prefixes, `https://` URLs and `PR #N` — and nothing
 * else. Measured against the live prod DB at the time: 133 task specs and 57
 * memory records carried at least one such unclickable reference.
 *
 * Two properties matter equally here and each has its own describe block:
 *   1. The new class resolves (the fix).
 *   2. It resolves ONLY what it should — the module's zero-false-positive
 *      contract — and the two pre-existing `<word>#<digits>`-shaped classes
 *      (`mt#N`, `PR#N`) still reach their original handlers. That second half
 *      is why the shortId alternative is declared LAST in the regex; a
 *      regression there would silently re-route task and PR refs.
 *
 * @see entity-linkifier.tsx — the tokenizer under test
 * @see docs/architecture/adr-029-numeric-short-ids-foundation.md — why the
 *      link TARGET is not a `minsky://` short-id URI
 */
import { describe, test, expect } from "bun:test";
import { buildEntityIndex, tokenizeEntities } from "./entity-linkifier";

const MEMORY_UUID = "d8891fad-b156-46e1-8940-98067eb097a9";

/** The path a resolved `mem#728` token must link to (`#` percent-encoded). */
const MEM_PATH = "/memory/mem%23728";

/** A sentence-final short id — the trailing-punctuation boundary case. */
const SENTENCE_WITH_MEM = "as recorded in mem#728.";

/** An index carrying one entity of each short-id-bearing type, both id forms. */
const INDEX = buildEntityIndex({
  taskIds: ["mt#2370"],
  sessionIds: [],
  askIds: [],
  memoryIds: [MEMORY_UUID],
  changesetIds: ["1234"],
  memoryShortIds: ["mem#728"],
  askShortIds: ["ask#3346"],
  sessionShortIds: ["ws#42"],
});

/** An index with the SAME entity types but NO short ids registered. */
const INDEX_WITHOUT_SHORT_IDS = buildEntityIndex({
  taskIds: ["mt#2370"],
  sessionIds: [],
  askIds: [],
  memoryIds: [MEMORY_UUID],
  changesetIds: ["1234"],
});

/** The link tokens produced for `text`, as `[text, to]` pairs. */
function links(text: string, index = INDEX): Array<[string, string]> {
  return tokenizeEntities(text, index)
    .filter((t): t is Extract<typeof t, { kind: "link" }> => t.kind === "link")
    .map((t) => [t.text, t.to]);
}

/** The concatenated plain-text runs produced for `text`. */
function plainText(text: string, index = INDEX): string {
  return tokenizeEntities(text, index)
    .filter((t): t is Extract<typeof t, { kind: "text" }> => t.kind === "text")
    .map((t) => t.value)
    .join("");
}

describe("short-id linkification (mt#3259)", () => {
  test("resolves mem#N, ask#N and ws#N in one pass", () => {
    expect(links("see mem#728 and ask#3346 and ws#42")).toEqual([
      ["mem#728", MEM_PATH],
      ["ask#3346", "/ask/ask%233346"],
      ["ws#42", "/agents/ws%2342"],
    ]);
  });

  test("the `#` is percent-encoded in the path, never left raw", () => {
    const to = links("mem#728")[0]?.[1];
    // A raw `#` would make the browser read everything after it as a
    // fragment, so the route would receive `/memory/mem` and 404.
    expect(to).not.toContain("#");
    expect(to).toBe(MEM_PATH);
  });

  test("a ws#N link targets /agents/ (the workspace detail route), not /session/", () => {
    // ADR-022 stage 1: the cockpit route for a workspace is `/agents/:id`.
    // Encoded here because it is the one type whose route segment does not
    // match its entity-type name.
    expect(links("ws#42")[0]?.[1]).toBe("/agents/ws%2342");
  });

  test("case-insensitive: MEM#728 resolves identically to mem#728", () => {
    // parseShortId normalizes the prefix, so mint-time and reference-time
    // casing cannot diverge.
    expect(links("MEM#728")).toEqual([["MEM#728", MEM_PATH]]);
  });

  test("the rendered text keeps the author's original token, not the normalized one", () => {
    // The link TEXT is what the author wrote; only the target is normalized.
    expect(links("MEM#728")[0]?.[0]).toBe("MEM#728");
  });
});

describe("short-id id-set gating (zero false positives)", () => {
  test("a well-formed short id NOT in the id-set stays plain text", () => {
    // Same discipline as an unknown `mt#N`: recognizable shape is not enough.
    expect(links("mem#999999")).toEqual([]);
    expect(plainText("mem#999999")).toBe("mem#999999");
  });

  test("short ids stay plain text when the index carries none", () => {
    expect(links("mem#728 ask#3346 ws#42", INDEX_WITHOUT_SHORT_IDS)).toEqual([]);
  });

  test("an unknown prefix is never linkified even when digits follow", () => {
    // `issue#42` / `chapter#3` are ordinary prose, not entity references.
    for (const token of ["issue#42", "chapter#3", "v#1"]) {
      expect(links(token)).toEqual([]);
      expect(plainText(token)).toBe(token);
    }
  });

  test("word-embedded short-id shapes are not matched", () => {
    // The leading `(?<![a-zA-Z0-9_])` boundary must reject a prefix that is
    // itself the tail of a longer word — and must not rescue a match by
    // retrying at a later offset inside that word.
    expect(links("filesystem#728")).toEqual([]);
    expect(plainText("filesystem#728")).toBe("filesystem#728");
  });

  test("malformed short ids are rejected by parseShortId, not linkified", () => {
    // `mem#0` is shape-valid to a naive regex but invalid to the domain
    // parser (n must be a positive integer) — the reason the shape authority
    // is the domain helper and not a second local regex.
    for (const token of ["mem#0", "mem#", "#728", "mem#5abc"]) {
      expect(links(token)).toEqual([]);
    }
  });

  test("trailing sentence punctuation is left outside the link", () => {
    expect(links(SENTENCE_WITH_MEM)).toEqual([["mem#728", MEM_PATH]]);
    expect(plainText(SENTENCE_WITH_MEM)).toBe(SENTENCE_WITH_MEM.replace("mem#728", ""));
  });
});

describe("pre-existing token classes are unaffected (ordering regression)", () => {
  // `mt#N` and `PR#N` are both `<word>#<digits>`-shaped, so the shortId
  // alternative WOULD match them if it were declared earlier in the regex.
  // These pin the ordering that keeps each on its original handler.

  test("mt#N still resolves as a task, not as a short id", () => {
    expect(links("mt#2370")).toEqual([["mt#2370", "/tasks/mt%232370"]]);
  });

  test("PR#N (no space) still resolves as a changeset", () => {
    expect(links("PR#1234")).toEqual([["PR#1234", "/changeset/1234"]]);
  });

  test("PR #N (with space) still resolves as a changeset", () => {
    expect(links("PR #1234")).toEqual([["PR #1234", "/changeset/1234"]]);
  });

  test("a uuid still resolves to its canonical path", () => {
    expect(links(MEMORY_UUID)).toEqual([[MEMORY_UUID, `/memory/${MEMORY_UUID}`]]);
  });

  test("a short id inside an https URL is consumed by the URL, not split out", () => {
    // httpsUrl is declared before shortId, so the whole URL stays plain text.
    const text = "https://example.com/x/mem#728";
    expect(links(text)).toEqual([]);
    expect(plainText(text)).toBe(text);
  });

  test("mixed prose linkifies every class in one pass, in source order", () => {
    expect(links("mt#2370 fixes mem#728, see PR #1234 and ws#42")).toEqual([
      ["mt#2370", "/tasks/mt%232370"],
      ["mem#728", MEM_PATH],
      ["PR #1234", "/changeset/1234"],
      ["ws#42", "/agents/ws%2342"],
    ]);
  });
});

describe("buildEntityIndex short-id registration", () => {
  test("indexes both id forms for the same entity", () => {
    expect(INDEX.get(MEMORY_UUID)).toBe("memory");
    expect(INDEX.get("mem#728")).toBe("memory");
  });

  test("short-id arrays are optional — omitting them changes nothing else", () => {
    expect(INDEX_WITHOUT_SHORT_IDS.get(MEMORY_UUID)).toBe("memory");
    expect(INDEX_WITHOUT_SHORT_IDS.has("mem#728")).toBe(false);
  });
});
