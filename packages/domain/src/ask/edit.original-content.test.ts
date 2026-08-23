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

/**
 * Create an ask carrying caller-supplied metadata — the create-side reservation
 * is the only thing these cases vary, so the rest of the input is shared.
 */
async function createWithMetadata(
  repo: FakeAskRepository,
  metadata: Record<string, unknown>
): Promise<Ask> {
  return repo.create({
    kind: "authorization.approve",
    classifierVersion: "v1.0.0",
    requestor: "minsky.agent:test",
    title: ESCALATED_TITLE,
    question: ESCALATED_QUESTION,
    metadata,
  });
}

/** A fabricated provenance note, as a caller might plant one at create time. */
const PLANTED_NOTE = { editedAt: "1999-01-01T00:00:00.000Z", editor: "x", fields: ["question"] };
/** A fabricated capture, likewise. */
const PLANTED_ORIGINAL = { capturedAt: "1999-01-01T00:00:00.000Z", question: "planted" };

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

describe("PR #3162 R1 — the reservation holds at the CREATE boundary too", () => {
  test("a planted originalContent does not survive create", async () => {
    // `metadata` is caller-supplied at create, so defending the key only at the
    // edit boundary leaves it plantable. This is the same rule
    // `principalPagedAt` already follows (mt#3595).
    const repo = new FakeAskRepository();
    const seeded = await createWithMetadata(repo, {
      keepMe: "yes",
      [ORIGINAL_CONTENT_METADATA_KEY]: PLANTED_ORIGINAL,
    });

    expect(originalOf(seeded)).toBeUndefined();
    expect(seeded.metadata.keepMe).toBe("yes"); // unrelated keys survive
  });

  test("a planted editHistory does not survive create either", async () => {
    const repo = new FakeAskRepository();
    const seeded = await createWithMetadata(repo, {
      [EDIT_HISTORY_METADATA_KEY]: [PLANTED_NOTE],
    });

    expect(seeded.metadata[EDIT_HISTORY_METADATA_KEY]).toBeUndefined();
  });

  test("planting BOTH keys still does not defeat the capture", async () => {
    // The bypass found while fixing R1's first finding: the edit-side guard
    // trusts a stored capture when `editHistory` is non-empty, so planting a
    // fake history ALONGSIDE a fake original would have re-opened the hole.
    // Stripping at create is what closes it — this asserts the pair, not just
    // the single key.
    const repo = new FakeAskRepository();
    const seeded = await createWithMetadata(repo, {
      [EDIT_HISTORY_METADATA_KEY]: [PLANTED_NOTE],
      [ORIGINAL_CONTENT_METADATA_KEY]: PLANTED_ORIGINAL,
    });

    const { ask } = await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });

    expect(originalOf(ask)?.question).toBe(ESCALATED_QUESTION);
    expect(originalOf(ask)?.question).not.toBe(PLANTED_ORIGINAL.question);
  });
});

describe("PR #3162 R1 — the edit-side guard still matters for rows that PREDATE the strip", () => {
  test("a row already carrying a planted original does not defeat the capture", async () => {
    // Create-side stripping is not retroactive: a row persisted before this
    // shipped can already carry the key, and no later change cleans it. This is
    // the same case `sanitizeMetadata`'s docblock names for its own two-sided
    // application — "a hostile key already persisted at create time is scrubbed
    // on the way through, not just blocked at the boundary".
    //
    // Seeded through `_seedAtState` rather than `create`, precisely because
    // `create` now strips it — which is why the guard reads as redundant if you
    // only test through the create path. It is not.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);
    repo._seedAtState({
      ...seeded,
      metadata: {
        ...seeded.metadata,
        [ORIGINAL_CONTENT_METADATA_KEY]: {
          capturedAt: "1999-01-01T00:00:00.000Z",
          question: "planted-before-the-fix",
        },
      },
    });

    const { ask } = await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });

    expect(originalOf(ask)?.question).toBe(ESCALATED_QUESTION);
    expect(originalOf(ask)?.question).not.toBe("planted-before-the-fix");
  });

  test("but a genuine prior capture IS still honoured", async () => {
    // The guard keys on a non-empty editHistory, so it must not discard a real
    // capture written by an earlier edit. Without this, "ignore what is stored"
    // would pass the test above and silently break AT2.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });
    const { ask } = await editAskContent(repo, { id: seeded.id, question: SECOND_CORRECTION });

    expect(originalOf(ask)?.question).toBe(ESCALATED_QUESTION);
  });
});

describe("PR #3162 R1 — a metadata-only edit captures nothing", () => {
  test("no originalContent key is created when no content field is touched", async () => {
    // `metadata` is itself an editable field, so this edit is legal and reaches
    // the capture path having preserved nothing. Writing a contentless
    // `{ capturedAt }` would make it indistinguishable from an ask that HAS a
    // preserved original, which is what SC5 turns on.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    const { ask } = await editAskContent(repo, {
      id: seeded.id,
      metadata: { note: "bookkeeping" },
    });

    expect(ask.metadata[ORIGINAL_CONTENT_METADATA_KEY]).toBeUndefined();
    expect(ask.metadata.note).toBe("bookkeeping");
    // The edit itself is still recorded — only the capture is absent.
    expect(Array.isArray(ask.metadata[EDIT_HISTORY_METADATA_KEY])).toBe(true);
  });

  test("a metadata-only edit cannot PLANT one either (PR #3162 R2)", async () => {
    // The regression R1's own fix introduced. Making the capture write
    // conditional means that on a metadata-only edit the conditional spread
    // contributes nothing — so before this, the caller's `metadata` spread won
    // the merge outright and the planted key landed. Note the create-side strip
    // does not help here: this arrives through EDIT params, not create.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    const { ask } = await editAskContent(repo, {
      id: seeded.id,
      metadata: { [ORIGINAL_CONTENT_METADATA_KEY]: PLANTED_ORIGINAL, keepMe: "yes" },
    });

    expect(ask.metadata[ORIGINAL_CONTENT_METADATA_KEY]).toBeUndefined();
    expect(ask.metadata.keepMe).toBe("yes"); // unrelated keys still merge
  });

  test("nor can it overwrite a capture a previous edit made", async () => {
    // Measured, not assumed: this case passes WITH OR WITHOUT the params-side
    // strip, so it is not evidence for that fix and is not offered as such.
    // The reason is worth knowing — when a prior edit already captured
    // something, `captured` is populated from it, so `capturedAnything` is true
    // and the conditional write re-asserts the real value over anything the
    // caller planted. The hole is reachable only when there is NOTHING to
    // carry forward, which is the case above.
    //
    // Kept as a regression pin: a future change that stops carrying the prior
    // capture into `captured` would silently make this path plantable too.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });
    const { ask } = await editAskContent(repo, {
      id: seeded.id,
      metadata: { [ORIGINAL_CONTENT_METADATA_KEY]: PLANTED_ORIGINAL },
    });

    expect(originalOf(ask)?.question).toBe(ESCALATED_QUESTION);
  });

  test("a metadata-only edit AFTER a content edit preserves the existing capture", async () => {
    // The other direction: suppressing the write must not drop what a prior
    // edit captured.
    const repo = new FakeAskRepository();
    const seeded = await seedEscalatedAsk(repo);

    await editAskContent(repo, { id: seeded.id, question: FIRST_CORRECTION });
    const { ask } = await editAskContent(repo, { id: seeded.id, metadata: { note: "later" } });

    expect(originalOf(ask)?.question).toBe(ESCALATED_QUESTION);
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
