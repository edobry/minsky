import { describe, expect, test } from "bun:test";
import {
  CORPUS_ROOTS,
  extractTitleTokens,
  findForwardReferences,
  decideStaleForwardReference,
  readCorpus,
  FORWARD_MARKERS,
  MIN_TITLE_TOKEN_HITS,
  MAX_RENDERED_HITS,
  TARGET_TOOL,
  TRIGGER_STATUS,
  type CorpusDoc,
} from "./warn-stale-forward-reference";
import { deriveHookRepoRoot } from "./types";

/** Hoisted so repeated literals do not trip `custom/no-magic-string-duplication`. */
const ADR_FILE = "docs/architecture/adr-006-agent-identity.md";
const TASK_ID = "mt#3900";

/**
 * The ACTUAL text of ADR-006's Layer 3 Known-limitation paragraph, as it read
 * before mt#4535's amendment. This is the originating instance: it names NO
 * task id, which is why the id-only mechanism this hook rejected would have
 * missed it entirely.
 */
const ADR006_KNOWN_LIMITATION =
  "handled; forgery not). Known limitation: the env value is fixed at proxy spawn, so an\n" +
  "in-process conversation switch (`/clear`, in-process resume) attributes calls to the pre-switch\n" +
  "conversation until the next reconnect respawns the proxy; upgrade path if that bites is a\n" +
  "SessionStart hook writing a `<claude-pid> → sessionId` mapping the proxy re-reads per request.";

/** mt#3900's real title — the only description of the deliverable available at transition time. */
const MT3900_TITLE =
  "Proxy attributes MCP calls to the pre-/clear conversation: implement ADR-006's " +
  "pid→conversation mapping so identity survives an in-process switch";

function doc(text: string, file = ADR_FILE): CorpusDoc {
  return { file, text };
}

describe("trigger surface", () => {
  test("targets the status-set tool and the DONE transition only", () => {
    expect(TARGET_TOOL).toBe("mcp__minsky__tasks_status_set");
    expect(TRIGGER_STATUS).toBe("DONE");
  });
});

describe("extractTitleTokens", () => {
  test("keeps distinctive tokens and drops stopwords and short words", () => {
    const tokens = extractTitleTokens(MT3900_TITLE);
    expect(tokens).toContain("mapping");
    expect(tokens).toContain("conversation");
    expect(tokens).toContain("proxy");
    // Stopword and lifecycle vocabulary — these are what make a title matcher
    // fire on everything, so they must not survive.
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("implement");
    // Under the 4-char floor.
    expect(tokens).not.toContain("mcp");
  });

  test("returns no duplicates", () => {
    const tokens = extractTitleTokens("mapping mapping MAPPING conversation");
    expect(tokens.filter((t) => t === "mapping")).toHaveLength(1);
  });
});

describe("findForwardReferences — the originating instance (AT1)", () => {
  test("catches ADR-006's Known-limitation paragraph via the DESCRIPTION path", () => {
    const hits = findForwardReferences(TASK_ID, extractTitleTokens(MT3900_TITLE), [
      doc(ADR006_KNOWN_LIMITATION),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe(ADR_FILE);
    expect(hits[0]?.marker).toBe("upgrade path");
    // The whole point: this paragraph names no task id.
    expect(hits[0]?.via).toBe("description");
    expect(ADR006_KNOWN_LIMITATION).not.toContain(TASK_ID);
  });

  test("NEGATIVE CONTROL: an id-only matcher finds nothing in that same paragraph", () => {
    // Passing NO title tokens reduces the mechanism to the id path — the design
    // this hook rejected. It must return zero on the originating instance, which
    // is what makes the description path load-bearing rather than decorative.
    const idOnly = findForwardReferences(TASK_ID, [], [doc(ADR006_KNOWN_LIMITATION)]);
    expect(idOnly).toHaveLength(0);
  });
});

describe("findForwardReferences — matching rules", () => {
  test("matches via id when the paragraph names the task", () => {
    const hits = findForwardReferences(
      TASK_ID,
      [],
      [doc(`The ${TASK_ID} work is deferred until the pooler decision lands.`)]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.via).toBe("id");
    expect(hits[0]?.marker).toBe("deferred");
  });

  test("a forward marker alone does not fire", () => {
    const hits = findForwardReferences(TASK_ID, extractTitleTokens(MT3900_TITLE), [
      doc("This is deferred, and concerns something else entirely."),
    ]);
    expect(hits).toHaveLength(0);
  });

  test("a task reference alone does not fire — the prose must be forward-looking", () => {
    const hits = findForwardReferences(
      TASK_ID,
      [],
      [doc(`${TASK_ID} shipped the mapping and it is live in production.`)]
    );
    expect(hits).toHaveLength(0);
  });

  test(`requires ${MIN_TITLE_TOKEN_HITS} distinct title tokens on the description path`, () => {
    // One token + a marker must NOT fire, or every rule mentioning "conversation"
    // becomes a hit.
    const one = findForwardReferences(TASK_ID, extractTitleTokens(MT3900_TITLE), [
      doc("The conversation model is still open, deferred to a later phase."),
    ]);
    expect(one).toHaveLength(0);

    const two = findForwardReferences(TASK_ID, extractTitleTokens(MT3900_TITLE), [
      doc("The conversation mapping is still open, deferred to a later phase."),
    ]);
    expect(two).toHaveLength(1);
  });

  test("is case-insensitive on both halves", () => {
    const hits = findForwardReferences(
      "MT#3900",
      [],
      [doc("Upgrade Path: mt#3900 has not landed.")]
    );
    expect(hits).toHaveLength(1);
  });

  test("reports the paragraph's starting line, not the file's", () => {
    const text = ["# Title", "", "intro para", "", "upgrade path for mt#3900 is open"].join("\n");
    const hits = findForwardReferences(TASK_ID, [], [doc(text)]);
    expect(hits).toHaveLength(1);
    // 0-indexed position 4 -> 1-indexed line 5.
    expect(hits[0]?.line).toBe(5);
  });

  test("scans every doc in the corpus", () => {
    const hits = findForwardReferences(
      TASK_ID,
      [],
      [
        doc(`upgrade path: ${TASK_ID}`, "docs/architecture/adr-001-a.md"),
        doc(`deferred: ${TASK_ID}`, ".minsky/rules/b.mdc"),
      ]
    );
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.file)).toEqual([
      "docs/architecture/adr-001-a.md",
      ".minsky/rules/b.mdc",
    ]);
  });
});

describe("decideStaleForwardReference", () => {
  test("does not fire on an empty hit set, and records that it decided", () => {
    const d = decideStaleForwardReference(TASK_ID, []);
    expect(d.fired).toBe(false);
    expect(d.outcome).toBe("decided");
    expect(d.message).toBeUndefined();
  });

  test("renders the file, line and excerpt — a path alone is not an answer", () => {
    const d = decideStaleForwardReference(TASK_ID, [
      {
        file: ADR_FILE,
        line: 74,
        marker: "upgrade path",
        via: "description",
        excerpt: "the env value is fixed at proxy spawn",
      },
    ]);
    expect(d.fired).toBe(true);
    expect(d.message).toContain(ADR_FILE);
    expect(d.message).toContain("74");
    expect(d.message).toContain("the env value is fixed at proxy spawn");
    // The reader must be able to tell a heuristic match from an exact one.
    expect(d.message).toContain("description");
  });

  test(`caps rendered hits at ${MAX_RENDERED_HITS} and says how many were elided`, () => {
    const many = Array.from({ length: MAX_RENDERED_HITS + 3 }, (_, i) => ({
      file: `docs/architecture/adr-0${i}.md`,
      line: i + 1,
      marker: "deferred",
      via: "id" as const,
      excerpt: `hit ${i}`,
    }));
    const d = decideStaleForwardReference(TASK_ID, many);
    expect(d.message).toContain("and 3 more not shown");
    expect(d.message).not.toContain(`hit ${MAX_RENDERED_HITS + 1}`);
  });
});

describe("corpus", () => {
  test("covers the decision records and the rule corpus, and not task specs", () => {
    const dirs = CORPUS_ROOTS.map((r) => r.dir);
    expect(dirs).toContain("docs/architecture");
    expect(dirs).toContain(".minsky/rules");
  });

  test("only ADR files are read from docs/architecture", () => {
    const adrRoot = CORPUS_ROOTS.find((r) => r.dir === "docs/architecture");
    expect(adrRoot?.match.test("adr-006-agent-identity.md")).toBe(true);
    expect(adrRoot?.match.test("hook-module-inventory.md")).toBe(false);
  });

  test("reads the real repo corpus and finds a non-trivial number of documents", () => {
    // Guards against the silent-empty failure: a corpus read that returns []
    // makes every scan report "no stale references", which is indistinguishable
    // from a clean result (mem#704 — a probe that cannot fail carries no
    // information).
    const docs = readCorpus(deriveHookRepoRoot());
    expect(docs.length).toBeGreaterThan(50);
    expect(docs.some((d) => d.file === ADR_FILE)).toBe(true);
  });
});

describe("FORWARD_MARKERS", () => {
  test("are all lowercase — the scanner lowercases the haystack, not the needles", () => {
    for (const m of FORWARD_MARKERS) {
      expect(m).toBe(m.toLowerCase());
    }
  });
});
