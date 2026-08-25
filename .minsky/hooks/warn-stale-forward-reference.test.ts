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
  MERGE_TOOL,
  TRIGGER_STATUS,
  resolveTrigger,
  toEventPhase,
  type CorpusDoc,
} from "./warn-stale-forward-reference";
import { deriveHookRepoRoot } from "./types";
// The SC4 registration test below asserts the hook is wired in the REAL
// settings.json. Injecting a mock fs would assert a fixture, and asserting a
// fixture instead of reality is precisely how mt#4535 shipped an unreachable
// hook with a fully green suite. Hermeticity is the wrong property here.
// eslint-disable-next-line custom/no-real-fs-in-tests
import { readFileSync } from "fs";
import { join } from "path";

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

  test("also targets the merge tool — the seam where DONE is actually written", () => {
    expect(MERGE_TOOL).toBe("mcp__minsky__session_pr_merge");
  });
});

describe("resolveTrigger (mt#4545) — the reachability half", () => {
  const MERGE_OK = { success: true };

  test("fires on a SUCCESSFUL merge, as PostToolUse", () => {
    const t = resolveTrigger(MERGE_TOOL, { task: TASK_ID }, MERGE_OK, TASK_ID, "PostToolUse");
    expect(t.taskId).toBe(TASK_ID);
    expect(t.event).toBe("PostToolUse");
  });

  test("does NOT fire on a failed merge — a failed merge is not a DONE transition", () => {
    const t = resolveTrigger(
      MERGE_TOOL,
      { task: TASK_ID },
      { success: false },
      TASK_ID,
      "PostToolUse"
    );
    expect(t.taskId).toBeNull();
  });

  test("does not fire on a merge whose task could not be resolved", () => {
    const t = resolveTrigger(MERGE_TOOL, {}, MERGE_OK, null, "PostToolUse");
    expect(t.taskId).toBeNull();
  });

  test("still fires on an EXPLICIT status_set to DONE, as PreToolUse (SC2)", () => {
    const t = resolveTrigger(
      TARGET_TOOL,
      { taskId: TASK_ID, status: "DONE" },
      undefined,
      null,
      "PreToolUse"
    );
    expect(t.taskId).toBe(TASK_ID);
    expect(t.event).toBe("PreToolUse");
  });

  test("does not fire on a non-DONE status_set", () => {
    const t = resolveTrigger(
      TARGET_TOOL,
      { taskId: TASK_ID, status: "READY" },
      undefined,
      null,
      "PreToolUse"
    );
    expect(t.taskId).toBeNull();
  });

  test("does not fire on an unrelated tool", () => {
    const t = resolveTrigger(
      "mcp__minsky__tasks_get",
      { taskId: TASK_ID },
      MERGE_OK,
      TASK_ID,
      "PostToolUse"
    );
    expect(t.taskId).toBeNull();
  });

  test("PR #3316 R1: an unmatched tool reports its REAL phase, not a hardcoded default", () => {
    // The PostToolUse block's matcher is
    // `mcp__minsky__session_pr_merge|mcp__github__merge_pull_request`, so the
    // bypass-merge tool DOES reach the default branch. It must not fire, and it
    // must not log a PostToolUse invocation as PreToolUse — that would corrupt
    // the fire-log this task relies on as its coverage receipt.
    const t = resolveTrigger(
      "mcp__github__merge_pull_request",
      { pullNumber: 1 },
      MERGE_OK,
      null,
      "PostToolUse"
    );
    expect(t.taskId).toBeNull();
    expect(t.event).toBe("PostToolUse");
  });

  test("toEventPhase narrows the harness field, defaulting to PreToolUse", () => {
    expect(toEventPhase("PostToolUse")).toBe("PostToolUse");
    expect(toEventPhase("PreToolUse")).toBe("PreToolUse");
    expect(toEventPhase(undefined)).toBe("PreToolUse");
    expect(toEventPhase("SomethingElse")).toBe("PreToolUse");
  });

  test("NEGATIVE CONTROL: the pre-fix trigger was blind to the merge surface", () => {
    // mt#4535's trigger, replayed verbatim as a predicate over the same inputs.
    // Written as a function taking `string` so this is a real evaluation, not a
    // literal-type comparison the compiler folds to a constant — the first
    // version of this control WAS that, and typecheck (TS2367) rejected it.
    const preFixTrigger = (toolName: string, ti: Record<string, unknown>): boolean =>
      toolName === TARGET_TOOL &&
      Boolean((ti["taskId"] as string | undefined)?.trim()) &&
      (ti["status"] as string | undefined)?.trim() === TRIGGER_STATUS;

    // A successful merge — the path that carries essentially every DONE
    // transition. The old trigger yields nothing on it, which is why the shipped
    // hook logged one record with `guardOutcome` unset and never evaluated.
    expect(preFixTrigger(MERGE_TOOL, { task: TASK_ID })).toBe(false);

    // Control that the predicate CAN fire, so the assertion above is not vacuous.
    expect(preFixTrigger(TARGET_TOOL, { taskId: TASK_ID, status: TRIGGER_STATUS })).toBe(true);

    // And the fixed trigger fires on the merge input the old one missed.
    expect(
      resolveTrigger(MERGE_TOOL, { task: TASK_ID }, MERGE_OK, TASK_ID, "PostToolUse").taskId
    ).toBe(TASK_ID);
  });
});

describe("registration reachability (SC4)", () => {
  test("settings.json registers this hook on BOTH surfaces", () => {
    // The check mt#4535 lacked. Its tests all exercised the pure matcher, which
    // was correct — nothing asserted the hook was wired where the event occurs.
    // Reading the REAL registration is the assertion; a mock would make this
    // test vacuous.
    // eslint-disable-next-line custom/no-real-fs-in-tests
    const settings = readFileSync(join(deriveHookRepoRoot(), ".claude/settings.json"), "utf8");
    const parsed = JSON.parse(settings) as {
      hooks: Record<string, { matcher?: string; hooks: { command?: string }[] }[]>;
    };

    const surfacesFor = (event: string): string[] =>
      (parsed.hooks[event] ?? [])
        .filter((b) => b.hooks.some((h) => h.command?.includes("warn-stale-forward-reference")))
        .map((b) => b.matcher ?? "");

    expect(surfacesFor("PreToolUse").join(" ")).toContain(TARGET_TOOL);
    expect(surfacesFor("PostToolUse").join(" ")).toContain(MERGE_TOOL);
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
