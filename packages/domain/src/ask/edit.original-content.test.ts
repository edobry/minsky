/**
 * mt#4329 — an edit preserves the content the Ask was ESCALATED with.
 *
 * `editHistory` (mt#2668) records which fields an edit touched and not what they
 * said, so the text actually put in front of the principal was unrecoverable
 * once corrected in place. The sibling suite `edit.test.ts` covers the note
 * itself; this covers the value retention beside it.
 *
 * The distinction these tests exist to pin is ORIGINAL vs PREVIOUS. A record
 * that keeps the previous revision is easy to write and satisfies a naive
 * "history is retained" reading — and it loses the escalated text on the second
 * edit, which is precisely the case that motivated the task (ask#9278 was edited
 * TWICE). AT2 is the one that discriminates.
 */

import { describe, expect, test } from "bun:test";

import {
  editAskContent,
  EDIT_HISTORY_METADATA_KEY,
  ORIGINAL_CONTENT_METADATA_KEY,
  type AskOriginalContent,
} from "./edit";
import { FakeAskRepository } from "./repository";
import type { Ask } from "./types";

const ESCALATED_QUESTION =
  "May I run `pg_terminate_backend` on the ~10 wedged Supavisor backends? " +
  "They block on `ClientRead`, so statement timeouts will not reap them; " +
  "already held ~14 min with no sign of clearing.";
const ESCALATED_TITLE = "minsky-reviewer is DOWN (502) — may I terminate the wedged connections?";

const FIRST_CORRECTION = "**RESOLVED at 03:26Z — no action needed from you.**";
/** The seeded ask's only contextRef, asserted in two places. */
const SEED_CONTEXT_REF = {
  kind: "task",
  ref: "mt#4190",
  description: "the session that found it",
} as const;
const SECOND_CORRECTION = "**RESOLVED. Root cause is mt#4294, already owned and claimed.**";

async function seedEscalatedAsk(repo: FakeAskRepository): Promise<Ask> {
  return repo.create({
    kind: "authorization.approve",
    classifierVersion: "v1.0.0",
    requestor: "minsky.agent:test",
    title: ESCALATED_TITLE,
    question: ESCALATED_QUESTION,
    options: [{ label: "Terminate them", value: "approve" }],
    contextRefs: [SEED_CONTEXT_REF],
    metadata: { severity: "incident" },
  });
}

/** The captured original, or undefined when nothing has been captured. */
function originalOf(ask: Ask): AskOriginalContent | undefined {
  const raw = ask.metadata[ORIGINAL_CONTENT_METADATA_KEY];
  return typeof raw === "object" && raw !== null ? (raw as AskOriginalContent) : undefined;
}

describe("AT1 — the escalated text survives an edit and is retrievable", () => {
  test("the original question is returned by the read surface, byte for byte", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    const { ask } = await editAskContent(repo, {
      id: seeded.id,
      question: FIRST_CORRECTION,
      editor: "agent (test)",
    });

    expect(ask.question).toBe(FIRST_CORRECTION);
    expect(originalOf(ask)?.question).toBe(ESCALATED_QUESTION);
  });

  test("it comes back through a fresh read, not just the write's return value", async () => {
    // The write path could return a correctly-shaped object without persisting
    // it; SC2 is about what a LATER reader can retrieve.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);
    await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });

    const reread = await repo.getById(seeded.id);
    expect(reread).not.toBeNull();
    expect(originalOf(reread as Ask)?.question).toBe(ESCALATED_QUESTION);
  });

  test("capturedAt is recorded", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);
    const { ask } = await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });

    expect(typeof originalOf(ask)?.capturedAt).toBe("string");
    expect(Number.isNaN(Date.parse(originalOf(ask)?.capturedAt ?? ""))).toBe(false);
  });
});

describe("AT2 — a SECOND edit does not displace the original", () => {
  test("after two edits the retained question is the ESCALATED one, not the first correction", async () => {
    // The discriminating case. A "keep the previous revision" implementation
    // passes AT1 and fails here, returning FIRST_CORRECTION — and ask#9278, the
    // record that motivated this task, was edited exactly twice.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });
    const { ask } = await editAskContent(repo, { id: seeded.id, question: SECOND_CORRECTION });

    expect(ask.question).toBe(SECOND_CORRECTION);
    expect(originalOf(ask)?.question).toBe(ESCALATED_QUESTION);
    expect(originalOf(ask)?.question).not.toBe(FIRST_CORRECTION);
  });

  test("capturedAt does not move on the second edit", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    const first = await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });
    const capturedAt = originalOf(first.ask)?.capturedAt;
    // Asserted before it is used as the expectation: comparing two undefineds
    // would pass while proving nothing.
    expect(capturedAt).toBeDefined();
    const second = await editAskContent(repo, { id: seeded.id, question: SECOND_CORRECTION });

    expect(originalOf(second.ask)?.capturedAt).toBe(capturedAt as string);
  });

  test("growth is bounded — one copy per field, not one per edit", async () => {
    // The size property SC3 turns on. `editHistory` grows per edit by design;
    // the captured original must not.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    await editAskContent(repo, { id: seeded.id, question: "edit 1" });
    await editAskContent(repo, { id: seeded.id, question: "edit 2" });
    const { ask } = await editAskContent(repo, { id: seeded.id, question: "edit 3" });

    const history = ask.metadata[EDIT_HISTORY_METADATA_KEY];
    expect(Array.isArray(history) ? history.length : 0).toBe(3);
    // One question, not three.
    expect(Object.keys(originalOf(ask) ?? {}).sort()).toEqual(["capturedAt", "question"]);
  });
});

describe("per-field capture", () => {
  test("a field is captured when IT is first edited, not when the record is", async () => {
    // An edit touching only `title` must not foreclose capturing the original
    // question a later edit replaces.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    await editAskContent(repo, { id: seeded.id, title: "retitled" });
    const afterTitle = await repo.getById(seeded.id);
    expect(originalOf(afterTitle as Ask)?.title).toBe(ESCALATED_TITLE);
    expect(originalOf(afterTitle as Ask)?.question).toBeUndefined();

    const { ask } = await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });
    expect(originalOf(ask)?.title).toBe(ESCALATED_TITLE);
    expect(originalOf(ask)?.question).toBe(ESCALATED_QUESTION);
  });

  test("an untouched field is never captured", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);
    const { ask } = await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });

    expect(originalOf(ask)?.title).toBeUndefined();
    expect(originalOf(ask)?.options).toBeUndefined();
    expect(originalOf(ask)?.contextRefs).toBeUndefined();
  });

  test("options and contextRefs are captured too, since both are replaced wholesale", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    const { ask } = await editAskContent(repo, {
      id: seeded.id,
      options: [{ label: "Withdrawn", value: "deny" }],
      contextRefs: [],
    });

    expect(originalOf(ask)?.options).toEqual([{ label: "Terminate them", value: "approve" }]);
    expect(originalOf(ask)?.contextRefs).toEqual([SEED_CONTEXT_REF]);
  });
});

describe("AT3 — an unedited ask carries nothing, and is distinguishable", () => {
  test("a freshly created ask has no captured original", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    expect(originalOf(seeded)).toBeUndefined();
    expect(seeded.metadata[EDIT_HISTORY_METADATA_KEY]).toBeUndefined();
  });

  test("liveness: the same ask DOES carry one once edited", async () => {
    // Without this, "unedited asks carry nothing" would pass against an
    // implementation that never captures anything at all.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);
    const { ask } = await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });

    expect(originalOf(ask)).toBeDefined();
  });
});

describe("the capture is not caller-controlled", () => {
  test("caller-supplied originalContent is ignored in favour of the real prior value", async () => {
    // A mutable original is not an original. Same reservation the editHistory
    // note already has.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    const { ask } = await editAskContent(repo, {
      id: seeded.id,
      question: FIRST_CORRECTION,
      metadata: {
        [ORIGINAL_CONTENT_METADATA_KEY]: { capturedAt: "1999-01-01T00:00:00.000Z", question: "no" },
      },
    });

    expect(originalOf(ask)?.question).toBe(ESCALATED_QUESTION);
  });

  test("unrelated metadata still shallow-merges", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    const { ask } = await editAskContent(repo, {
      id: seeded.id,
      question: FIRST_CORRECTION,
      metadata: { note: "kept" },
    });

    expect(ask.metadata.note).toBe("kept");
    expect(ask.metadata.severity).toBe("incident");
  });
});

describe("AT4 — the ask#9278 shape, replayed", () => {
  test("two edits into a RESOLVED notice, and the escalated question is still there", async () => {
    // The real record: edited 03:27:00Z and 03:29:18Z, both touching title,
    // question and contextRefs together. Pre-fix, the escalated text was gone
    // and only the harness transcript still held it.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    await editAskContent(repo, {
      id: seeded.id,
      title: "RESOLVED — reviewer restored by redeploy",
      question: FIRST_CORRECTION,
      contextRefs: [{ kind: "task", ref: "mt#3030", description: "boot CREATE SCHEMA" }],
      editor: "agent (mt#4190 session)",
    });
    const { ask } = await editAskContent(repo, {
      id: seeded.id,
      title: "RESOLVED — root cause is mt#4294",
      question: SECOND_CORRECTION,
      contextRefs: [{ kind: "task", ref: "mt#4294", description: "root cause" }],
      editor: "agent (mt#4190 session)",
    });

    const original = originalOf(ask);
    expect(original?.question).toBe(ESCALATED_QUESTION);
    expect(original?.title).toBe(ESCALATED_TITLE);
    expect(original?.contextRefs).toEqual([SEED_CONTEXT_REF]);

    // And the provenance note still records both edits, unchanged.
    const history = ask.metadata[EDIT_HISTORY_METADATA_KEY];
    expect(Array.isArray(history) ? history.length : 0).toBe(2);
  });
});
