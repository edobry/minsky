import { describe, expect, test } from "bun:test";
import type { MemoryRecord } from "@minsky/domain/memory";
import type { Ask } from "@minsky/domain/ask/types";
import type { SessionRecord } from "@minsky/domain/session";
import {
  extractReferencedShortIdRefs,
  extractAmendmentSections,
  resolveReferencedShortIds,
  MAX_REFERENCED_SHORT_IDS,
  MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM,
  MAX_REFERENCED_SHORT_IDS_TOTAL_CHARS,
  type MemoryLookup,
  type AskLookup,
  type SessionLookup,
} from "./short-id-fetch";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMemoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "d8891fad-b156-46e1-8940-98067eb097a9",
    shortId: "mem#648",
    type: "feedback",
    name: "test memory",
    description: "a test memory",
    content: "default content",
    scope: "project",
    projectId: null,
    tags: [],
    sourceAgentId: null,
    sourceSessionId: null,
    confidence: null,
    supersededBy: null,
    metadata: null,
    associations: {},
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-11T10:00:00.000Z"),
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  } as MemoryRecord;
}

function makeAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "38b1c0de-0000-0000-0000-000000000000",
    shortId: "ask#12",
    kind: "quality.review",
    classifierVersion: "v1",
    requestor: "test:proc:abc",
    title: "should we ship this?",
    question: "should we ship this?",
    state: "closed",
    createdAt: "2026-08-10T09:00:00.000Z",
    metadata: {},
    ...overrides,
  } as Ask;
}

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "2154425b-0000-0000-0000-000000000000",
    shortId: "ws#7",
    repoName: "edobry/minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: "2026-08-01T00:00:00.000Z",
    taskId: "mt#3964",
    status: "IN-PROGRESS",
    branch: "task/mt-3964",
    ...overrides,
  } as SessionRecord;
}

// ---------------------------------------------------------------------------
// extractReferencedShortIdRefs
// ---------------------------------------------------------------------------

describe("extractReferencedShortIdRefs (mt#3964)", () => {
  test("finds a single mem#N reference", () => {
    expect(extractReferencedShortIdRefs("mem#648's CORRECTION 1 is amended")).toEqual([
      { ref: "mem#648", kind: "memory" },
    ]);
  });

  test("finds ask#N and ws#N alongside mem#N, in first-occurrence order", () => {
    expect(extractReferencedShortIdRefs("see mem#1, ask#2, and ws#3")).toEqual([
      { ref: "mem#1", kind: "memory" },
      { ref: "ask#2", kind: "ask" },
      { ref: "ws#3", kind: "workspace" },
    ]);
  });

  test("dedupes repeated references", () => {
    expect(extractReferencedShortIdRefs("mem#1 ... later, mem#1 again")).toEqual([
      { ref: "mem#1", kind: "memory" },
    ]);
  });

  test("is case-insensitive on the prefix, normalizing to lowercase", () => {
    expect(extractReferencedShortIdRefs("MEM#1 and Ask#2")).toEqual([
      { ref: "mem#1", kind: "memory" },
      { ref: "ask#2", kind: "ask" },
    ]);
  });

  test("does not match mid-word false positives (word boundary)", () => {
    expect(extractReferencedShortIdRefs("system#1 and task#2")).toEqual([]);
  });

  test("ignores an unrelated <prefix>#<n> shape like mt#NNNN (handled by task-spec-fetch.ts)", () => {
    expect(extractReferencedShortIdRefs("see mt#3919 for the parent mechanism")).toEqual([]);
  });

  test("returns [] for empty text", () => {
    expect(extractReferencedShortIdRefs("")).toEqual([]);
  });

  test("caps at MAX_REFERENCED_SHORT_IDS distinct references", () => {
    const many = Array.from(
      { length: MAX_REFERENCED_SHORT_IDS + 5 },
      (_, i) => `mem#${i + 1}`
    ).join(" ");
    expect(extractReferencedShortIdRefs(many)).toHaveLength(MAX_REFERENCED_SHORT_IDS);
  });
});

// ---------------------------------------------------------------------------
// extractAmendmentSections
// ---------------------------------------------------------------------------

describe("extractAmendmentSections (mt#3964)", () => {
  test("returns null when the body has no ## headings", () => {
    expect(extractAmendmentSections("just prose, no headings")).toBeNull();
  });

  test("returns null when headings exist but none match the amendment convention", () => {
    const body = "## Summary\n\nbody text\n\n## Context\n\nmore text";
    expect(extractAmendmentSections(body)).toBeNull();
  });

  test("extracts a single ## CORRECTION N section", () => {
    const body = "## Incident\n\nbase text\n\n## CORRECTION 1 (2026-08-01) — fixed\n\nthe fix.";
    const result = extractAmendmentSections(body);
    expect(result).toContain("## CORRECTION 1 (2026-08-01) — fixed");
    expect(result).toContain("the fix.");
    expect(result).not.toContain("base text");
  });

  test("extracts MULTIPLE ## CORRECTION N sections in order, even when a late one holds the answer", () => {
    // Regression fixture for the mt#3964 live-replay finding: mem#648 is
    // ~7.6KB with the relevant section (CORRECTION 3) near the END — a
    // head-truncating cap alone would never reach it.
    const body =
      `## Incident\n\n${"x".repeat(
        5_000
      )}\n\n## CORRECTION 1 (2026-08-01) — first\n\nfirst fix.\n\n` +
      `## CORRECTION 3 (2026-08-04) — the answer\n\nthe late answer.`;
    const result = extractAmendmentSections(body);
    expect(result).not.toBeNull();
    expect(result).toContain("## CORRECTION 1 (2026-08-01) — first");
    expect(result).toContain("## CORRECTION 3 (2026-08-04) — the answer");
    expect(result).toContain("the late answer.");
    expect(result?.length).toBeLessThan(1_000); // the 5,000-char filler is excluded
  });

  test("matches AMENDED and Update headings too, case-insensitively", () => {
    const body = "## amended 2026-08-01\n\nchange A.\n\n## Update: scope\n\nchange B.";
    const result = extractAmendmentSections(body);
    expect(result).toContain("change A.");
    expect(result).toContain("change B.");
  });
});

// ---------------------------------------------------------------------------
// resolveReferencedShortIds
// ---------------------------------------------------------------------------

describe("resolveReferencedShortIds (mt#3964)", () => {
  const CRITERIA_TEXT =
    "## Success Criteria\n\n- [ ] mem#648's CORRECTION 1 is amended: the ask-then-grant " +
    "path stays correct, but is no longer the FIRST move for a verified false positive.";

  test("returns [] when taskSpec is null", async () => {
    const results = await resolveReferencedShortIds({ taskSpec: null });
    expect(results).toEqual([]);
  });

  test("returns [] when taskSpec has no short-id references", async () => {
    const results = await resolveReferencedShortIds({
      taskSpec: "## Success Criteria\n\n- [ ] no references here.",
    });
    expect(results).toEqual([]);
  });

  test("returns a `disabled` entry when the relevant lookup is absent — the model still SEES the reference", async () => {
    const results = await resolveReferencedShortIds({ taskSpec: CRITERIA_TEXT });
    expect(results).toHaveLength(1);
    expect(results[0]?.ref).toBe("mem#648");
    expect(results[0]?.kind).toBe("memory");
    expect(results[0]?.content).toBeNull();
    expect(results[0]?.fetchResult.status).toBe("disabled");
  });

  // -------------------------------------------------------------------------
  // Positive case: mt#3729 criterion 4 replay — mem#648 carrying the amendment.
  // -------------------------------------------------------------------------
  test("positive case: mem#648 carrying the amendment resolves to `found` with the amended content", async () => {
    const record = makeMemoryRecord({
      content:
        "CORRECTION 1 is amended: the ask-then-grant path stays correct, but is no longer " +
        "the FIRST move for a verified false positive.",
      updatedAt: new Date("2026-08-11T10:00:00.000Z"),
    });
    const memoryLookup: MemoryLookup = { get: async (id) => (id === "mem#648" ? record : null) };

    const results = await resolveReferencedShortIds({ taskSpec: CRITERIA_TEXT, memoryLookup });

    expect(results).toHaveLength(1);
    expect(results[0]?.fetchResult.status).toBe("found");
    expect(results[0]?.content).toContain("no longer the FIRST move");
    expect(results[0]?.updatedAt).toBe("2026-08-11T10:00:00.000Z");
    expect(results[0]?.truncated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Negative control (mandatory per spec): a mem#N criterion whose target
  // memory does NOT carry the change must still be reported — the met and
  // unmet cases must render DIFFERENT content, never identically.
  // -------------------------------------------------------------------------
  test("negative control: mem#648 NOT carrying the amendment resolves to `found` with the unamended content", async () => {
    const record = makeMemoryRecord({
      content: "CORRECTION 1 stands unamended — the ask-then-grant path is still the first move.",
      updatedAt: new Date("2026-08-05T09:00:00.000Z"),
    });
    const memoryLookup: MemoryLookup = { get: async () => record };

    const results = await resolveReferencedShortIds({ taskSpec: CRITERIA_TEXT, memoryLookup });

    expect(results).toHaveLength(1);
    expect(results[0]?.fetchResult.status).toBe("found");
    expect(results[0]?.content).toContain("stands unamended");
    expect(results[0]?.content).not.toContain("no longer the FIRST move");
  });

  test("not-found: a nonexistent mem#N id resolves to `not-found`, content null, never Met (never silently dropped)", async () => {
    const memoryLookup: MemoryLookup = { get: async () => null };
    const results = await resolveReferencedShortIds({
      taskSpec: "- [ ] mem#999999 carries the change.",
      memoryLookup,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.ref).toBe("mem#999999");
    expect(results[0]?.content).toBeNull();
    expect(results[0]?.fetchResult.status).toBe("not-found");
    expect(results[0]?.fetchResult.ref).toBe("mem#999999");
  });

  test("ambiguous: a session lookup throwing an 'Ambiguous ...' error resolves to `ambiguous`, distinct from a plain error", async () => {
    const sessionLookup: SessionLookup = {
      getSession: async () => {
        throw new Error('Ambiguous workspace id prefix "ws#5" matches 2 record(s)');
      },
    };
    const results = await resolveReferencedShortIds({
      taskSpec: "- [ ] ws#5 is in the expected state.",
      sessionLookup,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.fetchResult.status).toBe("ambiguous");
    expect(results[0]?.fetchResult.error).toContain("Ambiguous");
  });

  test("transport error: a lookup throwing a non-ambiguous error resolves to `error` with the message named", async () => {
    const askLookup: AskLookup = {
      getById: async () => {
        throw new Error("Database connection failed");
      },
    };
    const results = await resolveReferencedShortIds({
      taskSpec: "- [ ] ask#12 was closed favorably.",
      askLookup,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.fetchResult.status).toBe("error");
    expect(results[0]?.fetchResult.error).toBe("Database connection failed");
  });

  test("renders an ask's question + state + response", async () => {
    const ask = makeAsk({
      response: {
        responder: "operator",
        payload: { approved: true },
      },
    });
    const askLookup: AskLookup = { getById: async () => ask };
    const results = await resolveReferencedShortIds({
      taskSpec: "- [ ] ask#12 was resolved.",
      askLookup,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("should we ship this?");
    expect(results[0]?.content).toContain("closed");
    expect(results[0]?.content).toContain("approved");
  });

  test("renders a session/workspace record's status summary", async () => {
    const sessionLookup: SessionLookup = { getSession: async () => makeSessionRecord() };
    const results = await resolveReferencedShortIds({
      taskSpec: "- [ ] ws#7 is IN-PROGRESS.",
      sessionLookup,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("mt#3964");
    expect(results[0]?.content).toContain("IN-PROGRESS");
    expect(results[0]?.content).toContain("task/mt-3964");
  });

  test("section-targeted extraction (end-to-end): a large memory with a late CORRECTION section resolves WITHOUT losing it to head-truncation", async () => {
    const body = `## Incident\n\n${
      "x".repeat(MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM) // filler alone exceeds the cap
    }\n\n## CORRECTION 3 (2026-08-04) — the answer\n\nthe late answer that matters.`;
    const memoryLookup: MemoryLookup = { get: async () => makeMemoryRecord({ content: body }) };
    const results = await resolveReferencedShortIds({
      taskSpec: "- [ ] mem#648's correction is applied.",
      memoryLookup,
    });

    expect(results).toHaveLength(1);
    // Without section-targeting, the filler alone would exhaust the per-item
    // cap and cut the answer entirely — asserting it IS present, un-truncated,
    // pins that the extraction ran before the cap, not after.
    expect(results[0]?.content).toContain("the late answer that matters.");
    expect(results[0]?.truncated).toBe(false);
  });

  test("truncates content exceeding the per-item cap and reports omittedChars", async () => {
    const longContent = "x".repeat(MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM + 500);
    const memoryLookup: MemoryLookup = {
      get: async () => makeMemoryRecord({ content: longContent }),
    };
    const results = await resolveReferencedShortIds({
      taskSpec: "- [ ] mem#648 carries a large body.",
      memoryLookup,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.truncated).toBe(true);
    expect(results[0]?.content?.length).toBe(MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM);
    expect(results[0]?.omittedChars).toBe(500);
  });

  test("omits content entirely once the TOTAL budget is exhausted by earlier references", async () => {
    // Each of the first three references is at/over the PER-ITEM cap (so each
    // consumes the full MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM), together
    // exactly exhausting the TOTAL budget (3 * per-item cap == total budget).
    // The fourth reference must then be OMITTED entirely (content: null,
    // truncated: true) — never silently truncated to a sliver.
    expect(MAX_REFERENCED_SHORT_IDS_TOTAL_CHARS).toBe(3 * MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM);
    const bigBody = "y".repeat(MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM);
    const memoryLookup: MemoryLookup = {
      get: async (id) =>
        id === "mem#4"
          ? makeMemoryRecord({ content: "small fourth body" })
          : makeMemoryRecord({ content: bigBody }),
    };
    const results = await resolveReferencedShortIds({
      taskSpec: "- [ ] mem#1, mem#2, mem#3, and mem#4 all carry the change.",
      memoryLookup,
    });

    expect(results).toHaveLength(4);
    const fourth = results.find((r) => r.ref === "mem#4");
    for (const ref of ["mem#1", "mem#2", "mem#3"]) {
      expect(results.find((r) => r.ref === ref)?.content).not.toBeNull();
    }
    expect(fourth?.content).toBeNull();
    expect(fourth?.truncated).toBe(true);
    expect(fourth?.fetchResult.status).toBe("found");
    expect(fourth?.omittedChars).toBeGreaterThan(0);
  });
});
