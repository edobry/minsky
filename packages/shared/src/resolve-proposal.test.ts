/**
 * Tests for the agent-proposed-resolve marker parser (mt#3368).
 *
 * The parser is a trust boundary — untrusted model output feeding a control that
 * mutates an ask — so the bulk of these cases are rejections.
 */
import { describe, expect, test } from "bun:test";
import { RESOLVE_PROPOSAL_FENCE, parseResolveProposal } from "./resolve-proposal";

/** Build a well-formed marker around an arbitrary body. */
function fenced(body: string): string {
  return `\`\`\`${RESOLVE_PROPOSAL_FENCE}\n${body}\n\`\`\``;
}

describe("parseResolveProposal", () => {
  test("extracts the option letter and rationale", () => {
    const result = parseResolveProposal(
      `Here is what I found.\n\n${fenced('{"optionLetter": "B", "rationale": "the branch is stale"}')}`
    );
    expect(result).toEqual({ optionLetter: "B", rationale: "the branch is stale" });
  });

  test("a proposal without a rationale is still valid", () => {
    expect(parseResolveProposal(fenced('{"optionLetter": "A"}'))).toEqual({ optionLetter: "A" });
  });

  test("prose with no marker yields null", () => {
    expect(
      parseResolveProposal("I looked into it and I don't think you should approve.")
    ).toBeNull();
  });

  test("the LAST marker wins when the agent reconsiders mid-reply", () => {
    const text = `${fenced('{"optionLetter": "A"}')}\n\nActually, on reflection:\n\n${fenced('{"optionLetter": "C"}')}`;
    expect(parseResolveProposal(text)?.optionLetter).toBe("C");
  });

  test("a bare json fence is NOT a proposal", () => {
    // An agent explaining an ask quotes JSON constantly; if a bare fence counted,
    // every such quote would render as a live resolve control.
    expect(parseResolveProposal('```json\n{"optionLetter": "B"}\n```')).toBeNull();
  });

  test("malformed JSON renders as prose rather than throwing", () => {
    expect(parseResolveProposal(fenced('{"optionLetter": "B",'))).toBeNull();
  });

  test("rejects a missing optionLetter", () => {
    expect(parseResolveProposal(fenced('{"rationale": "because"}'))).toBeNull();
  });

  test("rejects a non-string optionLetter", () => {
    expect(parseResolveProposal(fenced('{"optionLetter": 2}'))).toBeNull();
  });

  test("rejects a multi-character or lowercase letter", () => {
    expect(parseResolveProposal(fenced('{"optionLetter": "AB"}'))).toBeNull();
    expect(parseResolveProposal(fenced('{"optionLetter": "b"}'))).toBeNull();
    expect(parseResolveProposal(fenced('{"optionLetter": ""}'))).toBeNull();
  });

  test("rejects a JSON array or scalar body", () => {
    expect(parseResolveProposal(fenced('["A"]'))).toBeNull();
    expect(parseResolveProposal(fenced('"A"'))).toBeNull();
    expect(parseResolveProposal(fenced("null"))).toBeNull();
  });

  test("drops a blank rationale rather than carrying an empty string", () => {
    expect(parseResolveProposal(fenced('{"optionLetter": "A", "rationale": "   "}'))).toEqual({
      optionLetter: "A",
    });
  });

  test("ignores a non-string rationale instead of rejecting the proposal", () => {
    expect(parseResolveProposal(fenced('{"optionLetter": "A", "rationale": 7}'))).toEqual({
      optionLetter: "A",
    });
  });

  test("CRLF line endings parse identically to LF", () => {
    // PR #2465 R1 non-blocking raised this as a suspected failure. It is not:
    // `\s*` before the required `\n` absorbs the `\r`, the lazy body capture is
    // newline-agnostic, and JSON.parse treats a trailing `\r\n` as whitespace.
    // Pinned as a test rather than argued, so the claim is settled either way.
    const crlf = `\`\`\`${
      RESOLVE_PROPOSAL_FENCE
    }\r\n{"optionLetter": "B", "rationale": "stale"}\r\n\`\`\``;
    expect(parseResolveProposal(crlf)).toEqual({ optionLetter: "B", rationale: "stale" });
  });

  test("repeated calls are independent — the shared regex's lastIndex is reset", () => {
    // Guards the classic global-regex bug: a retained lastIndex would make every
    // other call miss the first marker in the string.
    const text = fenced('{"optionLetter": "D"}');
    expect(parseResolveProposal(text)?.optionLetter).toBe("D");
    expect(parseResolveProposal(text)?.optionLetter).toBe("D");
    expect(parseResolveProposal(text)?.optionLetter).toBe("D");
  });
});
