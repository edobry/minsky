/**
 * Full-fidelity raw-line capture into `transcript_lines` (mt#4573).
 *
 * A separate file from `agent-transcript-ingest-service.test.ts` because that
 * one sits at the 1500-line ceiling — the same reason `agent-transcript-ingest-abort`
 * and `agent-transcript-ingest-sqlstate-quarantine` are their own files. The
 * fixtures (fake source, fake DB, line builders) are imported from it rather
 * than duplicated, so both files exercise the SAME fake: a second, divergent
 * fake is how a test stops describing production.
 */

import { describe, expect, test } from "bun:test";

import { makeDb, type FakeRow } from "./__fixtures__/fake-ingest-db";
import {
  FakeTranscriptSource,
  SESSION_A,
  TS1,
  TS3,
  makeAttachmentLine,
  makeDiscovered,
  makeLines,
  makeSvc,
} from "./agent-transcript-ingest-service.test";
import type { RawTurnLine } from "./transcript-source";

/** A line type the retention filter drops today. */
function makeUnretainedLine(type: string): RawTurnLine {
  return { type, detail: `detail-for-${type}` } as unknown as RawTurnLine;
}

describe("full-fidelity capture into transcript_lines (mt#4573)", () => {
  test("captures EVERY line type — including one no retention filter has ever seen", async () => {
    const source = new FakeTranscriptSource();
    // Three real dropped types measured 2026-08-25, plus an invented one.
    // The invented type is the load-bearing case: the harness adds types
    // without notice, so a test covering only today's inventory would keep
    // passing while the next Claude Code release silently loses something.
    source.addSession(SESSION_A, [
      ...makeLines([TS1]),
      makeAttachmentLine(TS1),
      makeUnretainedLine("mode"),
      makeUnretainedLine("bridge-session"),
      makeUnretainedLine("ai-title"),
      makeUnretainedLine("totally-unknown-future-type"),
    ]);
    const db = makeDb(new Map<string, FakeRow>());
    db._primeSession(SESSION_A);

    const result = await makeSvc(db, source).ingestSession(makeDiscovered(SESSION_A));

    expect(result.error).toBeUndefined();
    expect(db._capturedLines.map((r) => r.lineType)).toEqual([
      "user",
      "attachment",
      "mode",
      "bridge-session",
      "ai-title",
      "totally-unknown-future-type",
    ]);
    // Ordinals are dense and file-ordered — this is what a reconstruction
    // replays, so a gap or a reorder here is a corrupted transcript.
    expect(db._capturedLines.map((r) => r.lineOrdinal)).toEqual([0, 1, 2, 3, 4, 5]);
    // And the payload is the whole line, not a projection of it.
    expect(db._capturedLines[2]?.line).toMatchObject({
      type: "mode",
      detail: "detail-for-mode",
    });
  });

  test("capturing new types does NOT shift the attachment primary key", async () => {
    // The regression lock for why this is a new table rather than a widened
    // `RETAINED_TYPES`: `lineIndex` is half of `agent_transcript_attachments`'
    // PK, and renumbering it would make a re-ingest write rows at shifted keys
    // that `ON CONFLICT DO NOTHING` then silently keeps stale.
    const withoutUnretained = new FakeTranscriptSource();
    withoutUnretained.addSession(SESSION_A, [...makeLines([TS1]), makeAttachmentLine(TS1)]);
    const dbA = makeDb(new Map<string, FakeRow>());
    dbA._primeSession(SESSION_A);
    await makeSvc(dbA, withoutUnretained).ingestSession(makeDiscovered(SESSION_A));

    const withUnretained = new FakeTranscriptSource();
    withUnretained.addSession(SESSION_A, [
      makeUnretainedLine("mode"),
      ...makeLines([TS1]),
      makeUnretainedLine("bridge-session"),
      makeAttachmentLine(TS1),
      makeUnretainedLine("ai-title"),
    ]);
    const dbB = makeDb(new Map<string, FakeRow>());
    dbB._primeSession(SESSION_A);
    await makeSvc(dbB, withUnretained).ingestSession(makeDiscovered(SESSION_A));

    expect(dbB._attachments.map((a) => a.lineIndex)).toEqual(
      dbA._attachments.map((a) => a.lineIndex)
    );
    // …while capture DID see the extra lines, so the two stores genuinely
    // disagree about line count. That disagreement is the design.
    expect(dbB._capturedLines.length).toBeGreaterThan(dbA._capturedLines.length);
  });

  test("captures a brand-new session whose lines are ALL un-timestamped", async () => {
    // PR #3346 R1, BLOCKING. A new conversation's first lines can be
    // `bridge-session` / `mode` / `permission-mode` — every one un-timestamped —
    // so both timestamped paths are empty and no parent row exists yet. The
    // original shape guarded the capture write on `parentRowExists` and hit the
    // early return, and because the ordinal high-water only advances when rows
    // land, every later sweep rebuilt the same batch and re-reached the same
    // guard: a permanent, silent loss rather than a deferred one.
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, [
      makeUnretainedLine("bridge-session"),
      makeUnretainedLine("mode"),
      makeUnretainedLine("permission-mode"),
    ]);
    const db = makeDb(new Map<string, FakeRow>());
    db._primeSession(SESSION_A);

    const result = await makeSvc(db, source).ingestSession(makeDiscovered(SESSION_A));

    expect(result.error).toBeUndefined();
    expect(db._capturedLines.map((r) => r.lineType)).toEqual([
      "bridge-session",
      "mode",
      "permission-mode",
    ]);
  });

  test("a fully-captured session with nothing new still writes nothing", async () => {
    // The other half of the same change: widening the early-return condition
    // must not cost a write on every steady-state sweep. A session whose lines
    // are all already captured has no new capture rows, so it still returns
    // early — this is the guard against reintroducing the per-tick write
    // amplification that early return exists to avoid.
    const source = new FakeTranscriptSource();
    source.addSession(SESSION_A, [...makeLines([TS1]), makeUnretainedLine("mode")]);
    const db = makeDb(new Map<string, FakeRow>());
    db._primeSession(SESSION_A);
    const svc = makeSvc(db, source);

    await svc.ingestSession(makeDiscovered(SESSION_A));
    const writesAfterFirst = db._writeOrder.length;

    await svc.ingestSession(makeDiscovered(SESSION_A));

    expect(db._writeOrder.length).toBe(writesAfterFirst);
    expect(db._capturedLines.length).toBe(2);
  });

  test("re-ingest captures only the appended lines, not the whole file again", async () => {
    const source = new FakeTranscriptSource();
    const firstBatch = [...makeLines([TS1]), makeUnretainedLine("mode")];
    source.addSession(SESSION_A, firstBatch);
    const db = makeDb(new Map<string, FakeRow>());
    db._primeSession(SESSION_A);
    const svc = makeSvc(db, source);

    await svc.ingestSession(makeDiscovered(SESSION_A));
    const afterFirst = db._capturedLines.length;
    expect(afterFirst).toBe(2);

    source.addSession(SESSION_A, [
      ...firstBatch,
      ...makeLines([TS3]),
      makeUnretainedLine("ai-title"),
    ]);
    await svc.ingestSession(makeDiscovered(SESSION_A));

    // Only the two NEW lines were written; ordinals continue from the
    // high-water rather than restarting, so nothing is duplicated.
    expect(db._capturedLines.length).toBe(4);
    expect(db._capturedLines.slice(afterFirst).map((r) => r.lineOrdinal)).toEqual([2, 3]);
  });
});
