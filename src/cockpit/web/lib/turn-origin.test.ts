/**
 * mt#3374 — the turn-origin classifier.
 *
 * The property under test throughout: a turn is labeled `user` only when the
 * operator actually wrote something in it. Every other role-`user` turn on
 * either pipeline is harness plumbing and says so.
 */
import { describe, test, expect } from "bun:test";
import { classifyTurnOrigin } from "./turn-origin";
import type { PreparedElement } from "../components/ConversationElementRenderers";
import {
  INJECTED_KIND_NOUN,
  splitInjectedContent,
  type InjectedContentKind,
} from "./injected-content";

function injected(kind: InjectedContentKind): PreparedElement {
  return { kind: "injected", span: { kind, label: `${kind}: x`, content: "…" } };
}
function text(value: string): PreparedElement {
  return { kind: "text", text: value };
}
function toolResultOrphan(): PreparedElement {
  return {
    kind: "tool-result-orphan",
    result: { kind: "tool-result", text: "ok" } as PreparedElement & { kind: "tool-result" },
    callName: "Read",
  } as PreparedElement;
}

function userTurn(elements: PreparedElement[], isMeta?: boolean) {
  return isMeta === undefined ? { role: "user", elements } : { role: "user", elements, isMeta };
}

describe("classifyTurnOrigin — operator-authored turns", () => {
  test("prose the operator typed is theirs", () => {
    expect(classifyTurnOrigin(userTurn([text("what changed in the last hour?")]))).toEqual({
      kind: "operator",
    });
  });

  test("prose wins when an injected prefix precedes it", () => {
    // The injected span still collapses on its own, so labeling the turn the
    // operator's hides nothing — and the message IS theirs.
    const turn = userTurn([injected("command"), text("...and also check the logs")]);
    expect(classifyTurnOrigin(turn)).toEqual({ kind: "operator" });
  });

  test("whitespace-only text is not prose", () => {
    expect(classifyTurnOrigin(userTurn([text("   \n  "), injected("skill-body")]))).toEqual({
      kind: "harness",
      label: "skill body",
    });
  });
});

describe("classifyTurnOrigin — per-origin harness labels", () => {
  test.each([
    ["command", "command"],
    ["skill-body", "skill body"],
    ["system-reminder", "system reminder"],
    ["local-command-output", "command output"],
    ["local-command-caveat", "harness caveat"],
  ] as const)("a %s turn is labeled %s", (kind, label) => {
    expect(classifyTurnOrigin(userTurn([injected(kind)]))).toEqual({ kind: "harness", label });
  });

  test("every injected kind's turn label is the span's own noun — no second vocabulary", () => {
    // PR #2442 R1: a hand-maintained parallel label map drifted (`command
    // caveat` vs the span's `harness caveat`). Both now read one source; this
    // fails if a future kind is added to one and not the other.
    for (const kind of Object.keys(INJECTED_KIND_NOUN) as InjectedContentKind[]) {
      expect(classifyTurnOrigin(userTurn([injected(kind)]))).toEqual({
        kind: "harness",
        label: INJECTED_KIND_NOUN[kind],
      });
    }
  });

  test("a pure tool-result turn is labeled tool result, not user", () => {
    expect(classifyTurnOrigin(userTurn([toolResultOrphan()]))).toEqual({
      kind: "harness",
      label: "tool result",
    });
  });

  test("a merged command invocation is labeled command", () => {
    const turn = userTurn([
      {
        kind: "command-invocation",
        command: { kind: "command", label: "command: /plan-task", content: "…" },
      } as PreparedElement,
    ]);
    expect(classifyTurnOrigin(turn)).toEqual({ kind: "harness", label: "command" });
  });

  test("a turn mixing several harness origins degrades to the general term", () => {
    // Labeling it with only one of its origins would be actively misleading.
    const turn = userTurn([injected("skill-body"), injected("system-reminder")]);
    expect(classifyTurnOrigin(turn)).toEqual({ kind: "harness", label: "harness" });
  });

  test("isMeta marks a turn as harness when nothing else classifies it", () => {
    expect(classifyTurnOrigin(userTurn([], true))).toEqual({ kind: "harness", label: "harness" });
  });
});

describe("classifyTurnOrigin — isMeta outranks prose (mt#3809)", () => {
  // The harness writes its own `isMeta` lines that CARRY TEXT — a coordinate
  // note beside a pasted screenshot, a skill's base-directory preamble, a
  // re-invocation note. Before mt#3809 the prose check ran first, so every one
  // of them was labeled as a message the operator typed, and the `isMeta`
  // branch below it was unreachable for anything but an empty turn.
  const IMAGE_COORDINATE_NOTE =
    "[Image: original 3840x1936, displayed at 2000x1008. Multiply coordinates by 1.92 to map to original image.]";

  test("the pasted-screenshot coordinate note is harness-origin, not the operator's", () => {
    expect(classifyTurnOrigin(userTurn([text(IMAGE_COORDINATE_NOTE)], true))).toEqual({
      kind: "harness",
      label: "harness",
    });
  });

  test("a skill's base-directory preamble is harness-origin", () => {
    const preamble = text("Base directory for this skill: /Users/x/.claude/skills/plan-task");
    expect(classifyTurnOrigin(userTurn([preamble], true))).toEqual({
      kind: "harness",
      label: "harness",
    });
  });

  test("an isMeta turn keeps its specific span label rather than degrading", () => {
    // Precedence 1 outranks prose, but it still consults the span
    // classification — a caveat says `harness caveat`, not the general term.
    const turn = userTurn([injected("local-command-caveat"), text("Caveat: the messages …")], true);
    expect(classifyTurnOrigin(turn)).toEqual({ kind: "harness", label: "harness caveat" });
  });

  test("prose still wins for a turn the harness did NOT mark as its own", () => {
    // The mt#3374 mixed-turn case: an injected prefix plus the operator's typed
    // continuation is still the operator's message. Reordering must not eat it.
    const turn = userTurn([injected("system-reminder"), text("actually, do it the other way")]);
    expect(classifyTurnOrigin(turn)).toEqual({ kind: "operator" });
  });

  test("an isMeta turn mixing several harness origins degrades to the general term", () => {
    // PR #2698 R1: precedence 1 borrows the span label, so it inherits the
    // same degrade-rather-than-pick-a-winner rule the non-meta path has.
    const turn = userTurn([injected("skill-body"), injected("system-reminder")], true);
    expect(classifyTurnOrigin(turn)).toEqual({ kind: "harness", label: "harness" });
  });

  test("an absent isMeta is not a falsy isMeta", () => {
    expect(classifyTurnOrigin(userTurn([text("ship it")], false))).toEqual({ kind: "operator" });
  });
});

describe("classifyTurnOrigin — no signal", () => {
  test("assistant turns are never reclassified", () => {
    expect(classifyTurnOrigin({ role: "assistant", elements: [text("hello")] })).toBeNull();
  });

  test("an unclassifiable user turn keeps its existing styling rather than being promoted", () => {
    // Returning null (not `operator`) is the point: silently promoting unknown
    // content to the operator's label is the defect this module removes.
    expect(classifyTurnOrigin(userTurn([]))).toBeNull();
  });
});

describe("classifyTurnOrigin — bash-mode turns, end to end (mt#4058)", () => {
  // The hand-built `injected(kind)` helper above cannot catch this defect: it
  // presupposes the classification that was missing. These cases start from the
  // RAW transcript text, which is what actually reached the renderer and came
  // back labeled as the operator's own message.
  function turnFromRawText(raw: string) {
    const elements: PreparedElement[] = splitInjectedContent(raw).map((seg) =>
      seg.type === "prose" ? { kind: "text", text: seg.text } : { kind: "injected", span: seg.span }
    );
    return classifyTurnOrigin(userTurn(elements));
  }

  test("captured terminal output is NOT attributed to the operator", () => {
    // The originating screenshot: this turn contains none of the operator's
    // words and rendered under their label.
    expect(
      turnFromRawText(
        "<bash-stdout>OPENED minsky://conversation/efb04b87</bash-stdout><bash-stderr></bash-stderr>"
      )
    ).toEqual({ kind: "harness", label: "command output" });
  });

  test("a stderr-only turn is labeled as an error, not as the operator", () => {
    expect(turnFromRawText("<bash-stdout></bash-stdout><bash-stderr>boom</bash-stderr>")).toEqual({
      kind: "harness",
      label: "command error",
    });
  });

  test("the command the operator typed is labeled as a bash command", () => {
    expect(turnFromRawText("<bash-input> minsky cockpit open</bash-input>")).toEqual({
      kind: "harness",
      label: "bash command",
    });
  });

  test("a bash turn carrying the operator's own continuation stays theirs", () => {
    expect(turnFromRawText("<bash-input> ls</bash-input>\nwhy did that print nothing?")).toEqual({
      kind: "operator",
    });
  });
});

// ── mt#4354: the dispatch brief, a THIRD author class ─────────────────────────
//
// A generated subagent dispatch prompt is neither the operator's nor the
// harness's — the PARENT AGENT composed it. The signal is `userOrigin`, carried
// from mt#4289's classifier. The property under test: a positive non-`human`
// value outranks the prose rule, and `"human"` never does.
describe("mt#4354 — dispatch-brief origin", () => {
  const DISPATCH_PROSE =
    "You are working on mt#4351 in session ws#412.\n\n## Operating Envelope\n…";

  test("a dispatch brief is its own author class, not the operator", () => {
    // Without `userOrigin` this exact turn is operator prose — that is the
    // defect. The column is what distinguishes it.
    expect(
      classifyTurnOrigin({
        role: "user",
        elements: [text(DISPATCH_PROSE)],
        userOrigin: "dispatch_brief",
      })
    ).toEqual({ kind: "dispatch", label: "dispatch brief" });
  });

  test("the same turn WITHOUT the signal still reads as the operator", () => {
    // The negative control for the test above: it pins that `userOrigin` is
    // what moved the verdict, not something incidental about the prose.
    expect(classifyTurnOrigin({ role: "user", elements: [text(DISPATCH_PROSE)] })).toEqual({
      kind: "operator",
    });
  });

  test('"human" is the fail-open default and does NOT override prose', () => {
    expect(
      classifyTurnOrigin({ role: "user", elements: [text("fix the header")], userOrigin: "human" })
    ).toEqual({ kind: "operator" });
  });

  test("operator prose QUOTING a watermark is still the operator (mt#3405 hazard)", () => {
    // A live instance, not a hypothetical: `tasks decompose|estimate|analyze`
    // emit `<!-- minsky:task-prompt:v1 -->` in prompts generated FOR A HUMAN TO
    // PASTE, so a watermark-bearing turn on that path genuinely IS the operator.
    // This is the whole difference between reading a first-party marker and
    // pattern-matching prose — `check-prompt-watermark` already false-positives
    // on exactly this shape.
    expect(
      classifyTurnOrigin({
        role: "user",
        elements: [
          text("why does this prompt end with <!-- minsky:task-prompt:v1 --> ? is that a bug?"),
        ],
        userOrigin: "human",
      })
    ).toEqual({ kind: "operator" });
  });

  test("an origin kind this build has never seen renders, and is not the operator", () => {
    // `UserTextOrigin` is `string`, not an enum, so a harness kind can appear
    // without a migration. It must degrade to a readable non-operator label
    // rather than throwing or silently reading as operator speech.
    expect(
      classifyTurnOrigin({
        role: "user",
        elements: [text("some future harness payload")],
        userOrigin: "some_future_kind",
      })
    ).toEqual({ kind: "harness", label: "some future kind" });
  });

  test("a dispatch brief outranks isMeta", () => {
    expect(
      classifyTurnOrigin({
        role: "user",
        elements: [text(DISPATCH_PROSE)],
        isMeta: true,
        userOrigin: "dispatch_brief",
      })
    ).toEqual({ kind: "dispatch", label: "dispatch brief" });
  });
});

// ── PR #3574 R1 (non-blocking): run-grouping key shape ────────────────────────
//
// `ActorKey` in ConversationTurnView changed from a single `harnessLabel` to
// `originKind` + `originLabel`. The reviewer asked whether that can split runs
// that previously grouped. It cannot, and this pins why: BOTH fields are derived
// from the same `classifyTurnOrigin` result the old `harnessLabel` was derived
// from, by the same rule — labeled kinds carry their label, everything else
// carries null. So two turns that agreed under the old key still agree under the
// new one, and the ONLY new split is `dispatch`, which is the point of the task.
describe("PR #3574 R1 — grouping inputs are unchanged for pre-existing kinds", () => {
  const labeled = (o: ReturnType<typeof classifyTurnOrigin>) =>
    o?.kind === "harness" || o?.kind === "dispatch"
      ? { originKind: o.kind, originLabel: o.label }
      : { originKind: null, originLabel: null };

  test("an operator turn contributes a null key, as before", () => {
    expect(labeled(classifyTurnOrigin({ role: "user", elements: [text("hi")] }))).toEqual({
      originKind: null,
      originLabel: null,
    });
  });

  test("an unclassifiable turn contributes a null key, as before", () => {
    expect(labeled(classifyTurnOrigin({ role: "user", elements: [] }))).toEqual({
      originKind: null,
      originLabel: null,
    });
  });

  test("two harness turns with the SAME origin still produce equal keys", () => {
    const a = labeled(
      classifyTurnOrigin({ role: "user", elements: [injected("system-reminder")] })
    );
    const b = labeled(
      classifyTurnOrigin({ role: "user", elements: [injected("system-reminder")] })
    );
    expect(a).toEqual(b);
    expect(a.originKind).toBe("harness");
  });

  test("two harness turns with DIFFERENT origins still produce unequal keys", () => {
    const a = labeled(
      classifyTurnOrigin({ role: "user", elements: [injected("system-reminder")] })
    );
    const b = labeled(classifyTurnOrigin({ role: "user", elements: [injected("skill-body")] }));
    expect(a).not.toEqual(b);
  });

  test("a dispatch brief does NOT group with a harness turn — the one intended new split", () => {
    const brief = labeled(
      classifyTurnOrigin({ role: "user", elements: [text("x")], userOrigin: "dispatch_brief" })
    );
    const harness = labeled(
      classifyTurnOrigin({ role: "user", elements: [injected("system-reminder")] })
    );
    expect(brief).not.toEqual(harness);
    expect(brief.originKind).toBe("dispatch");
  });
});
