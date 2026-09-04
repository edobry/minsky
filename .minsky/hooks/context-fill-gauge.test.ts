import { describe, expect, test } from "bun:test";
import {
  buildGaugeLine,
  computeFill,
  countAssistantTurns,
  findLastUsage,
  measureFill,
  renderWorstCase,
  resolveWindow,
  run,
  FALLBACK_WINDOW_TOKENS,
  INJECTION_ENABLED,
  MAX_RENDERED_MODEL_ID_CHARS,
} from "./context-fill-gauge";
import type { FillMeasurement, UsageReading } from "./context-fill-gauge";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The `windowSource` discriminant, named once so the assertions cannot drift. */
const FALLBACK_SOURCE = "fallback-default";

function assistantLine(
  model: string | undefined,
  usage: Record<string, number> | undefined
): TranscriptLine {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      ...(model !== undefined ? { model } : {}),
      ...(usage !== undefined ? { usage } : {}),
    },
    timestamp: "2026-01-01T00:00:00Z",
  } as TranscriptLine;
}

function userLine(text: string): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: text },
    timestamp: "2026-01-01T00:00:00Z",
  } as TranscriptLine;
}

/** A usage block summing to `fill` on a 1M-window model: 2 + 8 + rest. */
function usageSummingTo(fill: number): Record<string, number> {
  return {
    input_tokens: 2,
    cache_creation_input_tokens: 8,
    cache_read_input_tokens: fill - 10,
    output_tokens: 4_242, // deliberately large: must NOT appear in the sum
  };
}

function ctxWith(lines: TranscriptLine[]): DispatchContext {
  return { transcriptLines: lines } as DispatchContext;
}

const INPUT = {
  transcript_path: "/tmp/does-not-need-to-exist.jsonl",
  session_id: "sess-1",
  cwd: "/tmp",
} as ClaudeHookInput;

// Narrowing helpers — these throw rather than using non-null assertions, so a
// null that should be impossible fails with a sentence instead of a TypeError.

function mustMeasure(lines: TranscriptLine[]): FillMeasurement {
  const measurement = measureFill(lines);
  if (measurement === null) throw new Error("expected a measurement, got null");
  return measurement;
}

function mustRead(lines: TranscriptLine[]): UsageReading {
  const reading = findLastUsage(lines);
  if (reading === null) throw new Error("expected a usage reading, got null");
  return reading;
}

function mustOutcome(outcome: GuardOutcome | null): GuardOutcome {
  if (outcome === null) throw new Error("expected an outcome, got null");
  return outcome;
}

function mustFirst(records: Record<string, unknown>[]): Record<string, unknown> {
  const first = records[0];
  if (first === undefined) throw new Error("expected at least one evaluation record");
  return first;
}

function runWithCapture(lines: TranscriptLine[]): {
  outcome: GuardOutcome | null;
  records: Record<string, unknown>[];
} {
  const records: Record<string, unknown>[] = [];
  const outcome = run(INPUT, ctxWith(lines), {
    logEvaluationRecordFn: ((_name: string, record: Record<string, unknown>) => {
      records.push(record);
    }) as never,
  });
  return { outcome, records };
}

// ---------------------------------------------------------------------------

describe("computeFill", () => {
  test("sums the three input-side fields and excludes output_tokens", () => {
    expect(
      computeFill({ inputTokens: 2, cacheCreationTokens: 738, cacheReadTokens: 796_084 })
    ).toBe(796_824);
  });
});

describe("findLastUsage", () => {
  test("returns the LAST assistant record carrying usage, not the first", () => {
    const reading = mustRead([
      assistantLine("claude-opus-5", usageSummingTo(100_000)),
      userLine("next"),
      assistantLine("claude-opus-5", usageSummingTo(500_000)),
    ]);
    expect(computeFill(reading)).toBe(500_000);
  });

  test("skips assistant records that carry no usage block", () => {
    const reading = mustRead([
      assistantLine("claude-opus-5", usageSummingTo(300_000)),
      assistantLine("claude-opus-5", undefined),
    ]);
    expect(computeFill(reading)).toBe(300_000);
  });

  test("returns null when no assistant record exists at all", () => {
    expect(findLastUsage([userLine("hello")])).toBeNull();
  });
});

describe("resolveWindow", () => {
  test("a known model resolves to its window and is marked as such", () => {
    expect(resolveWindow("claude-opus-5")).toEqual({
      tokens: 1_000_000,
      source: "known-model",
    });
  });

  test("an unknown model takes the conservative fallback and is marked as such", () => {
    const resolved = resolveWindow("some-future-model-9");
    expect(resolved.source).toBe(FALLBACK_SOURCE);
    expect(resolved.tokens).toBe(FALLBACK_WINDOW_TOKENS);
  });

  test("the fallback is SMALLER than any known window, so an unknown model over-reports rather than under-reports fill", () => {
    // Direction matters: over-estimating the window silently hides saturation,
    // which costs the gauge its whole purpose. Pin the direction, not the value.
    expect(FALLBACK_WINDOW_TOKENS).toBeLessThan(resolveWindow("claude-opus-5").tokens);
  });

  // -------------------------------------------------------------------------
  // mt#4968 — release-suffix resolution.
  //
  // `claude-fable-5-1` is now an exact table key, so it can no longer exercise
  // the stripping path. These use ids that are NOT keys, which is the only way
  // to test the retry rather than the lookup that shadows it.
  // -------------------------------------------------------------------------

  test("a dotted release id resolves to its family's window", () => {
    expect(resolveWindow("claude-opus-5-1")).toEqual({
      tokens: 1_000_000,
      source: "known-model",
    });
  });

  test("a dated release id resolves to its family's window", () => {
    expect(resolveWindow("claude-opus-5-20260101")).toEqual({
      tokens: 1_000_000,
      source: "known-model",
    });
  });

  test("a dotted release that ALSO carries a date strips in two hops", () => {
    // Why the retry is a loop rather than a single strip.
    expect(resolveWindow("claude-opus-5-1-20260101").tokens).toBe(1_000_000);
  });

  test("a family deliberately absent from the table stays absent through stripping", () => {
    // `claude-sonnet-5` is omitted on purpose (too small a sample to pin a
    // ceiling). Stripping must not smuggle it in via a release suffix — it can
    // only ever land on a key that already exists.
    expect(resolveWindow("claude-sonnet-5-1").source).toBe(FALLBACK_SOURCE);
  });

  test("an unknown family still takes the conservative fallback", () => {
    // mt#4968 acceptance test 2: the fallback is retained, not removed.
    const resolved = resolveWindow("claude-zeta-9");
    expect(resolved.source).toBe(FALLBACK_SOURCE);
    expect(resolved.tokens).toBe(FALLBACK_WINDOW_TOKENS);
  });

  test("a NON-numeric trailing segment is not stripped", () => {
    // Deliberately conservative: only an all-digits final segment is removed.
    // A `-preview` / `-thinking` variant may not share its family's window, and
    // this file's stated preference is the loud failure over the quiet guess.
    expect(resolveWindow("claude-opus-5-preview").source).toBe(FALLBACK_SOURCE);
  });

  test("stripping never eats a family name down to a bare vendor prefix", () => {
    expect(resolveWindow("claude-fable").source).toBe(FALLBACK_SOURCE);
    expect(resolveWindow("claude").source).toBe(FALLBACK_SOURCE);
  });
});

// ---------------------------------------------------------------------------
// mt#4968 acceptance test 1, at the measurement level rather than the lookup:
// the exact reading that was misreported in the originating incident.
// ---------------------------------------------------------------------------

describe("measureFill on a release-suffixed model (mt#4968)", () => {
  test("claude-fable-5-1 at 257,693 tokens reads ~25.8% against a known window", () => {
    const measurement = mustMeasure([assistantLine("claude-fable-5-1", usageSummingTo(257_693))]);
    expect(measurement.windowSource).toBe("known-model");
    expect(measurement.windowTokens).toBe(1_000_000);
    expect(measurement.fillRatioPct).toBe(25.8);
    // The number the gauge actually printed during the incident, pinned so a
    // regression is legible as the thing that happened rather than as a delta.
    expect(measurement.fillRatioPct).not.toBe(128.8);
    expect(measurement.tier).toBe("ok");
  });
});

describe("countAssistantTurns", () => {
  test("counts assistant records only", () => {
    expect(
      countAssistantTurns([
        userLine("a"),
        assistantLine("claude-opus-5", usageSummingTo(1_000)),
        userLine("b"),
        assistantLine("claude-opus-5", usageSummingTo(2_000)),
      ])
    ).toBe(2);
  });
});

describe("measureFill", () => {
  test("computes the documented ratio against a known window", () => {
    const measurement = mustMeasure([assistantLine("claude-opus-5", usageSummingTo(500_000))]);
    expect(measurement.fillTokens).toBe(500_000);
    expect(measurement.windowTokens).toBe(1_000_000);
    expect(measurement.fillRatioPct).toBe(50);
    expect(measurement.tier).toBe("ok");
  });

  test("tiers escalate ok -> warn -> critical as fill rises", () => {
    const tierAt = (fill: number) =>
      mustMeasure([assistantLine("claude-opus-5", usageSummingTo(fill))]).tier;
    expect(tierAt(500_000)).toBe("ok");
    expect(tierAt(850_000)).toBe("warn");
    expect(tierAt(970_000)).toBe("critical");
  });

  test("returns null on a cold start with no assistant record", () => {
    expect(measureFill([userLine("first prompt")])).toBeNull();
  });
});

describe("compaction boundary", () => {
  // The transcript is append-only: the pre-compaction records remain on disk and
  // a synthetic `{type:"user", isCompactSummary:true}` record is appended, after
  // which usage resets. The gauge must report the POST-boundary reading — that
  // is the true remaining headroom — rather than the pre-compaction peak.
  test("reports the post-compaction reading, not the pre-compaction peak", () => {
    const compactSummary = {
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "<summary>" },
      timestamp: "2026-01-01T00:00:00Z",
    } as TranscriptLine;

    const measurement = mustMeasure([
      assistantLine("claude-opus-5", usageSummingTo(996_378)),
      compactSummary,
      assistantLine("claude-opus-5", usageSummingTo(105_653)),
    ]);

    expect(measurement.fillTokens).toBe(105_653);
    expect(measurement.tier).toBe("ok");
  });
});

describe("buildGaugeLine", () => {
  const measurement = mustMeasure([assistantLine("claude-opus-5", usageSummingTo(850_000))]);

  test("states the fill percentage", () => {
    expect(buildGaugeLine(measurement)).toContain("85%");
  });

  // PR #3144 R3. "Exactly one line" is a spec criterion, and the first
  // implementation returned three (content / blank / framing). Pinned here so
  // the property is enforced rather than re-litigated.
  test("is literally ONE line — no embedded newline", () => {
    expect(buildGaugeLine(measurement)).not.toContain("\n");
    expect(buildGaugeLine(measurement).split("\n")).toHaveLength(1);
  });

  test("uses the /handoff skill's own auto-trigger vocabulary verbatim", () => {
    // Case-insensitive on purpose: the phrase is sentence-initial in the rendered
    // line, and the skill's trigger list is read by an LLM rather than matched by
    // a regex, so the vocabulary is what has to match — not the capitalization.
    expect(buildGaugeLine(measurement).toLowerCase()).toContain("context-density indicator");
  });

  test("names an unrecognized model's window as assumed", () => {
    const unknown = mustMeasure([assistantLine("mystery-model", usageSummingTo(190_000))]);
    expect(buildGaugeLine(unknown)).toContain("assumed");
  });

  // -------------------------------------------------------------------------
  // mt#4968 — the caveat marks the PERCENTAGE, not only the denominator.
  //
  // The pre-mt#4968 line carried "assumed" on the window, several clauses after
  // the figure, and an agent still relayed the figure to the principal as fact.
  // The test above would pass against that wording; these two are what pin the
  // placement, so keep them together.
  // -------------------------------------------------------------------------

  test("a fallback reading marks the percentage itself as estimated", () => {
    const unknown = mustMeasure([assistantLine("mystery-model", usageSummingTo(190_000))]);
    const line = buildGaugeLine(unknown);
    const pct = `${unknown.fillRatioPct}%`;
    expect(line).toContain(`${pct} ESTIMATED`);
    // The marker is adjacent to the number, not merely present somewhere.
    expect(line.indexOf("ESTIMATED")).toBe(line.indexOf(pct) + pct.length + 1);
  });

  test("a known-model reading carries NO estimate marker", () => {
    // A measured reading needs no hedge; hedging it would train the marker to
    // be ignored, which is the failure the marker exists to prevent.
    expect(buildGaugeLine(measurement)).not.toContain("ESTIMATED");
    expect(buildGaugeLine(measurement)).not.toContain("assumed");
  });

  test("the fallback line is still literally ONE line", () => {
    // The single-line property (PR #3144 R3) is asserted above on the
    // known-model branch only; the fallback branch is longer and is the one
    // that would break it.
    const unknown = mustMeasure([assistantLine("mystery-model", usageSummingTo(190_000))]);
    expect(buildGaugeLine(unknown).split("\n")).toHaveLength(1);
  });

  test("the fallback line still says no action is required", () => {
    const unknown = mustMeasure([assistantLine("mystery-model", usageSummingTo(190_000))]);
    expect(buildGaugeLine(unknown).toLowerCase()).toContain("no action is required");
  });

  test("an over-long model id is capped in the render", () => {
    // The id is the only unbounded input to the line; capping it is what lets
    // the registry declare a PROVED attentionCost rather than a ceiling.
    const long = "z".repeat(MAX_RENDERED_MODEL_ID_CHARS + 50);
    const unknown = mustMeasure([assistantLine(long, usageSummingTo(190_000))]);
    expect(buildGaugeLine(unknown)).not.toContain(long);
    expect(buildGaugeLine(unknown)).toContain(`${"z".repeat(MAX_RENDERED_MODEL_ID_CHARS - 1)}…`);
  });

  test("an id at exactly the cap is NOT truncated", () => {
    const exact = "z".repeat(MAX_RENDERED_MODEL_ID_CHARS);
    const unknown = mustMeasure([assistantLine(exact, usageSummingTo(190_000))]);
    expect(buildGaugeLine(unknown)).toContain(exact);
    expect(buildGaugeLine(unknown)).not.toContain("…");
  });

  test("renderWorstCase stays inside the registry's declared attentionCost", () => {
    // Pins the bound the registry entry declares (450). If an edit to the line
    // pushes past this, the declaration is wrong before it reaches review —
    // which is the failure the pre-mt#4968 "ceiling, not a proved bound" note
    // left open.
    expect(renderWorstCase().length).toBeLessThanOrEqual(450);
    // And it must actually be the LONGER branch, or it measures the wrong one.
    expect(renderWorstCase().length).toBeGreaterThan(buildGaugeLine(measurement).length);
  });

  // -------------------------------------------------------------------------
  // The display-only constraint, enforced here rather than by review.
  //
  // ask#8878 (closed 2026-08-18): the principal took the gauge and explicitly
  // HELD the automatic-handoff half. A future edit that turns this line into an
  // instruction would satisfy every other test in this file, so the constraint
  // needs its own assertion or it is not a constraint.
  // -------------------------------------------------------------------------
  test("does not instruct the agent to hand off or stop", () => {
    const line = buildGaugeLine(measurement).toLowerCase();
    for (const imperative of [
      "invoke `/handoff` now",
      "you should hand off",
      "hand off now",
      "stop working",
      "wind down",
      "end the session",
      "must hand off",
    ]) {
      expect(line).not.toContain(imperative);
    }
  });

  test("says explicitly that no action is required", () => {
    expect(buildGaugeLine(measurement).toLowerCase()).toContain("no action is required");
  });
});

describe("run", () => {
  test("records an evaluation row BELOW threshold and injects nothing", () => {
    const { outcome, records } = runWithCapture([
      assistantLine("claude-opus-5", usageSummingTo(500_000)),
    ]);
    const record = mustFirst(records);
    expect(records).toHaveLength(1);
    expect(record.tier).toBe("ok");
    expect(record.fired).toBe(false);
    expect(record.assistantTurnCount).toBe(1);
    // Below threshold the guard is silent AND free.
    expect(outcome).toBeNull();
  });

  test("records an evaluation row ABOVE threshold and returns a calibration record", () => {
    const { outcome, records } = runWithCapture([
      assistantLine("claude-opus-5", usageSummingTo(970_000)),
    ]);
    const record = mustFirst(records);
    expect(record.fired).toBe(true);
    expect(record.tier).toBe("critical");

    const calibration = mustOutcome(outcome).calibration as Record<string, unknown> | undefined;
    if (calibration === undefined) throw new Error("expected a calibration record");
    expect(calibration.fillRatioPct).toBe(97);
  });

  test("ships log-only: no additionalContext while INJECTION_ENABLED is false", () => {
    const { outcome } = runWithCapture([assistantLine("claude-opus-5", usageSummingTo(970_000))]);
    const resolved = mustOutcome(outcome);
    if (INJECTION_ENABLED) {
      expect(resolved.additionalContext).toBeDefined();
    } else {
      expect(resolved.additionalContext).toBeUndefined();
    }
  });

  test("fails open on a cold start, writing no record and not throwing", () => {
    const { outcome, records } = runWithCapture([userLine("first prompt")]);
    expect(outcome).toBeNull();
    expect(records).toHaveLength(0);
  });

  test("fails open on an empty transcript", () => {
    const { outcome, records } = runWithCapture([]);
    expect(outcome).toBeNull();
    expect(records).toHaveLength(0);
  });

  // PR #3144 R2. An override must not be SILENT: this guard's product is a
  // continuous distribution, so a skipped turn that writes nothing is
  // indistinguishable from a turn that had no usage record, and a later reader
  // under-counts without any signal that it is doing so.
  test("an override is RECORDED, not silent — the gap is marked in the stream", () => {
    const prior = process.env.MINSKY_SKIP_CONTEXT_FILL_GAUGE;
    process.env.MINSKY_SKIP_CONTEXT_FILL_GAUGE = "1";
    try {
      const { outcome, records } = runWithCapture([
        assistantLine("claude-opus-5", usageSummingTo(970_000)),
      ]);
      const record = mustFirst(records);
      expect(record.overridden).toBe(true);
      expect(record.overrideAck).toBe("1");
      expect(record.fired).toBe(false);
      // No measurement is taken — the override means do not do the work.
      expect(record.fillTokens).toBeUndefined();
      // And the audit line still goes out for the dispatcher to surface.
      expect(mustOutcome(outcome).auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      if (prior === undefined) delete process.env.MINSKY_SKIP_CONTEXT_FILL_GAUGE;
      else process.env.MINSKY_SKIP_CONTEXT_FILL_GAUGE = prior;
    }
  });

  test("records the fallback window source for an unrecognized model", () => {
    const { records } = runWithCapture([assistantLine("mystery-model", usageSummingTo(50_000))]);
    const record = mustFirst(records);
    expect(record.windowSource).toBe(FALLBACK_SOURCE);
    expect(record.windowTokens).toBe(FALLBACK_WINDOW_TOKENS);
  });
});
