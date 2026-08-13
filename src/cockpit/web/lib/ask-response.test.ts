/**
 * Recorded-answer classification tests (mt#4091).
 *
 * One case per rung of the ladder in `ask-response.ts`, plus the two
 * option-matching paths that differ only in where the payload's value came
 * from. Pure functions over fixtures — no DOM, no fetch.
 *
 * Run via `bun run test:components` — `bunfig.toml`'s `pathIgnorePatterns`
 * excludes `src/cockpit/web/**` from the main runner, so a bare `bun test` on
 * this path reports "did not match any test files" rather than failing.
 */

import { describe, test, expect } from "bun:test";
import { describeRecordedAnswer, resolveChosenOption } from "./ask-response";
import type { AskItem, AskOption } from "../widgets/AskDetail";

function makeAsk(overrides: Partial<AskItem> = {}): AskItem {
  return {
    id: "a902cba7-fd37-464a-842f-96fe38fe8bcc",
    kind: "direction.decide",
    state: "closed",
    title: "Production storage bucket",
    question: "Should I create the production storage bucket?",
    requestor: "agent",
    routingTarget: "operator",
    createdAt: "2026-08-12T10:00:00.000Z",
    windowMissedCount: 0,
    metadata: {},
    ...overrides,
  };
}

/**
 * An option as it exists in the STORE for asks predating `askOptionSchema`'s
 * value normalization: no `value` at all.
 *
 * The declared `AskOption` type requires `value`, so this shape is not
 * expressible without a cast — but the shape is real, which is exactly why
 * `composeResolvePayload` carries an mt#3181 branch for it and why
 * `resolveChosenOption` falls back to matching on the label. The type is
 * optimistic relative to the rows actually in the store; the cast is the honest
 * way to write a fixture for them rather than a way around a type error.
 */
function legacyOption(label: string): AskOption {
  return { label } as unknown as AskOption;
}

/** The option ask#7754 was actually answered with; asserted against by label. */
const HOLD_LABEL = "Hold off on production storage";

/** The live shape of ask#7754 — the ask whose loss originated this task. */
const VALUED_OPTIONS = [
  { label: "Here's the key — go ahead", value: "approve", description: "You supply the key." },
  { label: HOLD_LABEL, value: "hold", description: "Nothing is created." },
  { label: "Use a separate project instead", value: "separate-project" },
];

describe("resolveChosenOption (mt#4091)", () => {
  test("matches the payload's `chosen` against an option's value", () => {
    const ask = makeAsk({
      options: VALUED_OPTIONS,
      response: { responder: "operator", payload: { chosen: "hold", option: "hold" } },
    });
    expect(resolveChosenOption(ask)?.index).toBe(1);
  });

  test("matches against an option's LABEL when it was stored without a value (mt#3181 path)", () => {
    // `composeResolvePayload` writes the label into the payload for an option
    // carrying no `value`. A value-only lookup silently misses these — which is
    // the whole reason this case is separated from the one above.
    const ask = makeAsk({
      options: [legacyOption("Approve the rotation"), legacyOption(HOLD_LABEL)],
      response: {
        responder: "operator",
        payload: { chosen: HOLD_LABEL, option: HOLD_LABEL },
      },
    });
    expect(resolveChosenOption(ask)?.index).toBe(1);
  });

  test("ignores a producer-supplied letter prefix on either side (mt#3253)", () => {
    const ask = makeAsk({
      options: [legacyOption("A — Approve"), legacyOption("B — Hold")],
      response: { responder: "operator", payload: { chosen: "Hold" } },
    });
    expect(resolveChosenOption(ask)?.index).toBe(1);
  });

  test("returns null when the recorded value matches no option", () => {
    const ask = makeAsk({
      options: VALUED_OPTIONS,
      response: { responder: "operator", payload: { chosen: "something-else" } },
    });
    expect(resolveChosenOption(ask)).toBeNull();
  });

  test("returns null for an ask with no options at all", () => {
    const ask = makeAsk({ response: { responder: "operator", payload: { chosen: "hold" } } });
    expect(resolveChosenOption(ask)).toBeNull();
  });
});

describe("describeRecordedAnswer ladder (mt#4091)", () => {
  test("no response recorded", () => {
    expect(describeRecordedAnswer(makeAsk({ state: "expired" }))).toEqual({ kind: "none" });
  });

  test("operator option choice resolves to the option's label and description", () => {
    const answer = describeRecordedAnswer(
      makeAsk({
        options: VALUED_OPTIONS,
        response: { responder: "operator", payload: { chosen: "hold", option: "hold" } },
      })
    );
    expect(answer).toEqual({
      kind: "option",
      label: HOLD_LABEL,
      description: "Nothing is created.",
    });
  });

  test("optionless authorization approval", () => {
    const approved = describeRecordedAnswer(
      makeAsk({
        kind: "authorization.approve",
        response: { responder: "operator", payload: { approved: true } },
      })
    );
    expect(approved).toEqual({ kind: "approval", approved: true });

    const denied = describeRecordedAnswer(
      makeAsk({
        kind: "authorization.approve",
        response: { responder: "operator", payload: { approved: false } },
      })
    );
    expect(denied).toEqual({ kind: "approval", approved: false });
  });

  test("free-text disposition", () => {
    const answer = describeRecordedAnswer(
      makeAsk({ response: { responder: "operator", payload: { message: "Handled in chat." } } })
    );
    expect(answer).toEqual({ kind: "message", message: "Handled in chat." });
  });

  test("policy resolution is its own rung, NOT a system closure", () => {
    // `isAutomatedClosureResponder` deliberately excludes `policy`: a covering
    // policy IS an answer, so presenting it as "nobody answered" would be wrong.
    const answer = describeRecordedAnswer(
      makeAsk({
        response: { responder: "policy", payload: { citation: "commit-auth standing grant" } },
      })
    );
    expect(answer).toEqual({ kind: "policy", citation: "commit-auth standing grant" });
  });

  test("system closure names the signal in plain words and keeps the payload as detail", () => {
    const answer = describeRecordedAnswer(
      makeAsk({
        response: {
          responder: "system:parent-task-terminal",
          payload: { sweep: "stale-suspended-close", task: "mt#3001", parentTaskId: "mt#3210" },
        },
      })
    );
    expect(answer).toEqual({
      kind: "systemClosure",
      signal: "the parent task reached a terminal status",
      detail: [
        { key: "sweep", value: "stale-suspended-close" },
        { key: "task", value: "mt#3001" },
        { key: "parentTaskId", value: "mt#3210" },
      ],
    });
  });

  test("an automated closure is not preempted by an operator-answer payload shape", () => {
    // The rung is keyed on the RESPONDER and checked first, so a system closure
    // that happens to carry `{approved}` or `{chosen}` still reads as "nobody
    // answered this" rather than being phrased as an operator decision
    // (PR #2961 R1).
    const withApproved = describeRecordedAnswer(
      makeAsk({
        response: { responder: "system:pr-merged", payload: { approved: true, prNumber: 2961 } },
      })
    );
    expect(withApproved).toMatchObject({ kind: "systemClosure" });

    const withChosen = describeRecordedAnswer(
      makeAsk({
        options: VALUED_OPTIONS,
        response: { responder: "system:commit-landed", payload: { chosen: "hold" } },
      })
    );
    expect(withChosen).toMatchObject({ kind: "systemClosure" });
  });

  test("an unrecognized system responder falls back to its own string as the signal", () => {
    const answer = describeRecordedAnswer(
      makeAsk({ response: { responder: "system:invented-later", payload: { thing: "x" } } })
    );
    expect(answer).toMatchObject({ kind: "systemClosure", signal: "system:invented-later" });
  });

  test("a sweep responder outside the system: convention lands on its message, not a closure", () => {
    // `stale-sweep-mt2747` (508 asks) predates the `system:<event>` convention,
    // so `isAutomatedClosureResponder` does not match it. Rendering its message
    // attributed to that responder is honest; widening the predicate here would
    // diverge from the mt#3215 single source of truth.
    const answer = describeRecordedAnswer(
      makeAsk({
        response: { responder: "stale-sweep-mt2747", payload: { message: "Swept as stale." } },
      })
    );
    expect(answer).toEqual({ kind: "message", message: "Swept as stale." });
  });

  test("an unrecognized shape from a non-system responder is the only JSON-dump rung", () => {
    const answer = describeRecordedAnswer(
      makeAsk({ response: { responder: "operator", payload: { somethingNew: 42 } } })
    );
    expect(answer).toEqual({ kind: "raw", json: JSON.stringify({ somethingNew: 42 }, null, 2) });
  });

  test("a non-object payload does not crash the ladder", () => {
    const answer = describeRecordedAnswer(
      makeAsk({ response: { responder: "operator", payload: "just a string" } })
    );
    expect(answer).toEqual({ kind: "raw", json: JSON.stringify("just a string", null, 2) });
  });
});
