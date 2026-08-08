// Fixtures for the mt#3286 bare-entity-ref scanner. Every must-not-flag case
// in the spec's Acceptance Tests has a test here, because the FP classes are
// what decide whether an advisory detector is trusted (mem#719: a detector
// emitting unmatchable output erodes trust in its correct output).

import { describe, test, expect } from "bun:test";
import { scanMessage } from "./bare-entity-ref-scan";

const kinds = (r: ReturnType<typeof scanMessage>) => r.flagged.map((f) => f.kind);
const refs = (r: ReturnType<typeof scanMessage>) => r.flagged.map((f) => f.ref);

describe("bare-entity-ref scanner — flagged v0 classes", () => {
  test("bare mt#N with no link fires", () => {
    const r = scanMessage("I finished mt#1234 and it looks good.");
    expect(refs(r)).toEqual(["mt#1234"]);
    expect(kinds(r)).toEqual(["bare-ref"]);
  });

  test("bare PR #N with no link fires", () => {
    const r = scanMessage("Merged PR #2633 this morning.");
    expect(refs(r)).toEqual(["PR #2633"]);
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

describe("bare-entity-ref scanner — log-only carve-out (v0)", () => {
  test("bare ask#N is logged, never flagged", () => {
    const r = scanMessage("Pending: ask#6891, ask#6916 and ask#6932.");
    expect(r.flagged).toHaveLength(0);
    expect(r.logged.map((f) => f.ref)).toEqual(["ask#6891", "ask#6916", "ask#6932"]);
  });

  test("bare mem#N and ws#N are logged, never flagged", () => {
    const r = scanMessage("Recorded in mem#623; workspace ws#12 holds the session.");
    expect(r.flagged).toHaveLength(0);
    expect(r.logged.map((f) => f.ref)).toEqual(["mem#623", "ws#12"]);
  });

  test("a bare short id inside a code fence is not even logged", () => {
    const r = scanMessage(["```", "ask#6891", "```"].join("\n"));
    expect(r.flagged).toHaveLength(0);
    expect(r.logged).toHaveLength(0);
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
    // advisory — rather than silently treating the entity as linked.
    const r = scanMessage("See [mt#1234](minsky://task/mt%2) for context.");
    expect(refs(r)).toContain("mt#1234");
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
  // ask refs bare. v0 must stay silent on the asks (carve-out) and must not
  // fire on the linked entities either — i.e. on R6 itself, v0 reports
  // nothing. That is the measured gap R6 recorded, pinned here so the
  // carve-out's cost is visible rather than asserted in prose.
  const r6 = [
    "Both handoff items are merged and DONE.",
    "Fixed and merged ([mt#2878](minsky://task/mt%232878), [PR #2633](minsky://changeset/2633)).",
    "I closed [mt#3035](minsky://task/mt%233035) as a duplicate.",
    "Tracked as [mt#3707](minsky://task/mt%233707).",
    "The nag will keep firing until ask#6891, ask#6916 and ask#6932 clear your inbox.",
  ].join("\n");

  test("v0 flags nothing on R6 — the enforced classes were all compliant", () => {
    expect(scanMessage(r6).flagged).toHaveLength(0);
  });

  test("v0 still records the three bare asks for calibration", () => {
    expect(scanMessage(r6).logged.map((f) => f.ref)).toEqual(["ask#6891", "ask#6916", "ask#6932"]);
  });
});
