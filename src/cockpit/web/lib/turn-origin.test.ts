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
import { INJECTED_KIND_NOUN, type InjectedContentKind } from "./injected-content";

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
