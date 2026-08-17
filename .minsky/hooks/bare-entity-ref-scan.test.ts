// Fixtures for the mt#3286 bare-entity-ref scanner. Every must-not-flag case
// in the spec's Acceptance Tests has a test here, because the FP classes are
// what decide whether an advisory detector is trusted (mem#719: a detector
// emitting unmatchable output erodes trust in its correct output).

import { describe, test, expect } from "bun:test";
import {
  partitionAuthorLinkedShortIds,
  scanMessage,
  shortIdsNeedingResolution,
} from "./bare-entity-ref-scan";
import { linkifyLine, type ShortIdMap } from "./entity-linkify";

const kinds = (r: ReturnType<typeof scanMessage>) => r.flagged.map((f) => f.kind);
const refs = (r: ReturnType<typeof scanMessage>) => r.flagged.map((f) => f.ref);

describe("bare-entity-ref scanner — flagged classes", () => {
  // Updated expectation (mt#3897): bare `mt#N` / `PR #N` are RECORDED, not
  // flagged. `entity-linkify.ts` (mt#2565) rewrites both into deeplinks at
  // display time, so warning about them asks the agent to hand-fix something
  // already fixed downstream. Operator decision: ask#7639.
  test("bare mt#N with no link is recorded, not flagged", () => {
    const r = scanMessage("I finished mt#1234 and it looks good.");
    expect(r.flagged).toHaveLength(0);
    expect(r.logged.map((f) => f.ref)).toEqual(["mt#1234"]);
    expect(r.logged.map((f) => f.kind)).toEqual(["bare-ref"]);
  });

  test("bare PR #N with no link is recorded, not flagged", () => {
    const r = scanMessage("Merged PR #2633 this morning.");
    expect(r.flagged).toHaveLength(0);
    expect(r.logged.map((f) => f.ref)).toEqual(["PR #2633"]);
  });

  test("malformed ask target (8-hex prefix) fires — ADR-029", () => {
    const r = scanMessage("See [ask#6930](minsky://ask/fa4b942e) for the decision.");
    expect(kinds(r)).toContain("malformed-target");
  });

  test("raw-UUID-fragment label fires even when the target is a valid UUID", () => {
    const r = scanMessage(
      "See [ask#…86ac1dbe](minsky://ask/86ac1dbe-6a20-4e76-9736-665bef1d0c59)."
    );
    expect(kinds(r)).toContain("raw-uuid-label");
    // The target itself is well-formed, so the malformed-target class must NOT
    // also fire — these are distinct defects and must stay distinguishable.
    expect(kinds(r)).not.toContain("malformed-target");
  });
});

describe("bare-entity-ref scanner — must NOT flag", () => {
  test("a linked mt#N does not fire", () => {
    const r = scanMessage("Shipped [mt#1234](minsky://task/mt%231234) today.");
    expect(r.flagged).toHaveLength(0);
  });

  test("linked at first mention, bare on repetition in the same message — compliant", () => {
    const r = scanMessage(
      "Shipped [mt#1234](minsky://task/mt%231234). Later, mt#1234 also needed a rebase."
    );
    expect(r.flagged).toHaveLength(0);
  });

  test("a ref inside a fenced code block does not fire", () => {
    const r = scanMessage(
      ["Here is the log:", "```", "fix(mt#1234): do the thing", "```"].join("\n")
    );
    expect(r.flagged).toHaveLength(0);
  });

  test("a ref inside an inline code span does not fire", () => {
    const r = scanMessage("Run `git log --grep=mt#1234` to see it.");
    expect(r.flagged).toHaveLength(0);
  });

  test("a ref inside a blockquote does not fire", () => {
    const r = scanMessage("> the spec says mt#1234 is the owner");
    expect(r.flagged).toHaveLength(0);
  });

  test('non-entity "PR #" prose does not fire', () => {
    const r = scanMessage("Every PR # in GitHub is just an integer.");
    expect(r.flagged).toHaveLength(0);
  });

  test("a well-formed ask link with a decimal short-id label does not fire", () => {
    const r = scanMessage(
      "See [ask#6984](minsky://ask/86ac1dbe-6a20-4e76-9736-665bef1d0c59) for the call."
    );
    expect(r.flagged).toHaveLength(0);
  });

  test("a linked PR does not fire", () => {
    const r = scanMessage("Merged [PR #2633](minsky://changeset/2633).");
    expect(r.flagged).toHaveLength(0);
  });
});

describe("bare-entity-ref scanner — short-id families (mt#3897)", () => {
  // Updated expectation (mt#3897): these are now the FLAGGED classes. Their
  // deeplink target is a UUID (ADR-029), which the display linkifier cannot
  // derive from the label without an id-set lookup it does not do — so a bare
  // one still costs the reader a lookup. Operator decision: ask#7415.
  test("bare ask#N is flagged", () => {
    const r = scanMessage("Pending: ask#6891, ask#6916 and ask#6932.");
    expect(refs(r)).toEqual(["ask#6891", "ask#6916", "ask#6932"]);
    expect(kinds(r)).toEqual(["bare-short-id", "bare-short-id", "bare-short-id"]);
  });

  test("bare mem#N and ws#N are flagged", () => {
    const r = scanMessage("Recorded in mem#623; workspace ws#12 holds the session.");
    expect(refs(r)).toEqual(["mem#623", "ws#12"]);
  });

  test("a bare short id inside a code fence is neither flagged nor logged", () => {
    const r = scanMessage(["```", "ask#6891", "```"].join("\n"));
    expect(r.flagged).toHaveLength(0);
    expect(r.logged).toHaveLength(0);
  });

  // The precision the flip makes load-bearing. A correctly-linked short id
  // still contains the literal text `ask#7415` inside its label, so a scan that
  // ignores POSITION would flag every properly-linked ref in the corpus — the
  // v0 code could use a coarse type-level check precisely because it never
  // flagged. These pin the positional check (`collectLinkLabelRanges`).
  test("a linked short id does not fire, even beside an unrelated bare one", () => {
    const r = scanMessage(
      "See [ask#7415](minsky://ask/639b443a-411e-4e88-a03a-beac836cd8aa); also mem#623."
    );
    expect(refs(r)).toEqual(["mem#623"]);
  });

  test("linked at first mention, bare on repetition — compliant, mirroring the mt# rule", () => {
    const r = scanMessage(
      "See [ask#7415](minsky://ask/639b443a-411e-4e88-a03a-beac836cd8aa). Later, ask#7415 again."
    );
    expect(r.flagged).toHaveLength(0);
  });

  test("a short id linked under the WRONG entity type still fires", () => {
    // `[mem#623](minsky://ask/…)` links an ask, not a memory — the label is not
    // made clickable-to-the-right-place by a mismatched target.
    const r = scanMessage("See [mem#623](minsky://ask/639b443a-411e-4e88-a03a-beac836cd8aa).");
    expect(refs(r)).toContain("mem#623");
  });
});

describe("bare-entity-ref scanner — PR #2717 R1 findings", () => {
  test("malformed percent-encoding in a task target does not throw", () => {
    // decodeURIComponent throws URIError on `%2`. Unguarded, this took the
    // whole scan down for the turn — and the input is arbitrary assistant
    // prose, so half-written links are reachable in practice.
    expect(() => scanMessage("See [mt#1](minsky://task/mt%2) for context.")).not.toThrow();
  });

  test("an undecodable task link does not count as linking the ref", () => {
    // Degrades to "the ref looks bare" — the conservative direction for an
    // advisory — rather than silently treating the entity as linked. The
    // finding now lands in `logged` rather than `flagged` (mt#3897), but the
    // degradation direction under test is unchanged.
    const r = scanMessage("See [mt#1234](minsky://task/mt%2) for context.");
    expect(r.logged.map((f) => f.ref)).toContain("mt#1234");
  });

  test("a long DECIMAL short-id label is never flagged as a UUID fragment", () => {
    // The old pattern matched any 6+ char hex-ish tail and relied on a later
    // exemption to rescue decimals. Six-digit and longer short ids are the
    // exact case that made the exemption load-bearing.
    for (const label of ["ask#123456", "mem#1234567", "ws#999999"]) {
      const r = scanMessage(`See [${label}](minsky://ask/86ac1dbe-6a20-4e76-9736-665bef1d0c59).`);
      expect(kinds(r)).not.toContain("raw-uuid-label");
    }
  });

  test("a non-hex word label is left alone — the class only claims what it can prove", () => {
    const r = scanMessage("See [ask#overview](minsky://ask/86ac1dbe-6a20-4e76-9736-665bef1d0c59).");
    expect(kinds(r)).not.toContain("raw-uuid-label");
  });
});

describe("bare-entity-ref scanner — the R6 message shape", () => {
  // The closing report that produced R6: task and PR refs correctly linked,
  // ask refs bare.
  //
  // This fixture is the whole point of the detector, and it is where the v0
  // posture was self-defeating: R6 is a message that handed the operator three
  // asks they could not open, and v0 reported NOTHING on it — every class it
  // enforced was compliant, and the one class that was not was carved out. The
  // old tests pinned that silence deliberately, "so the carve-out's cost is
  // visible rather than asserted in prose."
  //
  // mt#3897 pays that cost down: the three bare asks now flag, and the linked
  // task/PR refs still do not. R6 is exactly the shape the flip was approved
  // for, so it is the strongest single check that the new posture works.
  const r6 = [
    "Both handoff items are merged and DONE.",
    "Fixed and merged ([mt#2878](minsky://task/mt%232878), [PR #2633](minsky://changeset/2633)).",
    "I closed [mt#3035](minsky://task/mt%233035) as a duplicate.",
    "Tracked as [mt#3707](minsky://task/mt%233707).",
    "The nag will keep firing until ask#6891, ask#6916 and ask#6932 clear your inbox.",
  ].join("\n");

  test("R6's three unclickable asks now flag — the gap the detector exists to close", () => {
    expect(refs(scanMessage(r6))).toEqual(["ask#6891", "ask#6916", "ask#6932"]);
  });

  test("R6's correctly-linked task and PR refs still do not flag", () => {
    // The other half of the posture: the classes the linkifier handles must
    // stay quiet, so the advisory names only what the reader actually cannot
    // click. A regression here would re-introduce the 13-of-13 false-warning
    // rate ask#7639 was filed about.
    expect(kinds(scanMessage(r6))).not.toContain("bare-ref");
  });
});

describe("bare-entity-ref scanner — short ids the display map resolves (mt#3960)", () => {
  // mt#3914 gave the display linkifier a short-id -> UUID map, so a mapped ref
  // is already clickable when the reader sees it. Flagging it asks the author
  // to fix something that is not broken — 5 of the first 6 injected phrases
  // after mt#3914 were exactly that.
  const MEM_928_UUID = "33855c14-a2b5-4b03-9b5d-7726f8f15e33";
  const MEM_552_UUID = "b0b294ab-69cc-45fd-9f05-031bfb910d9c";
  const MAP: ShortIdMap = { memory: { "928": MEM_928_UUID } };

  test("a mapped short id is recorded, not flagged", () => {
    const r = scanMessage("Continues mem#928 from yesterday.", { shortIdMap: MAP });
    expect(r.flagged).toHaveLength(0);
    expect(r.logged).toEqual([
      {
        kind: "linkable-short-id",
        ref: "mem#928",
        reason: "resolved by the short-id map (auto-linked at display time)",
      },
    ]);
  });

  test("an unmapped short id still flags", () => {
    const r = scanMessage("Continues mem#944 from yesterday.", { shortIdMap: MAP });
    expect(refs(r)).toEqual(["mem#944"]);
    expect(kinds(r)).toEqual(["bare-short-id"]);
  });

  test("a mixed message flags only the unmapped id", () => {
    const r = scanMessage("Continues mem#928; see also mem#944.", { shortIdMap: MAP });
    expect(refs(r)).toEqual(["mem#944"]);
    expect(r.logged.map((f) => f.ref)).toEqual(["mem#928"]);
  });

  test("the map is per-family — a memory entry does not resolve the same number as an ask", () => {
    // The map is keyed by URI type then number, so `ask#928` and `mem#928` are
    // different entities that happen to share a numeral. Collapsing the two
    // would suppress a real finding on the strength of an unrelated id.
    const r = scanMessage("Pending: ask#928.", { shortIdMap: MAP });
    expect(refs(r)).toEqual(["ask#928"]);
  });

  test("no map flags every short id — the pre-mt#3914 behavior", () => {
    // The degradation an absent or unreadable cache must produce. Silence here
    // would be the ADR-024 "silent-skip" failure: under-linking costs the
    // reader a lookup, a suppressed finding costs them the ref entirely.
    const text = "Continues mem#928 and mem#944.";
    expect(refs(scanMessage(text))).toEqual(["mem#928", "mem#944"]);
    expect(refs(scanMessage(text, {}))).toEqual(["mem#928", "mem#944"]);
    expect(refs(scanMessage(text, { shortIdMap: {} }))).toEqual(["mem#928", "mem#944"]);
    expect(refs(scanMessage(text, { shortIdMap: { ask: {} } }))).toEqual(["mem#928", "mem#944"]);
  });

  test("a malformed map entry does not suppress — it is not a resolution (PR #2839 R1)", () => {
    // The scanner's suppression must match the linkifier's rewrite condition
    // EXACTLY. `replaceRefs` refuses to link a non-string or empty entry, so a
    // scanner that accepted "any defined value" would go quiet about a ref that
    // stays bare on screen — a silent miss, the one direction this guard must
    // never fail in. Both now call `resolveShortId`, so they cannot diverge.
    const broken = {
      memory: { "928": "", "944": null as unknown as string, "552": 12345 as unknown as string },
    };
    const r = scanMessage("mem#928, mem#944 and mem#552.", { shortIdMap: broken });
    expect(refs(r)).toEqual(["mem#928", "mem#944", "mem#552"]);
    expect(r.logged).toHaveLength(0);
  });

  test("a mapped id written INSIDE a correct link is still not double-counted", () => {
    // `[mem#928](minsky://memory/<uuid>)` contains the literal `mem#928`, and
    // the positional check (mt#3897) is what stops it flagging. That check runs
    // BEFORE the map lookup, so a correctly-linked ref must not now appear in
    // the logged population either — it is neither a finding nor a suppression.
    const r = scanMessage(`See [mem#928](minsky://memory/${MEM_928_UUID}).`, { shortIdMap: MAP });
    expect(r.flagged).toHaveLength(0);
    expect(r.logged).toHaveLength(0);
  });

  test("negative control: the 2026-08-11 window replays to exactly one finding", () => {
    // The three phrases this guard actually injected on 2026-08-11, against a
    // map snapshot holding the two ids that existed before the fires and not
    // the one minted 15 seconds before its own. Only mem#944 should survive.
    const snapshot: ShortIdMap = { memory: { "552": MEM_552_UUID, "928": MEM_928_UUID } };
    const window = "Continues mem#928 (mem#944 supersedes it); background in mem#552.";
    const r = scanMessage(window, { shortIdMap: snapshot });
    expect(refs(r)).toEqual(["mem#944"]);
    expect(r.logged.map((f) => f.ref)).toEqual(["mem#928", "mem#552"]);
    // Without the map every one of the three flags — which is what the guard
    // did on the day, and the 2-of-3 false-positive rate that produced mt#3960.
    expect(refs(scanMessage(window))).toEqual(["mem#928", "mem#944", "mem#552"]);
  });

  test("suppression and display-time linking agree on every entry shape (PR #2839 R1)", () => {
    // The coupling itself, asserted rather than described. This guard's whole
    // claim is "the reader will already see a link here", so the two decisions
    // must be the same decision. Sharing `resolveShortId` makes that true by
    // construction; this pins it against a future edit to either side.
    const entries: Array<[string, unknown]> = [
      ["good", MEM_928_UUID],
      ["empty", ""],
      ["null", null],
      ["number", 12345],
      ["absent", undefined],
    ];
    const text = "See mem#928.";
    for (const [label, value] of entries) {
      const byNumber: Record<string, string> = {};
      if (value !== undefined) byNumber["928"] = value as string;
      const map: ShortIdMap = { memory: byNumber };
      const suppressed = scanMessage(text, { shortIdMap: map }).flagged.length === 0;
      const linked = linkifyLine(text, map).includes("minsky://memory/");
      expect(`${label}:${suppressed}`).toBe(`${label}:${linked}`);
    }
  });
});

// mt#4160 — a short id whose own entity is already deeplinked in the same
// message. Every fixture below is the VERBATIM judged text of a real fire,
// recovered from the session transcript at or before its timestamp; none is
// paraphrased or trimmed. mem#1020: a detector fixture that reaches no matcher
// passes a negative assertion vacuously AND survives its own negative control,
// so each must-not-flag case here is preceded by a liveness assertion proving
// the fixture still fires before the suppression is applied.
describe("bare-entity-ref scanner — author-linked short ids (mt#4160)", () => {
  // Fire 2026-08-16T21:14:28Z, session 6b2b7665. The `/handoff` closing line:
  // the link label is a prose title and the short id trails it in parentheses,
  // so `collectLinkLabelRanges` cannot see that both name the same entity.
  const MEM_1045 =
    "Handoff recorded: [cockpit SQLSTATE classifier → gate-battery premise correction](minsky://memory/c748bf8f-5ac5-4026-a5a7-91f7b55f2031) — memory `c748bf8f` (mem#1045).";
  const MEM_1045_UUID = "c748bf8f-5ac5-4026-a5a7-91f7b55f2031";

  // Fire 2026-08-11T22:42:06Z, session 25a27bdb — the same template, a
  // different entity, five days earlier.
  const MEM_962 =
    "Handoff recorded: [interception taxonomy + thin-hooks RFC](minsky://memory/764137ed-5887-498a-9647-79de8c630156) — memory `764137ed` (mem#962).";
  const MEM_962_UUID = "764137ed-5887-498a-9647-79de8c630156";

  // Fire 2026-08-13T20:44:22Z, session 7f08191d. The ONE case in the measured
  // window where the link and a second bare mention sit in different
  // paragraphs — the fixture that discriminates message scope from line scope.
  const MEM_1024 =
    "Handoff recorded: [cockpit passkey gate + share links — closed](minsky://memory/4ea01db6-f006-4472-a0e5-03a340139eaa) — memory `4ea01db6` (mem#1024). Written and live-verified minutes ago.\n\n" +
    "**New session.** This conversation spans three days, two merged features, a security finding, and ten skill/rule files changed underneath it. mt#3268 needs none of that context — only its own spec and mem#1024.";
  const MEM_1024_UUID = "4ea01db6-f006-4472-a0e5-03a340139eaa";

  // Fire 2026-08-12T00:32:43Z, session ab3a7ed7 — a REAL positive. The message
  // carries no minsky:// link of any type.
  const MEM_968 = "2. **mem#968** — bridge until mt#4014 ships.";

  // Fire 2026-08-13T20:53:23Z, session 93e98f39 — a REAL positive.
  const MEM_1026 =
    "Filed: **mt#4123** (the styling), **mt#4124** (the gate), **mem#1026** (the bridge).";

  test("AT1 — the fixture fires today, and the suppression removes it", () => {
    const scan = scanMessage(MEM_1045);
    // Liveness FIRST (mem#1020): assert the fixture reaches the matcher before
    // asserting anything about its absence.
    expect(refs(scan)).toEqual(["mem#1045"]);
    expect(kinds(scan)).toEqual(["bare-short-id"]);

    const { flagged, authorLinked } = partitionAuthorLinkedShortIds(
      scan.flagged,
      scan.linkTargets,
      new Map([["mem#1045", MEM_1045_UUID]])
    );
    expect(flagged).toHaveLength(0);
    expect(authorLinked.map((f) => f.ref)).toEqual(["mem#1045"]);
    expect(authorLinked.map((f) => f.kind)).toEqual(["author-linked-short-id"]);
  });

  test("AT2 — a link to a DIFFERENT entity does not suppress (identity, not adjacency)", () => {
    const scan = scanMessage(MEM_1045);
    expect(refs(scan)).toEqual(["mem#1045"]);

    // Same message, same position, same distance — only the ENTITY differs.
    const { flagged, authorLinked } = partitionAuthorLinkedShortIds(
      scan.flagged,
      scan.linkTargets,
      new Map([["mem#1045", MEM_962_UUID]])
    );
    expect(flagged.map((f) => f.ref)).toEqual(["mem#1045"]);
    expect(authorLinked).toHaveLength(0);
  });

  test("AT3 — the real positives still fire (no minsky:// link to that entity)", () => {
    for (const [text, ref] of [
      [MEM_968, "mem#968"],
      [MEM_1026, "mem#1026"],
    ] as const) {
      const scan = scanMessage(text);
      expect(refs(scan)).toEqual([ref]);
      // Nothing to resolve: no link target of that type exists in the message.
      expect(shortIdsNeedingResolution(scan.flagged, scan.linkTargets)).toHaveLength(0);
      const { flagged } = partitionAuthorLinkedShortIds(scan.flagged, scan.linkTargets, new Map());
      expect(flagged.map((f) => f.ref)).toEqual([ref]);
    }
  });

  test("AT4 — suppression is MESSAGE-scoped: a later bare mention in another paragraph", () => {
    const scan = scanMessage(MEM_1024);
    expect(refs(scan)).toEqual(["mem#1024"]);

    const { flagged, authorLinked } = partitionAuthorLinkedShortIds(
      scan.flagged,
      scan.linkTargets,
      new Map([["mem#1024", MEM_1024_UUID]])
    );
    expect(flagged).toHaveLength(0);
    expect(authorLinked.map((f) => f.ref)).toEqual(["mem#1024"]);
  });

  test("AT5 — a suppressed finding names the UUID that matched", () => {
    const scan = scanMessage(MEM_962);
    expect(refs(scan)).toEqual(["mem#962"]);

    const { authorLinked } = partitionAuthorLinkedShortIds(
      scan.flagged,
      scan.linkTargets,
      new Map([["mem#962", MEM_962_UUID]])
    );
    expect(authorLinked[0]?.reason).toContain(MEM_962_UUID);
    expect(authorLinked[0]?.reason).toContain("minsky://memory/");
  });

  test("AT6 — an empty resolution map fails OPEN to today's behavior", () => {
    const scan = scanMessage(MEM_1045);
    expect(refs(scan)).toEqual(["mem#1045"]);

    // This is what a resolution failure looks like from here: no bindings.
    const { flagged, authorLinked } = partitionAuthorLinkedShortIds(
      scan.flagged,
      scan.linkTargets,
      new Map()
    );
    expect(flagged.map((f) => f.ref)).toEqual(["mem#1045"]);
    expect(authorLinked).toHaveLength(0);
  });

  test("the resolution gate skips a message with no link of the candidate's type", () => {
    // A task link is present, but the candidate is a memory — nothing its
    // resolved UUID could match, so no resolution is requested.
    const scan = scanMessage(
      "Filed [mt#4123](minsky://task/mt%234123) and mem#1026 as the bridge."
    );
    expect(refs(scan)).toEqual(["mem#1026"]);
    expect(shortIdsNeedingResolution(scan.flagged, scan.linkTargets)).toHaveLength(0);
  });

  test("the resolution gate requests exactly the candidate it can decide", () => {
    const scan = scanMessage(MEM_1045);
    expect(shortIdsNeedingResolution(scan.flagged, scan.linkTargets)).toEqual([
      { ref: "mem#1045", kind: "memory", num: "1045" },
    ]);
  });
});
