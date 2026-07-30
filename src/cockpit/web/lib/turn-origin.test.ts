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
