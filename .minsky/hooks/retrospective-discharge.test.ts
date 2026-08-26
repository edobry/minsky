import { describe, expect, test } from "bun:test";
import {
  analyzeDischarge,
  groupFlaggedByTurn,
  hasDeclineMarker,
  hasDurableArtifact,
  promptIdentity,
  DISCHARGE_REPORTED_FAMILY,
} from "./retrospective-discharge";
import { flagKey } from "./turn-end-scan-store";
import type { TranscriptLine } from "./transcript";

// ---------------------------------------------------------------------------
// Fixtures — shaped after the originating transcript
// (session 84d5a587-5b88-4cdd-92f0-3801ae075558, 2026-08-25)
// ---------------------------------------------------------------------------

/** A REAL user prompt: role user, plain-string content, no isMeta. */
function prompt(uuid: string, text = "go on"): TranscriptLine {
  return { type: "user", uuid, message: { role: "user", content: text } };
}

function assistantText(text: string): TranscriptLine {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function toolUse(name: string, input: Record<string, unknown> = {}): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
  };
}

/** A tool_result line — role user, but NOT a real prompt. */
function toolResult(): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  };
}

const SKILL_CALL = toolUse("Skill", { skill: "retrospective" });
const MEMORY_PATCH = toolUse("mcp__minsky__memory_patch", {
  id: "mem#490",
  section: "Recurrences",
});
const SPEC_PATCH = toolUse("mcp__minsky__tasks_spec_patch", { taskId: "mt#2447" });

/** The turn the Stop guard flagged, keyed `p-flagged`. */
const FLAGGED_PHRASE = "You were right that I gave up too early.";
/** The operator prompt that opened the flagged turn, verbatim in shape. */
const FLAGGED_TURN_PROMPT = "why did you give up?";
const FLAGGED_KEY = flagKey("p-flagged", "R1", FLAGGED_PHRASE);

const LOOKBACK = 5;

/** `n` complete turns after the given lines, to close the window. */
function padTurns(n: number): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (let i = 0; i < n; i++) {
    out.push(prompt(`p-pad${i}`), assistantText("unrelated work"));
  }
  return out;
}

describe("promptIdentity — must agree with turnKeyFor", () => {
  test("prefers uuid, falls back to timestamp, then session-start", () => {
    expect(promptIdentity({ uuid: "u1", timestamp: "t1" })).toBe("u1");
    expect(promptIdentity({ timestamp: "t1" })).toBe("t1");
    expect(promptIdentity({})).toBe("session-start");
    expect(promptIdentity(undefined)).toBe("session-start");
  });
});

describe("groupFlaggedByTurn", () => {
  test("groups families under their turn key", () => {
    const grouped = groupFlaggedByTurn(
      new Set([
        flagKey("tA", "R1", "one"),
        flagKey("tA", "R2", "two"),
        flagKey("tB", "R1", "three"),
      ])
    );
    expect([...(grouped.get("tA") ?? [])].sort()).toEqual(["R1", "R2"]);
    expect([...(grouped.get("tB") ?? [])]).toEqual(["R1"]);
  });

  test("a phrase containing '|' does not corrupt the turn key", () => {
    const grouped = groupFlaggedByTurn(new Set([flagKey("tA", "R1", "a | b | c")]));
    expect([...grouped.keys()]).toEqual(["tA"]);
  });

  test("the reported-marker family is not itself a flagged trigger", () => {
    const grouped = groupFlaggedByTurn(new Set([flagKey("tA", DISCHARGE_REPORTED_FAMILY, "")]));
    expect(grouped.size).toBe(0);
  });
});

describe("hasDurableArtifact", () => {
  test("a memory_patch counts", () => {
    expect(hasDurableArtifact([MEMORY_PATCH])).toBe(true);
  });

  test("a tasks_create counts", () => {
    expect(hasDurableArtifact([toolUse("mcp__minsky__tasks_create", {})])).toBe(true);
  });

  test("a write to a rule file counts", () => {
    expect(
      hasDurableArtifact([toolUse("Edit", { file_path: ".minsky/rules/claim-confidence.mdc" })])
    ).toBe(true);
  });

  test("a write to a hook counts", () => {
    expect(
      hasDurableArtifact([toolUse("Write", { file_path: ".minsky/hooks/some-guard.ts" })])
    ).toBe(true);
  });

  test("an ordinary source edit does NOT count", () => {
    expect(hasDurableArtifact([toolUse("Edit", { file_path: "src/domain/session/foo.ts" })])).toBe(
      false
    );
  });

  test("the skill invocation is NOT a durable artifact — they are separate signals", () => {
    // The load-bearing separation: folding these together is what would have
    // passed the originating incident.
    expect(hasDurableArtifact([SKILL_CALL])).toBe(false);
  });

  test("a top-level tool_use line is read as well as a nested block", () => {
    const topLevel: TranscriptLine = {
      type: "tool_use",
      name: "mcp__minsky__memory_create",
      input: {},
    };
    expect(hasDurableArtifact([topLevel])).toBe(true);
  });
});

describe("hasDeclineMarker", () => {
  test("matches the literal token in assistant text", () => {
    expect(
      hasDeclineMarker([assistantText("[not-a-retrospective: the phrase quoted someone else]")])
    ).toBe(true);
  });

  test("is case-insensitive and tolerates spacing before the colon", () => {
    expect(hasDeclineMarker([assistantText("[Not-A-Retrospective : reason]")])).toBe(true);
  });

  test("prose about retrospectives does NOT match", () => {
    expect(hasDeclineMarker([assistantText("This is not a retrospective case, I think.")])).toBe(
      false
    );
  });
});

describe("analyzeDischarge", () => {
  /**
   * AT1 — the originating incident's ACTUAL shape.
   *
   * The flagged turn is followed by a real user prompt and then durable writes
   * (`memory_patch` on mem#490, `tasks_spec_patch` on mt#2447) with NO
   * `Skill{skill:"retrospective"}` anywhere. The prior criteria called this
   * "no artifact call", which is a shape that did not occur.
   */
  test("AT1: durable writes but no skill invocation → artifact-only", () => {
    const lines: TranscriptLine[] = [
      prompt("p-flagged", FLAGGED_TURN_PROMPT),
      assistantText(FLAGGED_PHRASE),
      prompt("p-next", "I want you to do a brief retro on why you gave up"),
      assistantText("Recording it now."),
      MEMORY_PATCH,
      toolResult(),
      SPEC_PATCH,
      ...padTurns(LOOKBACK + 1),
      prompt("p-now"),
    ];

    const { findings, reportedKeys } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.disposition).toBe("artifact-only");
    expect(findings[0]?.families).toEqual(["R1"]);
    expect(findings[0]?.turnKey).toBe("p-flagged");
    expect(reportedKeys).toEqual([flagKey("p-flagged", DISCHARGE_REPORTED_FAMILY, "")]);
  });

  test("AT1 control: the same turn with NOTHING durable → unaddressed", () => {
    // Distinguishes the incident's shape from doing nothing at all. Without
    // this pair, `artifact-only` would be unfalsifiable.
    const lines: TranscriptLine[] = [
      prompt("p-flagged", FLAGGED_TURN_PROMPT),
      assistantText(FLAGGED_PHRASE),
      ...padTurns(LOOKBACK + 1),
      prompt("p-now"),
    ];
    const { findings } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings[0]?.disposition).toBe("unaddressed");
  });

  test("AT2: the skill invoked in the flagged turn → acted", () => {
    const lines: TranscriptLine[] = [
      prompt("p-flagged"),
      assistantText(FLAGGED_PHRASE),
      SKILL_CALL,
      prompt("p-now"),
    ];
    const { findings } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings[0]?.disposition).toBe("acted");
  });

  /**
   * AT3 — the load-bearing placement test, replaying the measured ordering.
   *
   * The remediation lands TWO turns after the flagged one, with a real user
   * prompt in between (16:06:52Z fire → 16:08:56Z prompt → 16:10:40Z work).
   * Fails on any single-turn implementation: the window would close at the
   * intervening prompt and report on a turn that was about to be complied with.
   */
  test("AT3: the skill invoked two turns later → acted, not a warning", () => {
    const lines: TranscriptLine[] = [
      prompt("p-flagged", FLAGGED_TURN_PROMPT),
      assistantText(FLAGGED_PHRASE),
      prompt("p-next", "I want you to do a brief retro on why you gave up"),
      assistantText("On it."),
      prompt("p-third", "go ahead"),
      SKILL_CALL,
      prompt("p-now"),
    ];
    const { findings } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings[0]?.disposition).toBe("acted");
  });

  /**
   * Negative control on the window's UPPER edge — the same skill invocation as
   * AT3, moved past the lookback.
   *
   * This is the pair that makes AT3 mean something: without it, a window wide
   * enough to pass AT3 is indistinguishable from an unbounded one. It caught a
   * real defect — the window originally ran `lines.slice(startIdx)` to the end
   * of the transcript, so this case returned `acted` and no ordering could
   * have told the two apart.
   */
  test("AT3 control: the SAME invocation pushed past the window → not counted", () => {
    const lines: TranscriptLine[] = [
      prompt("p-flagged"),
      assistantText(FLAGGED_PHRASE),
      ...padTurns(LOOKBACK + 1),
      prompt("p-late"),
      SKILL_CALL,
      prompt("p-now"),
    ];
    const { findings } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.disposition).toBe("unaddressed");
  });

  test("AT3 control, inner edge: an invocation on the LAST in-window turn counts", () => {
    // Pins the boundary itself. Paired with the test above, an off-by-one in
    // either direction fails one of the two.
    const lines: TranscriptLine[] = [
      prompt("p-flagged"),
      assistantText(FLAGGED_PHRASE),
      ...padTurns(LOOKBACK - 1),
      prompt("p-edge"),
      SKILL_CALL,
      prompt("p-now"),
    ];
    const { findings } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings[0]?.disposition).toBe("acted");
  });

  test("AT4: the explicit decline marker → declined, its own class", () => {
    const lines: TranscriptLine[] = [
      prompt("p-flagged"),
      assistantText(FLAGGED_PHRASE),
      assistantText("[not-a-retrospective: the phrase was quoting the principal, not my own work]"),
      prompt("p-now"),
    ];
    const { findings } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings[0]?.disposition).toBe("declined");
    // Three states, distinguishable — the evaluation-loop RFC's Position 4.
    expect(new Set(["acted", "declined", "artifact-only", "unaddressed"]).size).toBe(4);
  });

  test("the window stays open while it is still open — no premature finding", () => {
    const lines: TranscriptLine[] = [
      prompt("p-flagged"),
      assistantText(FLAGGED_PHRASE),
      MEMORY_PATCH,
      prompt("p-now"),
    ];
    const { findings, reportedKeys } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings).toEqual([]);
    expect(reportedKeys).toEqual([]);
  });

  test("the in-flight turn is never reported on", () => {
    // The flagged turn IS the one whose prompt is being submitted now.
    const lines: TranscriptLine[] = [prompt("p-flagged"), assistantText(FLAGGED_PHRASE)];
    const { findings } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings).toEqual([]);
  });

  test("an already-reported turn is not reported twice", () => {
    const lines: TranscriptLine[] = [
      prompt("p-flagged"),
      assistantText(FLAGGED_PHRASE),
      ...padTurns(LOOKBACK + 1),
      prompt("p-now"),
    ];
    const flagged = new Set([FLAGGED_KEY, flagKey("p-flagged", DISCHARGE_REPORTED_FAMILY, "")]);
    const { findings } = analyzeDischarge(lines, flagged, LOOKBACK);
    expect(findings).toEqual([]);
  });

  /**
   * AT5 — a turn the scan cannot resolve is not silently dropped.
   *
   * It is reported as `unresolved` rather than as `degraded`, because the scan
   * COMPLETED and correctly declined to judge — the expected outcome for a turn
   * that rolled out of the visible transcript. Degrading it would fire on every
   * long session; dropping it silently would hide a store/transcript drift.
   */
  test("AT5: a turn key absent from the transcript is skipped AND counted, not guessed", () => {
    const lines: TranscriptLine[] = [prompt("p-other"), assistantText("hi"), prompt("p-now")];
    const { findings, unresolved } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings).toEqual([]);
    expect(unresolved).toEqual(["p-flagged"]);
  });

  test("AT5 control: a resolvable turn contributes nothing to unresolved", () => {
    // Without this pair, `unresolved` could be unconditionally populated and
    // AT5 would still pass.
    const lines: TranscriptLine[] = [
      prompt("p-flagged"),
      assistantText(FLAGGED_PHRASE),
      SKILL_CALL,
      prompt("p-now"),
    ];
    const { unresolved } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(unresolved).toEqual([]);
  });

  test("AT5: a transcript with no real prompts at all reports every flagged turn unresolved", () => {
    const { findings, unresolved } = analyzeDischarge(
      [assistantText("no prompts here")],
      new Set([FLAGGED_KEY]),
      LOOKBACK
    );
    expect(findings).toEqual([]);
    expect(unresolved).toEqual(["p-flagged"]);
  });

  test("an empty flag set does no transcript work", () => {
    const { findings, reportedKeys } = analyzeDischarge([], new Set(), LOOKBACK);
    expect(findings).toEqual([]);
    expect(reportedKeys).toEqual([]);
  });

  test("tool_result lines do not split the window", () => {
    // A tool_result is role=user but not a real prompt (mem#528). If it were
    // treated as a boundary, turnsElapsed would overcount and the window would
    // close early.
    const lines: TranscriptLine[] = [
      prompt("p-flagged"),
      assistantText(FLAGGED_PHRASE),
      toolResult(),
      toolResult(),
      toolResult(),
      SKILL_CALL,
      prompt("p-now"),
    ];
    const { findings } = analyzeDischarge(lines, new Set([FLAGGED_KEY]), LOOKBACK);
    expect(findings[0]?.disposition).toBe("acted");
  });

  test("two flagged turns are reported independently", () => {
    const lines: TranscriptLine[] = [
      prompt("p-a"),
      assistantText("first admission"),
      prompt("p-b"),
      assistantText("second admission"),
      SKILL_CALL,
      ...padTurns(LOOKBACK + 1),
      prompt("p-now"),
    ];
    const { findings } = analyzeDischarge(
      lines,
      new Set([flagKey("p-a", "R1", "first"), flagKey("p-b", "R2", "second")]),
      LOOKBACK
    );
    const byTurn = new Map(findings.map((f) => [f.turnKey, f.disposition]));
    // p-a's window covers p-b's skill call, so it is satisfied too — the
    // window is forward-looking from each flagged turn.
    expect(byTurn.get("p-a")).toBe("acted");
    expect(byTurn.get("p-b")).toBe("acted");
  });
});
