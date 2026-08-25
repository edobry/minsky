/**
 * mt#2264 — a spec that STATES a task relationship in prose while the matching
 * structural edge is absent.
 *
 * The discriminating assertions are the PAIRS: the same spec fires when the edge
 * is missing and is silent when it is present. Everything else bounds the
 * trigger, because this guard fires at the moment an author is writing a spec,
 * and crying wolf there is expensive (mem#719).
 *
 * **Every negative case here is preceded by a LIVENESS assertion.** A fixture
 * that reaches no matcher passes `toEqual([])` vacuously AND survives its own
 * negative control, because "nothing matched" is stable whether or not the code
 * under test is disabled (mem#1020). So each suppression test first proves the
 * un-suppressed form fires, then asserts the suppressed form does not — which
 * makes an inert fixture fail loudly on the first assertion instead of passing
 * silently on the second.
 */
import { describe, test, expect } from "bun:test";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";
import { TASK_CREATE_GUARDS } from "./registry-task-create-guards";
import {
  axisForPhrase,
  buildAdvisory,
  edgesFromCreatePayload,
  findRelationshipAssertions,
  GRAPH_READ_TIMEOUT_MS,
  isAdjudicable,
  isDischarged,
  MAX_RENDERED_ASSERTIONS,
  requiredEdgeFor,
  type RequiredEdge,
  readSpecTextForCall,
  renderWorstCase,
  run,
  SPEC_TEXT_FIELD_BY_TOOL,
  targetTaskId,
  type DeclaredEdges,
  type RelationshipAssertion,
} from "./warn-unwired-task-relationship";

/**
 * The guard's OWN registration, read rather than restated.
 *
 * mem#968: an assumption expressed as a literal is checked by nothing; one
 * expressed as a comparison against a live source is checked every run. Copying
 * `1000` into this file would create a second declaration free to drift from
 * the first.
 */
const REGISTRATION = TASK_CREATE_GUARDS.find((g) => g.name === "warn-unwired-task-relationship");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Synthetic task ids, kept clear of any id under test.
 *
 * mem#1236's second gotcha: a fixture id colliding with an id the detector
 * excludes makes a correct detector look broken. `mt#900001` cannot collide
 * with a real task or with `ownTaskId` in any case below.
 */
/**
 * The longest phrase in the table, named once.
 *
 * It is the fixture for two distinct properties — longest-alternative-wins in
 * recognition, and the widest per-line render — so a literal in each place
 * would be two copies free to drift apart from the pattern they are sampled
 * from.
 */
/**
 * The five required-edge names, bound once.
 *
 * Typed as `RequiredEdge` rather than left as bare literals so an invented
 * member is a compile error rather than a test that silently asserts nothing —
 * mem#968's rule that an assumption expressed as a literal is checked by
 * nothing, applied to the union this file compares against most often.
 */
const FWD_DEP: RequiredEdge = "this-depends-on-other";
const INV_DEP: RequiredEdge = "other-depends-on-this";
const FWD_CHILD: RequiredEdge = "this-child-of-other";
const INV_CHILD: RequiredEdge = "other-child-of-this";

const LONGEST_PHRASE = "hard prerequisite for";

const OTHER = "mt#900001";
const SELF = "mt#900002";

function createCall(spec: string, extra: Record<string, unknown> = {}): ToolHookInput {
  return {
    tool_name: "mcp__minsky__tasks_create",
    tool_input: { title: "fixture", spec, ...extra },
    session_id: "test-session",
  } as unknown as ToolHookInput;
}

const EMPTY_CTX = {} as DispatchContext;

/** Assertions found in a create-shaped spec with no owning task id. */
function assertionsIn(spec: string): RelationshipAssertion[] {
  return findRelationshipAssertions(spec, null);
}

const norm = (id: string) => id.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** Graph-shaped edges: incoming directions are KNOWN, as at the edit seams. */
function edges(
  deps: string[],
  parent: string | null = null,
  dependents: string[] = [],
  children: string[] = []
): DeclaredEdges {
  return {
    deps: new Set(deps.map(norm)),
    parent,
    dependents: new Set(dependents.map(norm)),
    children: new Set(children.map(norm)),
    inverseKnown: true,
  };
}

// ---------------------------------------------------------------------------
// Recognition — the phrase set, sampled from real text
// ---------------------------------------------------------------------------

describe("recognition: phrases sampled from real specs", () => {
  // Each string here appears verbatim in mem#530 or in its R4 entry. Sampling
  // rather than paraphrasing is the mem#1020 discipline applied at authoring
  // time: a paraphrase is an input drawn from a domain the matcher defines, and
  // reading it cannot tell you whether it is in that domain.
  const dependencyPhrasings: ReadonlyArray<[string, string]> = [
    [LONGEST_PHRASE, `the config_fingerprint column (${OTHER}, ${LONGEST_PHRASE} SC2)`],
    ["waits on", `This arm waits on ${OTHER} before it can start.`],
    ["prerequisite for", `Prerequisite for the reasoning-effort arm of ${OTHER}.`],
    ["feeds", `${OTHER} feeds this task's investigation.`],
    ["is gated on", `Shipping is gated on ${OTHER}.`],
    ["depends on", `This depends on ${OTHER}.`],
    ["blocked by", `Blocked by ${OTHER}.`],
  ];

  for (const [label, spec] of dependencyPhrasings) {
    test(`"${label}" is recognized on the dependency axis`, () => {
      const found = assertionsIn(spec);
      expect(found).toHaveLength(1);
      expect(found[0]?.taskId).toBe(OTHER);
      expect(found[0]?.axis).toBe("dependency");
    });
  }

  const decompositionPhrasings: ReadonlyArray<[string, string]> = [
    ["is part of", `This is part of ${OTHER}.`],
    ["child of", `Filed as a child of ${OTHER}.`],
    ["subtask of", `A subtask of ${OTHER}.`],
    ["umbrella for", `This is the umbrella for ${OTHER}.`],
  ];

  for (const [label, spec] of decompositionPhrasings) {
    test(`"${label}" is recognized on the decomposition axis`, () => {
      const found = assertionsIn(spec);
      expect(found).toHaveLength(1);
      expect(found[0]?.axis).toBe("decomposition");
    });
  }

  test("'follow-up to' is recognized but reported as unclear", () => {
    const found = assertionsIn(`A follow-up to ${OTHER}.`);
    expect(found).toHaveLength(1);
    expect(found[0]?.axis).toBe("unclear");
  });

  test("the longer phrase wins, so the advisory quotes the author correctly", () => {
    // "hard prerequisite for" contains "prerequisite for". If the shorter
    // alternative matched first the advisory would misquote the sentence.
    const found = assertionsIn(`${OTHER}, ${LONGEST_PHRASE} SC2`);
    expect(found[0]?.phrase.toLowerCase()).toBe(LONGEST_PHRASE);
  });

  test("the id may sit on either side of the phrase", () => {
    // Both directions are real: R4's own text puts the id first, mem#530's
    // worked example puts one on each side. A single-direction window would
    // have missed the incident that motivated this guard.
    expect(assertionsIn(`${OTHER}, ${LONGEST_PHRASE} SC2`)).toHaveLength(1);
    expect(assertionsIn(`This depends on ${OTHER}.`)).toHaveLength(1);
  });

  test("md# ids are recognized alongside mt#", () => {
    const found = assertionsIn("This depends on md#4242.");
    expect(found).toHaveLength(1);
    expect(found[0]?.taskId).toBe("md#4242");
  });

  test("a spec with no relationship phrase yields nothing", () => {
    // Liveness for this negative: the SAME id in a relationship sentence fires,
    // so an empty result here is about the phrase and not about the fixture.
    expect(assertionsIn(`This depends on ${OTHER}.`)).toHaveLength(1);
    expect(assertionsIn(`See ${OTHER} for the measurement corpus.`)).toEqual([]);
  });

  test("axisForPhrase round-trips every registered phrase", () => {
    expect(axisForPhrase("depends on")).toBe("dependency");
    expect(axisForPhrase("part of")).toBe("decomposition");
    expect(axisForPhrase("follow-up to")).toBe("unclear");
  });
});

// ---------------------------------------------------------------------------
// Suppression — each preceded by its liveness assertion
// ---------------------------------------------------------------------------

describe("pairing: a phrase takes its NEAREST id, not every id in the window", () => {
  // REGRESSION, found by running the real dispatcher rather than by a unit test.
  // Every fixture above is one phrase and one id, so none of them could exhibit
  // a defect that only appears at two of each. The live calibration record read:
  //
  //   pairs: ["dependency:mt#4556", "dependency:mt#2230",
  //           "decomposition:mt#4556", "decomposition:mt#2230"]
  //
  // Two correct, two invented by the cross-product. Sentence copied verbatim
  // from that run (mem#1002: sample fixtures from real records; a paraphrase is
  // an input drawn from a domain you cannot evaluate by reading).
  const LIVE_SENTENCE = "This work is a hard prerequisite for mt#4556, and it is part of mt#2230.";

  test("two phrases and two ids yield exactly two assertions", () => {
    const found = findRelationshipAssertions(LIVE_SENTENCE, null);
    expect(found).toHaveLength(2);
  });

  test("each phrase takes the id it actually names", () => {
    const found = findRelationshipAssertions(LIVE_SENTENCE, null);
    const pairs = found.map((a) => `${a.axis}:${a.taskId}`).sort();
    expect(pairs).toEqual(["decomposition:mt#2230", "dependency:mt#4556"]);
  });

  test("the invented cross-pairs are absent", () => {
    // Asserted separately from the count so a future regression that keeps the
    // count at 2 while swapping the objects still fails.
    const pairs = findRelationshipAssertions(LIVE_SENTENCE, null).map(
      (a) => `${a.axis}:${a.taskId}`
    );
    expect(pairs).not.toContain("dependency:mt#2230");
    expect(pairs).not.toContain("decomposition:mt#4556");
  });

  test("an id BEFORE the phrase still wins when it is nearer", () => {
    // mem#530's worked example. "feeds" sits between the two ids; the nearer is
    // the one immediately before it.
    const found = findRelationshipAssertions("mt#900001 feeds mt#900002.", null);
    expect(found).toHaveLength(1);
    expect(found[0]?.taskId).toBe("mt#900001");
  });
});

describe("suppression: negation cancels the phrase", () => {
  const negatedLeading: ReadonlyArray<[string, string, string]> = [
    ["does not", `This depends on ${OTHER}.`, `This does not depend on ${OTHER}.`],
    ["no longer", `Blocked by ${OTHER}.`, `No longer blocked by ${OTHER}.`],
    ["bare 'no'", `This is part of ${OTHER}.`, `There is no part of ${OTHER} that this touches.`],
    ["never", `This depends on ${OTHER}.`, `This never depends on ${OTHER}.`],
  ];

  for (const [label, live, negated] of negatedLeading) {
    test(`a leading negation (${label}) suppresses`, () => {
      // LIVENESS FIRST — if this fails the negated fixture below proves nothing.
      expect(assertionsIn(live).length).toBeGreaterThan(0);
      expect(assertionsIn(negated)).toEqual([]);
    });
  }

  test("a negating complement suppresses", () => {
    // The direction a lookback cannot see. Precedent: mt#4483 on
    // `ask-routing-deferral-detector`.
    expect(assertionsIn(`This waits on ${OTHER}.`).length).toBeGreaterThan(0);
    expect(assertionsIn(`This waits on nothing in ${OTHER}.`)).toEqual([]);
  });

  test("the bare-determiner form this task's own spec uses is suppressed", () => {
    // Sampled verbatim from mt#2264's `## Context`. Deliberate non-edges are
    // stated exactly this way, and firing on one would flag an author for
    // recording a decision correctly.
    const live = `**Dependency edge to ${OTHER}** — this hook is part of ${OTHER}.`;
    const negated = `**No dependency edge to ${OTHER}** — this hook is no longer part of ${OTHER}.`;
    expect(assertionsIn(live).length).toBeGreaterThan(0);
    expect(assertionsIn(negated)).toEqual([]);
  });
});

describe("suppression: ADR-024 Rung-1 elision", () => {
  const live = `This depends on ${OTHER}.`;

  test("liveness — the unelided sentence fires", () => {
    expect(assertionsIn(live).length).toBeGreaterThan(0);
  });

  test("inside a fenced block", () => {
    expect(assertionsIn(`Example:\n\n\`\`\`\n${live}\n\`\`\`\n`)).toEqual([]);
  });

  test("inside an inline code span", () => {
    expect(assertionsIn(`The matcher fires on \`${live}\` today.`)).toEqual([]);
  });

  test("inside a blockquote", () => {
    expect(assertionsIn(`The spec said:\n\n> ${live}\n`)).toEqual([]);
  });

  test("inside a double-quoted prose span", () => {
    expect(assertionsIn(`The phrase "${live}" is the trigger.`)).toEqual([]);
  });
});

describe("suppression: proximity and self-reference", () => {
  test("a phrase and an id in different sentences do not pair", () => {
    const near = `This depends on ${OTHER}.`;
    expect(assertionsIn(near).length).toBeGreaterThan(0);

    const far =
      "This depends on the reviewer's own configuration surface, which has been " +
      "stable for several months and is documented separately. " +
      `A different concern entirely is tracked at ${OTHER}.`;
    expect(assertionsIn(far)).toEqual([]);
  });

  test("a spec naming its own id is describing itself, not asserting an edge", () => {
    const spec = `This depends on ${SELF}.`;
    // Liveness: with no owning id, the same text fires.
    expect(findRelationshipAssertions(spec, null).length).toBeGreaterThan(0);
    expect(findRelationshipAssertions(spec, SELF)).toEqual([]);
  });

  test("id normalization spans both spellings", () => {
    const spec = `This depends on ${SELF}.`;
    // `presence_claims.subject_id` stores the unpunctuated form, so both are in
    // live circulation and a literal comparison would miss across them.
    expect(findRelationshipAssertions(spec, "mt900002")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Discharge — exact at the create seam
// ---------------------------------------------------------------------------

describe("discharge: edges declared on the tasks_create payload", () => {
  test("a string dependsOn discharges", () => {
    const e = edgesFromCreatePayload({ dependsOn: OTHER });
    expect(e.deps.has("mt900001")).toBe(true);
    expect(e.parent).toBeNull();
  });

  test("an array dependsOn discharges every member", () => {
    const e = edgesFromCreatePayload({ dependsOn: [OTHER, "mt#900003"] });
    expect(e.deps.size).toBe(2);
  });

  test("parent is read separately from dependsOn", () => {
    const e = edgesFromCreatePayload({ parent: OTHER });
    expect(e.parent).toBe("mt900001");
    expect(e.deps.size).toBe(0);
  });

  test("an absent or blank value declares nothing", () => {
    expect(edgesFromCreatePayload({}).deps.size).toBe(0);
    expect(edgesFromCreatePayload({ dependsOn: "  " }).deps.size).toBe(0);
    expect(edgesFromCreatePayload(undefined).parent).toBeNull();
  });

  test("targetTaskId is null on a create and present on an edit", () => {
    expect(targetTaskId({ title: "x", spec: "y" })).toBeNull();
    expect(targetTaskId({ taskId: SELF })).toBe(SELF);
  });
});

describe("direction: an inverse phrase demands the inverse edge (PR #3347 R1)", () => {
  // THE SHIPPED DEFECT. The reviewer caught it on `parent of`; the
  // class-not-instance scan found six members across both axes, because English
  // relationship phrases come in inverse pairs and the matcher recorded only the
  // AXIS. Every one of these would have fired at an author who wired the
  // relationship correctly.
  //
  // The class, by relation:
  //   object-depends-on-subject : prerequisite for, hard prerequisite for, blocks, feeds
  //   object-child-of-subject   : parent of, umbrella for

  const inverseDependency: ReadonlyArray<[string, string]> = [
    ["prerequisite for", `This is a prerequisite for ${OTHER}.`],
    ["hard prerequisite for", `This is a hard prerequisite for ${OTHER}.`],
    ["blocks", `This blocks ${OTHER}.`],
    ["feeds", `This feeds ${OTHER}.`],
  ];

  for (const [label, spec] of inverseDependency) {
    test(`"${label}" requires the OTHER task to depend on this one`, () => {
      const found = assertionsIn(spec);
      expect(found).toHaveLength(1);
      expect(found[0]?.required).toBe(INV_DEP);
    });
  }

  const inverseDecomposition: ReadonlyArray<[string, string]> = [
    ["parent of", `This is the parent of ${OTHER}.`],
    ["umbrella for", `This is the umbrella for ${OTHER}.`],
  ];

  for (const [label, spec] of inverseDecomposition) {
    test(`"${label}" requires the OTHER task to be the child`, () => {
      const found = assertionsIn(spec);
      expect(found).toHaveLength(1);
      expect(found[0]?.required).toBe(INV_CHILD);
    });
  }

  test("the reviewer's exact case: 'parent of' is discharged by a CHILD edge", () => {
    const a = assertionsIn(`This is the parent of ${OTHER}.`)[0] as RelationshipAssertion;
    // Correctly wired: the other task's parent is this one.
    expect(isDischarged(a, edges([], null, [], [OTHER]))).toBe(true);
    // The edge the pre-fix code demanded — this task's own parent — is NOT it.
    expect(isDischarged(a, edges([], "mt900001"))).toBe(false);
  });

  test("'blocks' is discharged by a DEPENDENT, not by a dependency", () => {
    const a = assertionsIn(`This blocks ${OTHER}.`)[0] as RelationshipAssertion;
    expect(isDischarged(a, edges([], null, [OTHER]))).toBe(true);
    expect(isDischarged(a, edges([OTHER]))).toBe(false);
  });

  test("position flips the direction — R4's own sentence resolves FORWARD", () => {
    // "(mt#4556, hard prerequisite for SC2)" — the id PRECEDES the phrase, so it
    // is the subject, so THIS task depends on it. That is what the author meant,
    // and it is the sentence the whole task exists for.
    const found = assertionsIn(
      `the config_fingerprint column (${OTHER}, hard prerequisite for SC2)`
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.idIsSubject).toBe(true);
    expect(found[0]?.required).toBe(FWD_DEP);
  });

  test("the same phrase with the id AFTER resolves INVERSE", () => {
    // Discriminating pair with the test above: same phrase, opposite verdict,
    // decided only by where the id sits.
    const found = assertionsIn(`This is a hard prerequisite for ${OTHER}.`);
    expect(found[0]?.idIsSubject).toBe(false);
    expect(found[0]?.required).toBe(INV_DEP);
  });

  test("requiredEdgeFor inverts consistently for every relation", () => {
    expect(requiredEdgeFor("subject-depends-on-object", false)).toBe(FWD_DEP);
    expect(requiredEdgeFor("subject-depends-on-object", true)).toBe(INV_DEP);
    expect(requiredEdgeFor("object-depends-on-subject", false)).toBe(INV_DEP);
    expect(requiredEdgeFor("object-depends-on-subject", true)).toBe(FWD_DEP);
    expect(requiredEdgeFor("subject-child-of-object", false)).toBe(FWD_CHILD);
    expect(requiredEdgeFor("object-child-of-subject", false)).toBe(INV_CHILD);
    expect(requiredEdgeFor("unclear", false)).toBe("unclear");
  });
});

describe("adjudicability: a create seam cannot decide an inverse assertion", () => {
  // The corollary of the direction fix, and a false positive in its own right if
  // missed: `dependsOn`/`parent` on a create describe the task being CREATED, so
  // there is no way to declare that another task depends on it. Firing there
  // would flag an author who has no means to comply — the same shape as the
  // defect above, one seam over.
  const createEdges = edgesFromCreatePayload({});

  test("create-payload edges report their incoming directions as UNKNOWN", () => {
    expect(createEdges.inverseKnown).toBe(false);
  });

  test("an inverse assertion is not adjudicable at the create seam", () => {
    const a = assertionsIn(`This blocks ${OTHER}.`)[0] as RelationshipAssertion;
    expect(isAdjudicable(a, createEdges)).toBe(false);
  });

  test("a forward assertion IS adjudicable there", () => {
    // Liveness for the negative above: adjudicability is not simply always
    // false at this seam.
    const a = assertionsIn(`This depends on ${OTHER}.`)[0] as RelationshipAssertion;
    expect(isAdjudicable(a, createEdges)).toBe(true);
  });

  test("both are adjudicable once the graph has been read", () => {
    const a = assertionsIn(`This blocks ${OTHER}.`)[0] as RelationshipAssertion;
    expect(isAdjudicable(a, edges([]))).toBe(true);
  });

  test("run() does not report an inverse assertion at the create seam", async () => {
    const out = await run(createCall(`This blocks ${OTHER}.`), EMPTY_CTX);
    expect(out?.calibration?.outcome).toBe("clean");
    expect(out?.calibration?.undecidable).toBe(1);
  });

  test("run() still reports a FORWARD assertion at the create seam", async () => {
    // The discriminating half — without it the test above would pass on a guard
    // that had simply gone silent.
    const out = await run(createCall(`This depends on ${OTHER}.`), EMPTY_CTX);
    expect(out?.calibration?.outcome).toBe("matched");
  });
});

describe("discharge: edge matching by resolved direction", () => {
  const dependency = assertionsIn(`This depends on ${OTHER}.`)[0] as RelationshipAssertion;
  const decomposition = assertionsIn(`This is part of ${OTHER}.`)[0] as RelationshipAssertion;
  const unclear = assertionsIn(`A follow-up to ${OTHER}.`)[0] as RelationshipAssertion;

  test("a dependency assertion is discharged by a dependency edge only", () => {
    expect(isDischarged(dependency, edges([OTHER]))).toBe(true);
    expect(isDischarged(dependency, edges([], "mt900001"))).toBe(false);
  });

  test("a decomposition assertion is discharged by a parent edge only", () => {
    expect(isDischarged(decomposition, edges([], "mt900001"))).toBe(true);
    expect(isDischarged(decomposition, edges([OTHER]))).toBe(false);
  });

  test("an unclear assertion is discharged by ANY edge, in any direction", () => {
    // The guard cannot tell which relationship the author meant, so demanding
    // the one it guessed would fire at an author who wired another — which is
    // what mem#530 actually asks for.
    expect(isDischarged(unclear, edges([OTHER]))).toBe(true);
    expect(isDischarged(unclear, edges([], "mt900001"))).toBe(true);
    expect(isDischarged(unclear, edges([], null, [OTHER]))).toBe(true);
    expect(isDischarged(unclear, edges([], null, [], [OTHER]))).toBe(true);
    expect(isDischarged(unclear, edges([]))).toBe(false);
  });

  test("a different task's edge does not discharge this assertion", () => {
    expect(isDischarged(dependency, edges(["mt#900009"]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The guard end-to-end, at the create seam (no IO)
// ---------------------------------------------------------------------------

describe("run(): the tasks_create seam", () => {
  test("prose asserts a dependency and dependsOn is empty → matched", async () => {
    // The R4 shape exactly: four creates, the parameter empty on all four.
    const out = await run(createCall(`This depends on ${OTHER}.`), EMPTY_CTX);
    expect(out?.calibration?.outcome).toBe("matched");
    expect(out?.calibration?.pairs).toEqual([`${FWD_DEP}:${OTHER}`]);
  });

  test("the same prose WITH dependsOn → clean", async () => {
    const out = await run(createCall(`This depends on ${OTHER}.`, { dependsOn: OTHER }), EMPTY_CTX);
    expect(out?.calibration?.outcome).toBe("clean");
  });

  test("the check is per-referenced-task, not 'is dependsOn non-empty'", async () => {
    // A create that wires SOME edge while asserting a relationship to a
    // DIFFERENT task still has an unwired edge. A presence-only discharge would
    // pass this, which is the shape mt#4190 measured as never firing.
    const out = await run(
      createCall(`This depends on ${OTHER}.`, { dependsOn: "mt#900009" }),
      EMPTY_CTX
    );
    expect(out?.calibration?.outcome).toBe("matched");
    expect(out?.calibration?.pairs).toEqual([`${FWD_DEP}:${OTHER}`]);
  });

  test("a decomposition claim with no parent → matched on the decomposition axis", async () => {
    const out = await run(createCall(`This is part of ${OTHER}.`), EMPTY_CTX);
    expect(out?.calibration?.outcome).toBe("matched");
    expect(out?.calibration?.pairs).toEqual([`${FWD_CHILD}:${OTHER}`]);
  });

  test("a decomposition claim WITH parent → clean", async () => {
    const out = await run(createCall(`This is part of ${OTHER}.`, { parent: OTHER }), EMPTY_CTX);
    expect(out?.calibration?.outcome).toBe("clean");
  });

  test("no relationship phrase → clean, with a distinct reason", async () => {
    // Liveness for the negative: the matched case above proves the seam works.
    const out = await run(createCall(`See ${OTHER} for context.`), EMPTY_CTX);
    expect(out?.calibration?.outcome).toBe("clean");
    expect(out?.calibration?.reason).toBe("no relationship assertion");
  });

  test("a call carrying no spec is skipped, never clean", async () => {
    // A guard that could not read its input has not adjudicated it. A `clean`
    // here would report an unreadable corpus as a run of correct behavior.
    const out = await run(
      {
        tool_name: "mcp__minsky__tasks_create",
        tool_input: { title: "x" },
      } as unknown as ToolHookInput,
      EMPTY_CTX
    );
    expect(out?.calibration?.outcome).toBe("skipped");
    expect(out?.calibration?.reason).toBe("no authored spec text on this call");
  });

  test("an unlisted tool yields no text and is skipped", async () => {
    const out = await run(
      {
        tool_name: "mcp__minsky__tasks_status_set",
        tool_input: { taskId: SELF },
      } as unknown as ToolHookInput,
      EMPTY_CTX
    );
    expect(out?.calibration?.outcome).toBe("skipped");
  });

  test("malformed input does not throw", async () => {
    await expect(run({} as unknown as ToolHookInput, EMPTY_CTX)).resolves.toBeTruthy();
  });

  test("the guard never denies, on any path", async () => {
    const matched = await run(createCall(`This depends on ${OTHER}.`), EMPTY_CTX);
    const clean = await run(createCall("Nothing relational here."), EMPTY_CTX);
    expect(matched?.deny).toBeUndefined();
    expect(clean?.deny).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The spec-file recall hole (mt#4525)
// ---------------------------------------------------------------------------

describe("the --spec-file write is scanned, not silently missed", () => {
  test("tasks_edit's specFile body reaches the matcher", () => {
    // Guard #4 would inherit this hole by default; `readAuthoredSpecText`
    // exists so it does not. `spec` on tasks_edit is a BOOLEAN flag, not a
    // body — the resolver's `typeof value === "string"` check is what keeps
    // that from mattering (PR #3063 R1 read the two as the same key).
    const read = readSpecTextForCall(
      "mcp__minsky__tasks_edit",
      { taskId: SELF, spec: true, specFile: "/fixture/spec.md" },
      () => `This depends on ${OTHER}.`
    );
    expect(read.text).toContain("depends on");
    expect(read.specFileUnreadable).toBe(false);
  });

  test("a named-but-unreadable spec file is a MISS with its own reason", () => {
    const read = readSpecTextForCall(
      "mcp__minsky__tasks_edit",
      { taskId: SELF, specFile: "/fixture/missing.md" },
      () => null
    );
    expect(read.text).toBeNull();
    expect(read.specFileUnreadable).toBe(true);
  });

  test("every edit-seam tool has an inline key registered", () => {
    expect(Object.keys(SPEC_TEXT_FIELD_BY_TOOL).sort()).toEqual([
      "tasks_create",
      "tasks_edit",
      "tasks_spec_patch",
      "tasks_spec_search_replace",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The advisory
// ---------------------------------------------------------------------------

describe("buildAdvisory", () => {
  const one: RelationshipAssertion = {
    taskId: OTHER,
    normalizedTaskId: "mt900001",
    phrase: LONGEST_PHRASE,
    axis: "dependency",
    idIsSubject: false,
    required: FWD_DEP,
  };

  test("quotes the author's own phrase, not the pattern", () => {
    expect(buildAdvisory([one])).toContain(`"${LONGEST_PHRASE}"`);
  });

  test("names the resolved DIRECTION, not just the axis", () => {
    // The remedy is keyed on the required edge because the axis alone cannot
    // distinguish "this depends on X" from "X depends on this" — and naming the
    // wrong one is worse than silence, since a followed instruction leaves the
    // graph asserting the inverse of the truth (PR #3347 R1).
    expect(buildAdvisory([one])).toContain('tasks_deps_add(taskId: "<this>"');
    expect(buildAdvisory([{ ...one, required: INV_DEP }])).toContain(
      'tasks_deps_add(taskId: "<other>"'
    );
  });

  test("the two decomposition directions get different remedies", () => {
    expect(buildAdvisory([{ ...one, required: FWD_CHILD }])).toContain("tasks_reparent");
    expect(buildAdvisory([{ ...one, required: INV_CHILD }])).toContain("reparent the OTHER task");
  });

  test("an ambiguous phrase offers both axes rather than guessing", () => {
    const text = buildAdvisory([{ ...one, required: "unclear" }]);
    expect(text).toContain("pick one");
    expect(text).toContain("dependency");
    expect(text).toContain("parent/child");
  });

  test("a remedy is rendered once per axis PRESENT, not once per line", () => {
    // The per-line render made the saturated advisory 1280 chars of
    // near-identical repetition. An advisory that gets skimmed has the same
    // effect as one that never fired.
    const three = [one, one, one];
    const text = buildAdvisory(three);
    expect(text.split("tasks_deps_add").length - 1).toBe(1);
  });

  test("an axis NOT present contributes no remedy line", () => {
    const text = buildAdvisory([one]);
    expect(text).not.toContain("tasks_reparent");
  });

  test("the rendered list is capped and the overflow is stated", () => {
    const many = Array.from({ length: MAX_RENDERED_ASSERTIONS + 3 }, (_, i) => ({
      ...one,
      taskId: `mt#90001${i}`,
      normalizedTaskId: `mt90001${i}`,
    }));
    const text = buildAdvisory(many);
    expect(text).toContain("…and 3 more.");
  });
});

describe("renderWorstCase is a PROVED ceiling, bound to the declaration", () => {
  test("it saturates all three rendered dimensions", () => {
    const text = renderWorstCase();
    // 1. the capped list  2. the overflow suffix  3. every axis in the remedies
    expect(text.split("\n  - ").length - 1).toBe(MAX_RENDERED_ASSERTIONS);
    expect(text).toContain("…and 1 more.");
    expect(text).toContain("tasks_deps_add");
    expect(text).toContain("tasks_reparent");
    expect(text).toContain("pick one");
  });

  test("it stays within the registration's OWN declared attentionCost", () => {
    // The comparison, against the live declaration rather than a copy of it. If
    // a future edit widens the render past what the registry promises, this
    // fails — instead of the guard silently understating its share of the
    // merged-context budget, which is invisible from every other angle.
    expect(REGISTRATION).toBeDefined();
    const declared = REGISTRATION?.attentionCost?.denialMessageSizeChars;
    expect(declared).toBeGreaterThan(0);
    expect(renderWorstCase().length).toBeLessThanOrEqual(declared as number);
  });

  test("the registration ships recorder-only and cannot deny", () => {
    // Calibration-first per ADR-024, asserted rather than merely intended —
    // the module's own comment says so, and a comment is not a check.
    expect(REGISTRATION?.denyCapable).toBe(false);
    expect(REGISTRATION?.effects?.map((e) => e.verdictShape)).toEqual(["recorder"]);
    // No `additionalContext` effect declared, so the declaration cannot
    // over-describe what ships while `INJECTION_ENABLED` is false — the
    // mismatch PR #2886 R1 found on the sibling.
    expect(REGISTRATION?.effects?.some((e) => e.effect === "additionalContext")).toBe(false);
  });

  test("the guard's timeout stays above the module's own graph-read deadline", () => {
    // So the GUARD's deadline is what fires, returning a recorded `skipped`. A
    // dispatcher kill records nothing, and a sustained DB outage would then
    // read as a clean pass.
    expect(REGISTRATION?.timeoutMs).toBeGreaterThan(GRAPH_READ_TIMEOUT_MS);
  });
});
