import { describe, test, expect } from "bun:test";

import { linkifyDelta, linkifyLine } from "./entity-linkify";
import { decideDisplay } from "./linkify-message-display";
import { parseMinskyUri } from "../../src/cockpit/web/lib/entity-codec";

/** Convenience: run a single complete line through the delta transform. */
function line(text: string, inFence = false): string {
  return linkifyDelta(`${text}\n`, { inFence }).text.replace(/\n$/, "");
}

describe("linkifyDelta — what it rewrites", () => {
  test("links a bare task ref", () => {
    expect(line("see mt#2565 for detail")).toBe(
      "see [mt#2565](minsky://task/mt%232565) for detail"
    );
  });

  test("links EVERY occurrence, not just the first", () => {
    const out = line("mt#1 then mt#2 then mt#1 again");
    expect(out).toBe(
      "[mt#1](minsky://task/mt%231) then [mt#2](minsky://task/mt%232) then [mt#1](minsky://task/mt%231) again"
    );
  });

  test("links a PR ref to the changeset type", () => {
    expect(line("landed in PR #2749")).toBe("landed in [PR #2749](minsky://changeset/2749)");
  });

  test("leaves a bare #N alone — it carries no entity id", () => {
    expect(line("issue #2749 is unrelated")).toBe("issue #2749 is unrelated");
  });

  test("every emitted URI round-trips through parseMinskyUri", () => {
    const out = line("mt#2565 and PR #2749");
    const targets = [...out.matchAll(/\]\((minsky:\/\/[^)]+)\)/g)].map((m) => m[1] as string);
    expect(targets).toHaveLength(2);
    expect(parseMinskyUri(targets[0] as string)).toEqual({ type: "task", id: "mt#2565" });
    expect(parseMinskyUri(targets[1] as string)).toEqual({ type: "changeset", id: "2749" });
  });
});

describe("linkifyDelta — what it must not touch", () => {
  test("an already-linked ref is not double-linked", () => {
    const already = "see [mt#2565](minsky://task/mt%232565) for detail";
    expect(line(already)).toBe(already);
  });

  test("a ref inside an inline code span is left alone", () => {
    expect(line("the id `mt#2565` is a literal")).toBe("the id `mt#2565` is a literal");
  });

  test("a ref inside a blockquote is left alone", () => {
    expect(line("> quoting mt#2565 from the spec")).toBe("> quoting mt#2565 from the spec");
  });

  test("a reference-style link label is left alone", () => {
    const refLink = "see [mt#2565][spec] for detail";
    expect(line(refLink)).toBe(refLink);
  });

  test("a reference-style link definition is left alone", () => {
    const definition = "[mt#2565]: https://example.test/spec";
    expect(line(definition)).toBe(definition);
  });

  test("an image's alt text and target are left alone", () => {
    const image = "![mt#2565 diagram](https://example.test/mt#2565.png)";
    expect(line(image)).toBe(image);
  });

  test("a ref inside a bare URL is left alone", () => {
    const url = "https://example.test/mt#2565";
    expect(line(url)).toBe(url);
  });

  test("a ref inside a fence opened and closed in the same delta is left alone", () => {
    const delta = "```\nmt#2565\n```\nand mt#2566 outside\n";
    expect(linkifyDelta(delta, { inFence: false }).text).toBe(
      "```\nmt#2565\n```\nand [mt#2566](minsky://task/mt%232566) outside\n"
    );
  });

  test("prose after a fence closes is linkified again", () => {
    const { text, state } = linkifyDelta("```\nmt#1\n```\nmt#2\n", { inFence: false });
    expect(state.inFence).toBe(false);
    expect(text).toContain("[mt#2](minsky://task/mt%232)");
    expect(text).toContain("\nmt#1\n");
  });
});

describe("linkifyDelta — the cross-delta fence case", () => {
  test("carries the open-fence flag out of a delta that opens a fence", () => {
    const { state } = linkifyDelta("here is the spec:\n```md\n", { inFence: false });
    expect(state.inFence).toBe(true);
  });

  test("a ref inside a fence that opened in an EARLIER delta is left alone", () => {
    const { text } = linkifyDelta("quoted mt#2565 inside the fence\n", { inFence: true });
    expect(text).toBe("quoted mt#2565 inside the fence\n");
  });

  test("the closing fence clears the flag and later prose links again", () => {
    const first = linkifyDelta("mt#1 still fenced\n```\n", { inFence: true });
    expect(first.text).toBe("mt#1 still fenced\n```\n");
    expect(first.state.inFence).toBe(false);
    const second = linkifyDelta("mt#2 is prose\n", first.state);
    expect(second.text).toBe("[mt#2](minsky://task/mt%232) is prose\n");
  });
});

describe("linkifyDelta — partial trailing lines", () => {
  test("a trailing fragment is left alone mid-stream", () => {
    const { text } = linkifyDelta("done mt#1\nstill writing mt#2", { inFence: false });
    expect(text).toBe("done [mt#1](minsky://task/mt%231)\nstill writing mt#2");
  });

  test("a trailing fragment IS rewritten on the final flush", () => {
    const { text } = linkifyDelta("last line mt#2", { inFence: false }, { final: true });
    expect(text).toBe("last line [mt#2](minsky://task/mt%232)");
  });
});

describe("linkifyLine", () => {
  test("rewrites around, but never inside, a protected span", () => {
    expect(linkifyLine("mt#1 `mt#2` mt#3")).toBe(
      "[mt#1](minsky://task/mt%231) `mt#2` [mt#3](minsky://task/mt%233)"
    );
  });
});

describe("decideDisplay", () => {
  const base = {
    session_id: "s",
    cwd: "/tmp",
    hook_event_name: "MessageDisplay",
    message_id: "m1",
    index: 0,
  };

  test("emits nothing when the delta contains no rewritable ref", () => {
    const { display } = decideDisplay({ ...base, delta: "nothing to link here\n" }, null);
    expect(display).toBeNull();
  });

  test("emits the rewritten delta and carries the fence state forward", () => {
    const { display, nextState } = decideDisplay({ ...base, delta: "mt#5\n```\n" }, null);
    expect(display).toBe("[mt#5](minsky://task/mt%235)\n```\n");
    // mt#4145 added the running tally to this record; assert the display-relevant
    // fields rather than the whole shape, so a future bookkeeping field does not
    // break a test about fence carrying.
    expect(nextState?.messageId).toBe("m1");
    expect(nextState?.inFence).toBe(true);
  });

  test("consumes carried state belonging to the same message", () => {
    const { display } = decideDisplay(
      { ...base, index: 1, delta: "mt#5 fenced\n" },
      { messageId: "m1", inFence: true }
    );
    expect(display).toBeNull();
  });

  test("ignores carried state from a DIFFERENT message", () => {
    const { display } = decideDisplay(
      { ...base, message_id: "m2", delta: "mt#5 is prose\n" },
      { messageId: "m1", inFence: true }
    );
    expect(display).toBe("[mt#5](minsky://task/mt%235) is prose\n");
  });

  test("clears the carried state on the final flush", () => {
    const { nextState } = decideDisplay(
      { ...base, delta: "", final: true },
      {
        messageId: "m1",
        inFence: true,
      }
    );
    expect(nextState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Short-id resolution (mt#3914)
// ---------------------------------------------------------------------------

const ASK_UUID = "b3a3da5f-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const MEM_UUID = "1aa78e4a-5148-461c-b3a0-e7bba039d704";
const WS_UUID = "525dae4d-fd35-48fb-ad5a-d899865a9cb5";

const MAP = {
  ask: { "6891": ASK_UUID },
  memory: { "623": MEM_UUID },
  session: { "12": WS_UUID },
};

/** The one line used by both the resolution test and its negative control. */
const ASK_LINE = "see ask#6891 for the decision";

/** Convenience: one complete line through the transform WITH a map. */
function mapped(text: string, shortIdMap: Record<string, Record<string, string>> = MAP): string {
  return linkifyDelta(`${text}\n`, { inFence: false }, { shortIdMap }).text.replace(/\n$/, "");
}

describe("linkifyDelta — short-id resolution", () => {
  test("links a mapped ask ref to its UUID", () => {
    expect(mapped(ASK_LINE)).toBe(`see [ask#6891](minsky://ask/${ASK_UUID}) for the decision`);
  });

  test("maps mem# to the memory type and ws# to the session type", () => {
    expect(mapped("mem#623 and ws#12")).toBe(
      `[mem#623](minsky://memory/${MEM_UUID}) and [ws#12](minsky://session/${WS_UUID})`
    );
  });

  test("leaves an UNMAPPED short id bare", () => {
    expect(mapped("mem#999 is not in the map")).toBe("mem#999 is not in the map");
  });

  test("NEGATIVE CONTROL: the same ref stays bare against an empty map", () => {
    // The control for the resolution path: with no entries, the assertion above
    // (a rendered link) is unreachable — so a passing link test cannot be
    // passing for an unrelated reason.
    expect(mapped(ASK_LINE, {})).toBe(ASK_LINE);
  });

  test("leaves every short id bare when no map is supplied at all", () => {
    expect(line("ask#6891 and mem#623 and ws#12")).toBe("ask#6891 and mem#623 and ws#12");
  });

  test("never emits the short id itself as the target", () => {
    const out = mapped("ask#6891 and mem#999");
    expect(out).not.toContain("minsky://ask/ask%236891");
    expect(out).not.toContain("minsky://memory/mem%23999");
  });

  test("emitted target round-trips through parseMinskyUri", () => {
    const out = mapped("ask#6891");
    const uri = out.slice(out.indexOf("(") + 1, out.lastIndexOf(")"));
    expect(parseMinskyUri(uri)).toEqual({ type: "ask", id: ASK_UUID });
  });

  test("still links task refs on the same line", () => {
    expect(mapped("mt#3914 tracks ask#6891")).toBe(
      `[mt#3914](minsky://task/mt%233914) tracks [ask#6891](minsky://ask/${ASK_UUID})`
    );
  });

  test("respects fenced code blocks", () => {
    const out = linkifyDelta("ask#6891\n", { inFence: true }, { shortIdMap: MAP }).text;
    expect(out).toBe("ask#6891\n");
  });

  test("respects inline code spans and existing links", () => {
    expect(mapped("`ask#6891` stays")).toBe("`ask#6891` stays");
    expect(mapped("[ask#6891](minsky://ask/other) stays")).toBe(
      "[ask#6891](minsky://ask/other) stays"
    );
  });

  test("skips an entry whose UUID is empty rather than emitting an empty target", () => {
    expect(mapped("ask#5", { ask: { "5": "" } })).toBe("ask#5");
  });
});
