/**
 * Adapter tests for the secret-request-in-chat detector (mt#2428).
 *
 * The matcher's own tests live beside it in
 * `packages/domain/src/detectors/secret-request-in-chat.test.ts`. These cover
 * what the ADAPTER adds: turn extraction, the elision step, the two surfaces
 * being read from different places, and the advisory's content.
 */

import { describe, expect, test } from "bun:test";
import {
  buildInjectionReminder,
  evaluateTurn,
  extractOptionLabels,
  INJECTION_ENABLED,
  renderWorstCase,
} from "./secret-request-in-chat-detector";
import type { TranscriptLine } from "./transcript";

function assistantLine(content: Array<Record<string, unknown>>): TranscriptLine {
  return { type: "assistant", message: { role: "assistant", content } };
}

function textBlock(text: string): Record<string, unknown> {
  return { type: "text", text };
}

function toolUseBlock(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "tool_use", name, input };
}

function askLine(labels: string[]): TranscriptLine {
  return assistantLine([
    toolUseBlock("AskUserQuestion", {
      questions: [
        {
          question: "How should I get it?",
          header: "Credential",
          options: labels.map((label) => ({ label, description: "" })),
        },
      ],
    }),
  ]);
}

describe("secret-request-in-chat adapter — prose surface", () => {
  test("a real request in assistant text fires", () => {
    const e = evaluateTurn([assistantLine([textBlock("Paste your bot token here.")])]);
    expect(e.matched).toBe(true);
    expect(e.matches[0]?.surface).toBe("assistant-prose");
  });

  test("a clean turn does not fire", () => {
    const e = evaluateTurn([assistantLine([textBlock("Rebased and pushed; CI is green.")])]);
    expect(e.matched).toBe(false);
  });

  test("non-assistant lines are ignored", () => {
    const e = evaluateTurn([
      { type: "user", message: { role: "user", content: "paste your token here" } },
    ]);
    expect(e.matched).toBe(false);
  });
});

describe("secret-request-in-chat adapter — the elision step (mt#3987 step 2)", () => {
  /**
   * These are the quoted class, which the SHARED helper owns. The matcher's own
   * non-quotation suppressions are tested beside the matcher; the point here is
   * that the adapter actually runs the elision before matching.
   */
  test("a trigger phrase inside a fenced block does not fire", () => {
    const e = evaluateTurn([
      assistantLine([
        textBlock(
          "The rule's example is:\n\n```\nPaste your bot token here\n```\n\nDon't do that."
        ),
      ]),
    ]);
    expect(e.matched).toBe(false);
  });

  test("a trigger phrase inside an inline code span does not fire", () => {
    const e = evaluateTurn([
      assistantLine([textBlock("The pattern catches `paste your token` in prose.")]),
    ]);
    expect(e.matched).toBe(false);
  });

  test("a trigger phrase inside a double-quoted span does not fire", () => {
    const e = evaluateTurn([
      assistantLine([textBlock('The reviewer flagged "give me the API key" as the shape.')]),
    ]);
    expect(e.matched).toBe(false);
  });

  test("a trigger phrase in a blockquote does not fire", () => {
    const e = evaluateTurn([
      assistantLine([textBlock("> Paste your bot token here\n\nThat is the antipattern.")]),
    ]);
    expect(e.matched).toBe(false);
  });
});

describe("secret-request-in-chat adapter — ask option labels", () => {
  test("a credential-request option label fires", () => {
    const e = evaluateTurn([askLine(["Provide me the MCP auth token", "Something else"])]);
    expect(e.matched).toBe(true);
    expect(e.matches[0]?.surface).toBe("ask-option-label");
    expect(e.optionLabelCount).toBe(2);
  });

  test("option labels are NOT elided — a quoted label still fires", () => {
    // The opposite of the prose surface, deliberately. A label is the agent's
    // own proposal to the principal; it cannot be quoting a request, so eliding
    // its quoted span would delete signal rather than noise.
    const e = evaluateTurn([askLine(['Provide me the "MCP auth token"'])]);
    expect(e.matched).toBe(true);
  });

  test("a masked-surface option label does not fire", () => {
    const e = evaluateTurn([askLine(["Enter it in the masked credentials form"])]);
    expect(e.matched).toBe(false);
  });

  test("both surfaces in one turn are reported together", () => {
    const e = evaluateTurn([
      assistantLine([textBlock("Paste your bot token here.")]),
      askLine(["Give me the API key"]),
    ]);
    expect(e.matches.map((m) => m.surface).sort()).toEqual(["ask-option-label", "assistant-prose"]);
  });
});

describe("secret-request-in-chat adapter — extractOptionLabels is defensive", () => {
  test.each([
    ["undefined input", undefined],
    ["empty object", {}],
    ["questions not an array", { questions: "nope" }],
    ["question not an object", { questions: ["nope"] }],
    ["options not an array", { questions: [{ options: 3 }] }],
    ["option not an object", { questions: [{ options: [null] }] }],
    ["label not a string", { questions: [{ options: [{ label: 7 }] }] }],
    ["label blank", { questions: [{ options: [{ label: "   " }] }] }],
  ])("%s yields no labels", (_name, input) => {
    expect(extractOptionLabels(input as Record<string, unknown> | undefined)).toEqual([]);
  });

  test("a well-formed input yields its labels", () => {
    expect(
      extractOptionLabels({ questions: [{ options: [{ label: "a" }, { label: "b" }] }] })
    ).toEqual(["a", "b"]);
  });
});

describe("secret-request-in-chat adapter — the advisory", () => {
  const evaluation = {
    matched: true,
    matches: [
      { surface: "assistant-prose" as const, matchedPhrase: "paste your bot token", context: "" },
    ],
    suppressedBy: [],
    proseChars: 42,
    optionLabelCount: 0,
  };

  test("names credentials.request as the surface to use", () => {
    expect(buildInjectionReminder(evaluation)).toContain("credentials.request");
  });

  test("explicitly forbids config.credentials.add over MCP", () => {
    // The trap this detector exists downstream of: that tool looks like the
    // obvious answer and takes a `token` parameter, so an agent reaching for it
    // writes the secret into its own tool-call input (mt#4030).
    const text = buildInjectionReminder(evaluation);
    expect(text).toContain("config.credentials.add");
    expect(text).toContain("Do NOT");
  });

  test("quotes the matched phrase so the fire is checkable from the notification", () => {
    expect(buildInjectionReminder(evaluation)).toContain("paste your bot token");
  });

  test("carries a legitimate-halt branch", () => {
    expect(buildInjectionReminder(evaluation)).toContain("describing this antipattern");
  });

  test("does NOT claim retraction is a remedy", () => {
    expect(buildInjectionReminder(evaluation)).toContain("does not unsend it");
  });
});

describe("secret-request-in-chat adapter — posture and probe", () => {
  test("ships calibration-first", () => {
    // Flipping this is an enforcement-posture change and the operator's call
    // (mt#3769). A test pins it so the flip is deliberate rather than drifted.
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("renderWorstCase produces a bounded sample", () => {
    const rendered = renderWorstCase();
    expect(rendered.length).toBeGreaterThan(0);
    // Saturated on the match axis at the pattern count across both surfaces.
    expect(rendered).toContain("credentials.request");
  });
});
