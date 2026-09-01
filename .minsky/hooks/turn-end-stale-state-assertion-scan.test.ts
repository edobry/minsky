/**
 * Tests for the stale-state-assertion Stop scan (mt#4199).
 *
 * The guard is two halves and they are tested separately on purpose:
 *
 *  - `findPendingClaims` — the IO-free gate that decides whether a substrate
 *    read happens at all. Every precision property lives here.
 *  - `classifyResolved` — the pure terminal-vs-open decision, driven by two
 *    state maps rather than by a patched database (the `/implement-task` §6
 *    testable-design split).
 *
 * The acceptance tests in mt#4199's spec are named in the test titles they map
 * to, so a reader can check coverage against the spec without inferring it.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyResolved,
  collectAssertions,
  declaresResolution,
  RESOLUTION_DECLARATION_LEAD_WORDS,
  RESOLUTION_DECLARATION_PHRASES,
  collectEntityRefs,
  findPendingClaims,
  PROXIMITY_CHARS,
  refKey,
  TERMINAL_ASK_STATES,
  // mt#4580 — the Rung-2 climb
  findPeerHeldClaims,
  findUnbackedClaims,
  nominatePendingClaims,
  NOMINATION_EXEMPLARS,
  toolInputHaystack,
} from "./turn-end-stale-state-assertion-scan";

/** The literal shape of mem#669 R17's closing message — the originating case. */
const R17_MESSAGE =
  "mt#3711 is merged and live. Nothing else outstanding.\n\n" +
  "Still with you: ask#8467 — what mt#2430 should deliver now that the RFC option was declined.";

describe("collectEntityRefs", () => {
  test("collects bare ask and task refs with their offsets", () => {
    const refs = collectEntityRefs("see ask#8467 and mt#2430");

    expect(refs.map((r) => `${r.kind}:${r.id}`)).toEqual(["ask:8467", "task:mt#2430"]);
    expect(refs[0]?.at).toBeLessThan(refs[1]?.at ?? 0);
  });

  test("collects minsky:// link targets too — the union the planning audit required", () => {
    // A correctly-LINKED ref is the case `scanMessage`'s findings do not carry;
    // missing it would make the guard blind to exactly the well-formed messages
    // the cockpit-deeplink rules ask for.
    const refs = collectEntityRefs("[ask#8467](minsky://ask/2f747fc3-70e4-4e3c-952c-4af9c1eed01d)");

    expect(refs.some((r) => r.kind === "ask" && r.id === "8467")).toBe(true);
    expect(refs.some((r) => r.id.startsWith("2f747fc3"))).toBe(true);
  });

  test("ignores mem# and ws# — neither has a state that can await the principal", () => {
    expect(collectEntityRefs("see mem#669 and ws#372")).toEqual([]);
  });

  test("a malformed percent-escape is skipped, not thrown (PR #3061 R3)", () => {
    // `decodeURIComponent` throws a URIError on a bad escape, and the ref regex
    // admits `%` — so a truncated deeplink is ordinary untrusted prose that
    // would otherwise take the whole Stop guard down.
    for (const bad of ["minsky://task/mt%2", "minsky://ask/%ZZ", "minsky://task/%"]) {
      expect(() => collectEntityRefs(bad)).not.toThrow();
      expect(collectEntityRefs(bad)).toEqual([]);
    }
  });

  test("a well-formed percent-escape still decodes", () => {
    // The guard must not become so defensive it drops the NORMAL form: a task
    // deeplink percent-encodes its `#` by convention (`cockpit-deeplinks.mdc`).
    expect(collectEntityRefs("minsky://task/mt%232430")[0]?.id).toBe("mt#2430");
  });

  test("a malformed ref does not suppress a valid one beside it", () => {
    const refs = collectEntityRefs("minsky://task/mt%2 and ask#8467");
    expect(refs.map((r) => r.id)).toEqual(["8467"]);
  });

  test("dedupes repeated refs to the same entity", () => {
    const refs = collectEntityRefs("ask#8467 ... ask#8467 again");
    expect(refs).toHaveLength(1);
  });
});

describe("collectAssertions", () => {
  test("matches the R17 phrasing", () => {
    const found = collectAssertions(R17_MESSAGE);
    expect(found.map((a) => a.family)).toContain("still-with-you");
  });

  test("matches the paraphrases the family produces", () => {
    for (const phrase of [
      "this is waiting on you",
      "it needs your decision",
      "awaiting your answer",
      "that remains your call",
      "sitting in your inbox",
    ]) {
      expect(collectAssertions(phrase).length).toBeGreaterThan(0);
    }
  });

  test("does not match an ordinary status sentence", () => {
    expect(collectAssertions("I merged it and the deploy is healthy.")).toEqual([]);
  });
});

describe("findPendingClaims — the gate", () => {
  test("AT1 gate — the R17 message produces a claim naming the ask", () => {
    const claims = findPendingClaims(R17_MESSAGE);

    const askClaim = claims.find((c) => c.entity.kind === "ask");
    expect(askClaim).toBeDefined();
    expect(askClaim?.entity.id).toBe("8467");
    expect(askClaim?.assertion.family).toBe("still-with-you");
  });

  test("AT3 — a ref with no pending-on-principal claim produces nothing", () => {
    // The ref is present and correctly linked; nothing asserts it needs anyone.
    const claims = findPendingClaims(
      "Merged [ask#8467](minsky://ask/2f747fc3) as part of the cleanup. Nothing outstanding."
    );
    expect(claims).toEqual([]);
  });

  test("a pending phrase with no entity ref produces nothing", () => {
    expect(findPendingClaims("One thing is still with you — the naming call.")).toEqual([]);
  });

  test("proximity is required: a ref far from the phrase is not captured", () => {
    const far = `Still with you: the naming decision.\n\n${"x".repeat(PROXIMITY_CHARS + 50)}\n\nSeparately, ask#8467 is closed.`;
    expect(findPendingClaims(far)).toEqual([]);
  });

  test("a quoted or fenced ref does not trip the gate", () => {
    // A turn DISCUSSING this guard, or quoting a prior message, must not fire —
    // the same elision discipline the incident-scan sibling uses.
    const quoted = "The old message said:\n\n> Still with you: ask#8467\n\nThat was the bug.";
    expect(findPendingClaims(quoted)).toEqual([]);
  });
});

/** State map keyed the way `lookupLiveStates` builds it. */
function askShort(shortId: string, state: string, identity = `uuid-of-${shortId}`) {
  return new Map([[`ask:short:${shortId}`, { state, identity }]]);
}
function taskState(id: string, state: string) {
  return new Map([[`task:short:${id}`, { state, identity: id }]]);
}

describe("classifyResolved — the substrate decision", () => {
  const claims = findPendingClaims(R17_MESSAGE);

  test("AT1 — a closed ask asserted as pending is a contradiction", () => {
    const resolved = classifyResolved(claims, askShort("8467", "closed"));

    const ask = resolved.find((r) => r.entity.kind === "ask");
    expect(ask?.isTerminal).toBe(true);
    expect(ask?.liveState).toBe("closed");
    // The record must name the ref, what was asserted, and what is true.
    expect(ask?.entity.ref).toBe("ask#8467");
    expect(ask?.assertion.phrase.toLowerCase()).toContain("still with you");
  });

  test("AT2 — a suspended or routed ask is NOT a contradiction", () => {
    for (const openState of ["suspended", "routed"]) {
      const resolved = classifyResolved(claims, askShort("8467", openState));
      expect(resolved.find((r) => r.entity.kind === "ask")?.isTerminal).toBe(false);
    }
  });

  test("every terminal ask state is treated as terminal", () => {
    for (const state of TERMINAL_ASK_STATES) {
      const resolved = classifyResolved(claims, askShort("8467", state));
      expect(resolved.find((r) => r.entity.kind === "ask")?.isTerminal).toBe(true);
    }
  });

  test("AT4 — a task asserted as blocked on the principal, but DONE, is a contradiction", () => {
    const taskClaims = findPendingClaims("mt#2430 is still blocked on your decision.");
    const resolved = classifyResolved(taskClaims, taskState("mt#2430", "DONE"));

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.isTerminal).toBe(true);
    expect(resolved[0]?.liveState).toBe("DONE");
  });

  test("a task still in PLANNING is not a contradiction", () => {
    const taskClaims = findPendingClaims("mt#2430 is still blocked on your decision.");
    const resolved = classifyResolved(taskClaims, taskState("mt#2430", "PLANNING"));

    expect(resolved[0]?.isTerminal).toBe(false);
  });

  test("a ref the substrate cannot resolve is DROPPED, not treated as terminal", () => {
    // The failure direction that matters: an unresolved row must never become a
    // finding, or a lookup miss manufactures a contradiction.
    expect(classifyResolved(claims, new Map())).toEqual([]);
  });
});

/**
 * PR #3061 review, both BLOCKING findings. Refs arrive in two id-spaces —
 * `ask#N` is `asks.short_id`, a `minsky://ask/<uuid>` target is `asks.id` — and
 * the first cut queried only one, so a uuid-linked ref could never resolve and
 * the same ask named both ways counted twice.
 */
describe("two id-spaces (PR #3061 review)", () => {
  const BOTH_FORMS =
    "Still with you: [ask#8467](minsky://ask/2f747fc3-70e4-4e3c-952c-4af9c1eed01d) — your call.";

  test("a ref carries which id-space its identifier belongs to", () => {
    const refs = collectEntityRefs(BOTH_FORMS);

    expect(refs.find((r) => r.id === "8467")?.idForm).toBe("short");
    expect(refs.find((r) => r.id.startsWith("2f747fc3"))?.idForm).toBe("uuid");
    // A task link decodes to the SAME space as the bare form — `tasks.id` is
    // text holding `mt#N`, so there is no second space to track.
    expect(collectEntityRefs("minsky://task/mt%232430")[0]?.idForm).toBe("short");
  });

  test("refKey separates the two spaces", () => {
    const refs = collectEntityRefs(BOTH_FORMS);
    const keys = refs.map(refKey);

    expect(keys).toContain("ask:short:8467");
    expect(keys).toContain("ask:uuid:2f747fc3-70e4-4e3c-952c-4af9c1eed01d");
  });

  test("a uuid-linked ask RESOLVES — it was previously unreachable", () => {
    const claims = findPendingClaims(BOTH_FORMS);
    const uuid = "2f747fc3-70e4-4e3c-952c-4af9c1eed01d";
    const states = new Map([[`ask:uuid:${uuid}`, { state: "closed", identity: uuid }]]);

    const resolved = classifyResolved(claims, states);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.isTerminal).toBe(true);
  });

  test("the same ask in BOTH forms yields ONE claim, not two", () => {
    const claims = findPendingClaims(BOTH_FORMS);
    const uuid = "2f747fc3-70e4-4e3c-952c-4af9c1eed01d";
    // Both keys resolve, and both carry the SAME identity — which is what the
    // real query produces, since one row supplies both columns.
    const states = new Map([
      ["ask:short:8467", { state: "closed", identity: uuid }],
      [`ask:uuid:${uuid}`, { state: "closed", identity: uuid }],
    ]);

    expect(claims.length).toBeGreaterThan(1);
    expect(classifyResolved(claims, states)).toHaveLength(1);
  });

  test("two DIFFERENT asks still yield two claims", () => {
    const claims = findPendingClaims("Waiting on you: ask#8467 and ask#8468.");
    const states = new Map([
      ["ask:short:8467", { state: "closed", identity: "uuid-a" }],
      ["ask:short:8468", { state: "closed", identity: "uuid-b" }],
    ]);

    expect(classifyResolved(claims, states)).toHaveLength(2);
  });
});

/**
 * mt#4375 — the ask's own text declares it resolved while `state` lags.
 *
 * Fixtures are ask#9278's REAL title and question, verbatim. That ask is the
 * originating incident: `state` was `suspended` (correctly — nothing had closed
 * it, and `stale-suspended-close` never auto-closes its kind), so the
 * state-column check could not fire, while the body said the opposite.
 */
const ASK_9278_TITLE =
  "RESOLVED — reviewer restored; root cause is mt#4294, already owned and claimed";
const ASK_9278_QUESTION =
  "**RESOLVED. No action needed from you. Do NOT run the terminate command from the original version of this ask.**\n\n" +
  "**Root cause is already known and owned: mt#4294** (PLANNING, actively claimed by another session).";

/** State map carrying the ask's own content, as `lookupLiveStates` now builds it. */
function askWithContent(
  shortId: string,
  state: string,
  title?: string,
  question?: string,
  identity = `uuid-of-${shortId}`
) {
  return new Map([[`ask:short:${shortId}`, { state, identity, title, question }]]);
}

describe("mt#4375 — content-declares-resolved", () => {
  const claims = findPendingClaims(R17_MESSAGE);

  test("mt#4375 AT1 — a suspended ask whose body declares RESOLVED is a contradiction", () => {
    const states = askWithContent("8467", "suspended", ASK_9278_TITLE, ASK_9278_QUESTION);
    const resolved = classifyResolved(claims, states);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.declaresResolved).toBe(true);
    expect(resolved[0]?.contradictionKind).toBe("content-declares-resolved");
    // The state column is untouched and still says non-terminal — which is the
    // whole point: this class is invisible to `isTerminal`.
    expect(resolved[0]?.isTerminal).toBe(false);
    expect(resolved[0]?.liveState).toBe("suspended");
  });

  test("mt#4375 AT2 — a closed ask still reports the state-column class, not double-counted", () => {
    const states = askWithContent("8467", "closed", ASK_9278_TITLE, ASK_9278_QUESTION);
    const resolved = classifyResolved(claims, states);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.isTerminal).toBe(true);
    expect(resolved[0]?.contradictionKind).toBe("terminal-state");
    // Disjoint: an already-terminal ask is not ALSO reported as content-declared.
    expect(resolved[0]?.declaresResolved).toBe(false);
  });

  test("mt#4375 AT3 — 'is resolved' mid-sentence is a mention, not a declaration", () => {
    const states = askWithContent(
      "8467",
      "suspended",
      "Decide the rollout order for the pool probe",
      "This is blocked until mt#4294 is resolved. Which option do you want?"
    );
    const resolved = classifyResolved(claims, states);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.declaresResolved).toBe(false);
    expect(resolved[0]?.contradictionKind).toBeUndefined();
  });

  test("mt#4375 AT4 — a genuinely open ask with no marker is unchanged", () => {
    const states = askWithContent(
      "8467",
      "suspended",
      "What should mt#2430 deliver now that the RFC option was declined?",
      "Pick one of the three scopes below."
    );
    const resolved = classifyResolved(claims, states);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.isTerminal).toBe(false);
    expect(resolved[0]?.declaresResolved).toBe(false);
    expect(resolved[0]?.contradictionKind).toBeUndefined();
  });

  test("a row with no title/question at all does not declare anything", () => {
    const resolved = classifyResolved(claims, askShort("8467", "suspended"));
    expect(resolved[0]?.declaresResolved).toBe(false);
  });
});

describe("declaresResolution — the predicate", () => {
  test("anchors on the head, through markdown emphasis", () => {
    expect(declaresResolution("**RESOLVED. No action needed from you.**")).toBe(true);
    expect(declaresResolution("RESOLVED — reviewer restored")).toBe(true);
    expect(declaresResolution("## Resolved: nothing further")).toBe(true);
  });

  test("a trailing mention is not a declaration", () => {
    expect(declaresResolution("blocked until mt#4294 is resolved")).toBe(false);
    expect(declaresResolution("Should this be resolved by folding it in?")).toBe(false);
  });

  test("the no-action phrase needs no leading anchor", () => {
    expect(declaresResolution("Update: no action needed from you, closing out.")).toBe(true);
  });

  test("empty and absent inputs are not declarations", () => {
    expect(declaresResolution(undefined, undefined)).toBe(false);
    expect(declaresResolution("", "")).toBe(false);
  });

  test("a declaration far past the window does not count", () => {
    const padded = `${"context. ".repeat(60)}RESOLVED. no action needed`;
    expect(declaresResolution(padded)).toBe(false);
  });
});

describe("mt#4375 SC2 — the vocabulary is named constants, not inline literals", () => {
  test("both marker sets are exported and non-empty", () => {
    expect(RESOLUTION_DECLARATION_LEAD_WORDS).toContain("resolved");
    expect(RESOLUTION_DECLARATION_PHRASES).toContain("no action needed");
  });

  test("every declared lead word is honoured at the head", () => {
    for (const word of RESOLUTION_DECLARATION_LEAD_WORDS) {
      expect(declaresResolution(`${word}. nothing further`)).toBe(true);
      expect(declaresResolution(`**${word.toUpperCase()} — done**`)).toBe(true);
    }
  });

  test("every declared phrase is honoured near the head", () => {
    for (const phrase of RESOLUTION_DECLARATION_PHRASES) {
      expect(declaresResolution(`Update: ${phrase} here.`)).toBe(true);
    }
  });

  test("a lead word is a WORD, not a prefix", () => {
    // "resolvedly"/"resolvedness" open with the letters but are not the word.
    expect(declaresResolution("resolvedly speaking, we should fold it in")).toBe(false);
  });

  test("a bare lead word with nothing after it still declares", () => {
    expect(declaresResolution("resolved")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mt#4580 — the Rung-2 climb
// ---------------------------------------------------------------------------

/**
 * The two real occurrences, verbatim (mem#1269 R19/R20).
 *
 * Kept verbatim on PURPOSE, and deliberately absent from NOMINATION_EXEMPLARS:
 * the fixture asserts on the real text while the exemplars describe only the
 * SHAPE. That separation is what makes the recall test evidence rather than a
 * tautology — an exemplar seeded with R19 would make this pass by memorization
 * and prove nothing about the paraphrase the next miss arrives in. The sibling
 * detector states the same discipline in its own exemplar docblock.
 */
const R19_RECOMMEND_START = [
  "### Recommended next steps",
  "",
  "1. **Narrow mt#4555** to the once-per-PR hybrid question, drop the rest, and close it out.",
  "2. **Start mt#4556** (config fingerprint) — mt#4554's arms are unmeasurable without it.",
].join("\n");

const R20_PAST_TENSE =
  "I've recorded this correction on the task. My earlier framing was too strong.";

/** The shape mt#4199 WAS built for — the control that makes the zeros mean something. */
const RUNG1_CONTROL = "Still with you: ask#8467 — it needs your answer before I can proceed.";

describe("mt#4580 — Rung 1 is blind to both shapes (the measurement, with a control)", () => {
  test("the control fires, so the probe demonstrably works", () => {
    const claims = findPendingClaims(RUNG1_CONTROL);
    expect(claims.length).toBe(1);
    expect(claims[0]?.entity.ref).toBe("ask#8467");
  });

  test("R19 (recommend-start) is invisible to the phrase gate", () => {
    expect(findPendingClaims(R19_RECOMMEND_START)).toEqual([]);
  });

  test("R20 (past-tense claim) is invisible to the phrase gate", () => {
    expect(findPendingClaims(R20_PAST_TENSE)).toEqual([]);
  });

  test("the miss is at RECOGNITION, not the state check — the refs were always findable", () => {
    // This is the load-bearing detail: collectEntityRefs finds them fine, so no
    // state-side fix could have helped. findPendingClaims returns early because
    // zero assertion phrases matched.
    expect(collectEntityRefs(R19_RECOMMEND_START).map((r) => r.id)).toContain("mt#4556");
    expect(collectAssertions(R19_RECOMMEND_START)).toEqual([]);
  });
});

describe("mt#4580 — exemplars describe the shape, never the miss", () => {
  test("no exemplar contains either occurrence verbatim", () => {
    const all = NOMINATION_EXEMPLARS.flatMap((s) => s.exemplars);
    for (const ex of all) {
      expect(R19_RECOMMEND_START).not.toContain(ex);
      expect(R20_PAST_TENSE).not.toContain(ex);
    }
  });

  test("both families are present and non-empty", () => {
    const families = NOMINATION_EXEMPLARS.map((s) => s.family).sort();
    expect(families).toEqual(["past-tense-claim", "recommend-start"]);
    for (const s of NOMINATION_EXEMPLARS) expect(s.exemplars.length).toBeGreaterThan(0);
  });
});

describe("mt#4580 — cost discipline: no ref means no IO", () => {
  test("a turn naming no entity never resolves nomination deps", async () => {
    let resolveCalls = 0;
    const out = await nominatePendingClaims("All done here, nothing outstanding.", {
      resolve: async () => {
        resolveCalls += 1;
        return null;
      },
      run: async () => {
        throw new Error("nominate must not be reached without a ref");
      },
    });
    expect(resolveCalls).toBe(0);
    expect(out.claims).toEqual([]);
    expect(out.degradedReason).toBeUndefined();
  });

  test("an unavailable embedding provider degrades rather than firing", async () => {
    const out = await nominatePendingClaims("Next up is mt#4556.", {
      resolve: async () => null,
      run: async () => {
        throw new Error("must not run without deps");
      },
    });
    expect(out.claims).toEqual([]);
    expect(out.degradedReason).toBe("nomination-deps-unavailable");
  });
});

describe("mt#4580 — findUnbackedClaims (the past-tense arm)", () => {
  const claim = (id: string) => ({
    entity: { kind: "task" as const, ref: id, id, idForm: "short" as const, at: 0 },
    assertion: { family: "past-tense-claim", phrase: "I recorded that", at: 0 },
  });

  test("a claim whose ref no tool call carried is unbacked", () => {
    const lines = [
      { type: "tool_use", name: "tasks_get", input: { taskId: "mt#9999" } },
    ] as unknown as Parameters<typeof findUnbackedClaims>[1];
    expect(findUnbackedClaims([claim("mt#4555")], lines).map((c) => c.entity.id)).toEqual([
      "mt#4555",
    ]);
  });

  test("a claim whose ref a tool call DID carry is backed", () => {
    const lines = [
      { type: "tool_use", name: "tasks_spec_patch", input: { taskId: "mt#4555" } },
    ] as unknown as Parameters<typeof findUnbackedClaims>[1];
    expect(findUnbackedClaims([claim("mt#4555")], lines)).toEqual([]);
  });

  test("only the past-tense family is inspected", () => {
    const other = {
      ...claim("mt#4555"),
      assertion: { family: "recommend-start", phrase: "start it", at: 0 },
    };
    expect(findUnbackedClaims([other], [])).toEqual([]);
  });

  test("non-tool_use lines contribute nothing to the haystack", () => {
    const lines = [
      { type: "assistant", text: "mt#4555 is mentioned in prose only" },
    ] as unknown as Parameters<typeof toolInputHaystack>[0];
    expect(toolInputHaystack(lines)).toBe("");
  });
});

describe("mt#4580 — findPeerHeldClaims (the recommend-start arm)", () => {
  const claim = {
    entity: {
      kind: "task" as const,
      ref: "mt#4556",
      id: "mt#4556",
      idForm: "short" as const,
      at: 0,
    },
    assertion: { family: "recommend-start", phrase: "start it next", at: 0 },
  };

  test("a peer session.started row marks the recommendation stale", async () => {
    const out = await findPeerHeldClaims([claim], undefined, {
      read: async () => [
        { eventType: "session.started", createdAt: new Date(), payload: { sessionId: "peer-1" } },
      ],
      decide: () => ({ fired: true, message: "peer says so", outcome: "decided" }),
    });
    expect(out.held.map((c) => c.entity.id)).toEqual(["mt#4556"]);
    expect(out.degradedReason).toBeUndefined();
  });

  test("a quiet ledger holds nothing", async () => {
    const out = await findPeerHeldClaims([claim], undefined, {
      read: async () => [],
      decide: () => ({ fired: false, outcome: "decided" }),
    });
    expect(out.held).toEqual([]);
    expect(out.degradedReason).toBeUndefined();
  });

  test("an unreadable ledger degrades — it does NOT read as 'no peer'", async () => {
    // The whole failure class this guard exists for is a negative nobody
    // actually checked. These two must never collapse into one value.
    const out = await findPeerHeldClaims([claim], undefined, {
      read: async () => null,
      decide: () => ({ fired: true, message: "should not be consulted" }),
    });
    expect(out.held).toEqual([]);
    expect(out.degradedReason).toContain("ledger read unavailable");
  });

  test("a throwing read degrades rather than escaping the Stop guard", async () => {
    const out = await findPeerHeldClaims([claim], undefined, {
      read: async () => {
        throw new Error("db down");
      },
      decide: () => ({ fired: false }),
    });
    expect(out.held).toEqual([]);
    expect(out.degradedReason).toContain("db down");
  });
});

describe("mt#4580 AT5 — elision holds on the Rung-2 path too", () => {
  test("a ref inside a fenced block is not collected, so nomination never runs", async () => {
    let resolveCalls = 0;
    const fenced = ["Here is an example:", "```", "Start mt#4556 next.", "```"].join("\n");
    const out = await nominatePendingClaims(fenced, {
      resolve: async () => {
        resolveCalls += 1;
        return null;
      },
      run: async () => {
        throw new Error("nominate must not run on an elided ref");
      },
    });
    expect(resolveCalls).toBe(0);
    expect(out.claims).toEqual([]);
  });

  test("the same sentence UNfenced does reach the stage", async () => {
    // The negative control for the test above: without it, "0 calls" could mean
    // the elision worked OR that the gate never admits this shape at all.
    let resolveCalls = 0;
    await nominatePendingClaims("Start mt#4556 next.", {
      resolve: async () => {
        resolveCalls += 1;
        return null;
      },
      run: async () => {
        throw new Error("unreachable — resolve returns null");
      },
    });
    expect(resolveCalls).toBe(1);
  });
});
