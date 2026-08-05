/**
 * Tests for the turn-address codec + DOM lookup (mt#3791).
 *
 * The lookup half runs against happy-dom's `document`, which is enough here:
 * these assertions are about attribute matching and containment, not geometry
 * (happy-dom has no layout engine — the scroll behavior these anchors serve is
 * asserted by `scripts/verify-conversation-turn-target.ts` over CDP instead).
 */
import { describe, expect, test } from "bun:test";
import {
  findAddressedElement,
  parseTurnAddress,
  TOOL_USE_ANCHOR_ATTR,
  TURN_ANCHOR_ATTR,
  turnAddressSearch,
} from "./conversation-turn-address";

describe("parseTurnAddress", () => {
  test("reads a turn-grain address", () => {
    expect(parseTurnAddress("?turn=42")).toEqual({ turnIndex: 42 });
  });

  test("reads a tool-grain address", () => {
    expect(parseTurnAddress("?turn=42&toolUse=toolu_01ABC")).toEqual({
      turnIndex: 42,
      toolUseId: "toolu_01ABC",
    });
  });

  test("turn 0 is a real address, not a missing one", () => {
    expect(parseTurnAddress("?turn=0")).toEqual({ turnIndex: 0 });
  });

  test("no turn param means no address", () => {
    expect(parseTurnAddress("")).toBeNull();
    expect(parseTurnAddress("?p=mt%233791")).toBeNull();
  });

  test("coexists with an unrelated param", () => {
    expect(parseTurnAddress("?p=mt%233791&turn=7")).toEqual({ turnIndex: 7 });
  });

  // The malformed cases matter because `Number` would silently accept them and
  // land the reader on a turn nobody named.
  test.each([["?turn="], ["?turn=abc"], ["?turn=3x"], ["?turn=-1"], ["?turn=1.5"]])(
    "%s is malformed, not turn 0",
    (search) => {
      expect(parseTurnAddress(search)).toBeNull();
    }
  );

  test("an empty toolUse is dropped rather than matched against nothing", () => {
    expect(parseTurnAddress("?turn=3&toolUse=")).toEqual({ turnIndex: 3 });
  });

  test("accepts URLSearchParams as well as a string", () => {
    expect(parseTurnAddress(new URLSearchParams({ turn: "9" }))).toEqual({ turnIndex: 9 });
  });
});

describe("turnAddressSearch", () => {
  test("round-trips a turn-grain address", () => {
    const search = turnAddressSearch({ turnIndex: 42 });
    expect(search).toBe("?turn=42");
    expect(parseTurnAddress(search)).toEqual({ turnIndex: 42 });
  });

  test("round-trips a tool-grain address", () => {
    const address = { turnIndex: 42, toolUseId: "toolu_01ABC" };
    expect(parseTurnAddress(turnAddressSearch(address))).toEqual(address);
  });

  test("encodes a tool id that needs escaping", () => {
    const address = { turnIndex: 1, toolUseId: "a b&c=d" };
    expect(turnAddressSearch(address)).toBe("?turn=1&toolUse=a+b%26c%3Dd");
    expect(parseTurnAddress(turnAddressSearch(address))).toEqual(address);
  });
});

function container(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("findAddressedElement", () => {
  const dom = () =>
    container(`
      <div ${TURN_ANCHOR_ATTR}="4" id="turn-4">
        <div ${TOOL_USE_ANCHOR_ATTR}="toolu_A" id="call-a"></div>
        <div ${TOOL_USE_ANCHOR_ATTR}="toolu_B" id="call-b"></div>
      </div>
      <div ${TURN_ANCHOR_ATTR}="5" id="turn-5"></div>
    `);

  test("finds the addressed turn", () => {
    expect(findAddressedElement(dom(), { turnIndex: 5 })?.id).toBe("turn-5");
  });

  test("finds the addressed call within its turn — not the turn, not a sibling", () => {
    const found = findAddressedElement(dom(), { turnIndex: 4, toolUseId: "toolu_B" });
    expect(found?.id).toBe("call-b");
  });

  test("a call id in a DIFFERENT turn does not match", () => {
    // Guards against a lookup that searched the whole container for the call
    // id: turn 5 holds no calls, so the answer must be turn 5 itself.
    expect(findAddressedElement(dom(), { turnIndex: 5, toolUseId: "toolu_A" })?.id).toBe("turn-5");
  });

  test("an unresolvable call degrades to its turn", () => {
    expect(findAddressedElement(dom(), { turnIndex: 4, toolUseId: "toolu_GONE" })?.id).toBe(
      "turn-4"
    );
  });

  test("an unresolvable turn returns null", () => {
    expect(findAddressedElement(dom(), { turnIndex: 99 })).toBeNull();
  });
});
