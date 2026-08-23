/**
 * Tests for measurement-decay detection (mt#4452, trigger 2).
 *
 * Pure core, so everything runs against object literals — no database, no service, no
 * patching. The two replay fixtures use REAL sentences from mem#773 and mt#4345 rather than
 * synthetic paraphrases, because the incident is the point.
 */

import { describe, expect, test } from "bun:test";
import {
  computeMeasurementDecay,
  extractCitedSubsystems,
  extractMeasurement,
  renderMeasurementNote,
  type DetectedMeasurement,
  type InterveningTask,
  type MeasurementDecay,
} from "./measurement-decay";

/** Evaluation "now" for age arithmetic — fixed so the tests are not wall-clock dependent. */
const NOW = new Date("2026-08-22T00:00:00Z");

/** A real sentence from mem#773, the record the originating incident reasoned from. */
const MEM773_SENTENCE =
  "**Measured on prod 2026-07-30 (`pg_stat_user_tables`):** `agent_transcripts`: 2,047 live " +
  "rows, **141,631 updates** — roughly **69 rewrites per row**.";

/**
 * Extract, failing the test loudly when nothing was found.
 *
 * A helper rather than a `!` assertion: `@typescript-eslint/no-non-null-assertion` forbids the
 * latter, and the helper is better anyway — a silent `undefined` would surface as a confusing
 * property-access error several lines later instead of naming what was not found.
 */
function mustExtract(record: { content: string; description?: string }): DetectedMeasurement {
  const found = extractMeasurement(record);
  if (!found) throw new Error(`expected a measurement in: ${record.content.slice(0, 80)}`);
  return found;
}

/** Same, for the verdict step. */
function mustDecay(
  measurement: DetectedMeasurement,
  intervening: InterveningTask[],
  now: Date
): MeasurementDecay {
  const decay = computeMeasurementDecay(measurement, intervening, now);
  if (!decay) throw new Error("expected a measurement-decay verdict, got undefined");
  return decay;
}

const MT4345: InterveningTask = {
  taskId: "mt#4345",
  title: "Transcript ingest rewrites every unchanged turn: 19.2M updates against 327k rows",
  completedAt: "2026-08-20T00:00:00Z",
};

describe("extractMeasurement", () => {
  test("finds a measurement-bound date alongside a figure", () => {
    const m = extractMeasurement({ content: MEM773_SENTENCE });
    expect(m?.measuredOn).toBe("2026-07-30");
  });

  test("recognizes the documented phrasings", () => {
    expect(
      extractMeasurement({ content: "Baseline 2026-05-12 — context cost was 40% of budget." })
        ?.measuredOn
    ).toBe("2026-05-12");
    expect(
      extractMeasurement({ content: "The 2026-06-30 measurement put it at 623 MB." })?.measuredOn
    ).toBe("2026-06-30");
    expect(
      extractMeasurement({ content: "measured 2026-07-31: 14.2 M updates on 239 k rows" })
        ?.measuredOn
    ).toBe("2026-07-31");
  });

  test("a date with NO figure is not a measurement", () => {
    // A memory can be dated without measuring anything. Requiring a magnitude unit is most
    // of the precision — see the module's calibration table.
    expect(
      extractMeasurement({ content: "Measured on prod 2026-07-30 that the behaviour is correct." })
    ).toBeUndefined();
  });

  test("a figure with NO measurement date cannot be aged", () => {
    expect(
      extractMeasurement({ content: "The table holds 2,047 rows and 141,631 updates." })
    ).toBeUndefined();
  });

  test("a handoff's status-check line is NOT a measurement date", () => {
    // The dominant false positive of the loose first cut: `verified <date>` matched every
    // handoff's "Statuses verified in-turn at ..." line. 118 candidates -> 28 once dropped.
    const m = extractMeasurement({
      content:
        "handoff_something_2026-08-19\n\nStatuses verified in-turn at 2026-08-19 05:15Z. " +
        "Re-verify on resume. Three PRs merged, 40 rows touched.",
    });
    expect(m).toBeUndefined();
  });

  test("an `as of <date>` line is not a measurement date", () => {
    expect(
      extractMeasurement({ content: "As of 2026-08-19 the queue holds 12 rows." })
    ).toBeUndefined();
  });

  test("takes the OLDEST date when several match, and carries its sentence", () => {
    // mem#773's real shape: it quotes ADR-025's 2026-06-30 blob measurement while reporting
    // its own 2026-07-30 figures. Oldest is conservative; the sentence carries attribution.
    const m = extractMeasurement({
      content:
        "ADR-025 frames it as a SIZE problem (623 MB, measured 2026-06-30).\n" +
        "Measured on prod 2026-07-30: 141,631 updates.",
    });
    expect(m?.measuredOn).toBe("2026-06-30");
    expect(m?.matchedSentence).toContain("ADR-025");
  });

  test("rejects a malformed date rather than producing an invalid one", () => {
    expect(
      extractMeasurement({ content: "Measured on prod 2026-13-45: 10 rows." })
    ).toBeUndefined();
  });

  test("is not order-dependent across calls (global regex lastIndex is reset)", () => {
    const record = { content: MEM773_SENTENCE };
    expect(extractMeasurement(record)?.measuredOn).toBe("2026-07-30");
    expect(extractMeasurement(record)?.measuredOn).toBe("2026-07-30");
    expect(extractMeasurement(record)?.measuredOn).toBe("2026-07-30");
  });
});

describe("extractCitedSubsystems", () => {
  test("picks up backticked source paths and table names", () => {
    const subsystems = extractCitedSubsystems(
      "The mechanism is in `agent-transcript-ingest-service.ts` and `turn-writer.ts`; " +
        "it writes `agent_transcript_turns`."
    );
    expect(subsystems).toContain("agent-transcript-ingest-service.ts");
    expect(subsystems).toContain("turn-writer.ts");
    expect(subsystems).toContain("agent_transcript_turns");
  });

  test("picks up a bare table mention followed by 'table' or 'rows'", () => {
    expect(extractCitedSubsystems("the agent_transcripts table is 1,671 MB")).toContain(
      "agent_transcripts"
    );
  });

  test("orders by citation count, so the dominant subsystem survives the cap", () => {
    const subsystems = extractCitedSubsystems(
      "`turn-writer.ts` again `turn-writer.ts` and once `other-file.ts`",
      1
    );
    expect(subsystems).toEqual(["turn-writer.ts"]);
  });

  test("ignores short identifiers that are ordinary prose", () => {
    expect(extractCitedSubsystems("`a_b` is too short to be a table")).toEqual([]);
  });
});

describe("computeMeasurementDecay — the silence contract", () => {
  test("returns NOTHING when nothing intervened", () => {
    // Age alone is not staleness. A measurement is stale when what it measured has changed.
    const m = mustExtract({ content: MEM773_SENTENCE });
    expect(computeMeasurementDecay(m, [], NOW)).toBeUndefined();
  });

  test("returns a verdict when a task landed on the cited subsystem", () => {
    const m = mustExtract({ content: MEM773_SENTENCE });
    const decay = computeMeasurementDecay(m, [MT4345], NOW);
    expect(decay?.measuredOn).toBe("2026-07-30");
    expect(decay?.interveningTasks[0]?.taskId).toBe("mt#4345");
  });

  test("reports age in whole days from the body date, not from any column", () => {
    const m = mustExtract({ content: MEM773_SENTENCE });
    // 2026-07-30 -> 2026-08-22 is 23 days. mem#773's updatedAt was 2026-08-22, which would
    // have reported 0 — the exact reason the date is parsed out of the body.
    expect(computeMeasurementDecay(m, [MT4345], NOW)?.ageDays).toBe(23);
  });

  test("never reports a negative age", () => {
    const m = mustExtract({ content: "Measured on prod 2026-09-01: 10 rows." });
    expect(computeMeasurementDecay(m, [MT4345], NOW)?.ageDays).toBe(0);
  });
});

describe("renderMeasurementNote", () => {
  test("names the age, the date, the intervening task, and the subsystem", () => {
    const m = mustExtract({
      content: `${MEM773_SENTENCE} The writer is \`turn-writer.ts\`.`,
    });
    const note = renderMeasurementNote(mustDecay(m, [MT4345], NOW));
    expect(note).toContain("23 days ago");
    expect(note).toContain("2026-07-30");
    expect(note).toContain("mt#4345");
    expect(note).toContain("turn-writer.ts");
  });

  test("does NOT assert the figures are wrong — it reports the delta", () => {
    // The detector observes that something landed; whether the numbers are now wrong is the
    // reader's call. Asserting it would be a verdict the evidence does not support.
    const m = mustExtract({ content: MEM773_SENTENCE });
    const note = renderMeasurementNote(mustDecay(m, [MT4345], NOW));
    expect(note).toContain("MAY BE STALE");
    expect(note).toContain("Re-measure before relying");
    expect(note).not.toContain("incorrect");
    expect(note).not.toContain("wrong");
  });

  test("summarizes rather than listing every intervening task", () => {
    const many: InterveningTask[] = Array.from({ length: 6 }, (_, i) => ({
      taskId: `mt#${5000 + i}`,
      title: `task ${i}`,
    }));
    const m = mustExtract({ content: MEM773_SENTENCE });
    const note = renderMeasurementNote(mustDecay(m, many, NOW));
    expect(note).toContain("+3 more");
  });
});

describe("replay of the originating incident (mem#773 x mt#4345)", () => {
  test("the record that drove the ask#8004 advisory is flagged, naming mt#4345", () => {
    // AT8: the whole task exists because this pair produced no signal on 2026-08-22.
    const mem773 =
      "transcript_blob_write_amplification_is_the_real_cost\n\n" +
      `${MEM773_SENTENCE}\n` +
      "`agent_transcript_turns` carries 14.2 M updates on 239 k rows, because " +
      "`turn-writer.ts` re-upserts EVERY turn on every incremental ingest.";

    const m = mustExtract({ content: mem773 });
    expect(m.measuredOn).toBe("2026-07-30");
    expect(m.subsystems).toContain("turn-writer.ts");
    expect(m.subsystems).toContain("agent_transcript_turns");

    const decay = mustDecay(m, [MT4345], NOW);
    expect(decay.ageDays).toBe(23);
    expect(renderMeasurementNote(decay)).toContain("mt#4345");
  });

  test("the same record with nothing intervening stays silent", () => {
    const m = mustExtract({ content: MEM773_SENTENCE });
    expect(computeMeasurementDecay(m, [], NOW)).toBeUndefined();
  });
});
