/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read) in an isolated mkdtemp dir, mirroring turn-end-retro-scan.test.ts's precedent */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectUntakenAction,
  detectReservedCategoryHalt,
  run,
  TAIL_WINDOW_CHARS,
  OVERRIDE_ENV_VAR,
  EVALUATION_SKIP_ENV_VAR,
  SUPPRESSION_DEDUPED_BY_ASK_ROUTING_DEFERRAL,
  SUPPRESSION_RESERVED_CATEGORY_HALT,
  SUPPRESSION_ARMED_WATCHER_EVIDENCE,
  SUPPRESSION_DESTRUCTIVE_ACTION_HALT,
  SUPPRESSION_HARNESS_COMMAND_HALT,
  SUPPRESSION_FILED_BY_DESIGN_HALT,
  SUPPRESSION_PRINCIPAL_INSTRUCTION_HALT,
  detectArmedWatcherEvidence,
  detectStrandedTaskState,
  detectPresentProgressiveAssertion,
  PRESENT_PROGRESSIVE_FAMILY,
  STRANDED_TASK_FAMILY,
  TASK_ADVANCING_TOOLS,
  TASK_ID_INPUT_KEYS,
  turnKeyForMessage,
  CONDITIONAL_WAIT_TOOL,
  ARMED_WAIT_TOOLS,
} from "./turn-end-untaken-action-scan";
import type { TranscriptLine } from "./transcript";
import type { StopHookInput } from "./turn-end-retro-scan";
import { GUARD_REGISTRY, type DispatchContext, type GuardOutcome } from "./registry";
import { evaluationLogPath } from "./dispatcher";
import {
  STOP_INJECTED_OVERLAP_FAMILY,
  readFlagged,
  writeFlagged,
  flagKey,
} from "./turn-end-scan-store";

// Verbatim tails from the mt#3179 incidents. These are the regression anchors:
// if the detector stops matching them, the guard has lost the class it exists
// for.
const R3_FINAL_MESSAGE =
  "mt#3179 is incident-response, so I'm taking it forward rather than leaving it filed — that's the next step, not a question.";

const R2_FINAL_MESSAGE =
  "PR #2261 is now approved with zero findings and fully green — ready to merge on your word. " +
  "Holding per the merge carve-out, since bot approval doesn't auto-merge. " +
  "Once you give the go-ahead I'll merge, then confirm the deploy comes up healthy.";

// A turn that legitimately ended while an armed watcher was pending. This one
// must stay silent — the agent HAD taken an action.
const LEGITIMATE_WATCHER_MESSAGE =
  "GitHub is 500ing on the create-PR call. A retry watcher is armed (~7 min); " +
  "I'll re-attempt the PR when it fires — no action needed from you.";

// A real attested tail that matches BOTH the reserved-category and
// untaken-action detectors ("Say the word") — reused across the
// reserved-category-vs-armed-watcher ordering test and the mt#4117
// evaluation-stream test, rather than duplicated, since a hand-written
// substitute has previously matched neither.
const RESERVED_CATEGORY_HALT_MESSAGE =
  "picking the replacement myself because which model becomes your default is your " +
  "preference, not a capability gap. Say the word and a model and it's done.";

const ctx: DispatchContext = { transcriptLines: [] } as unknown as DispatchContext;

/** The advisory's shared header — the signal that the guard actually spoke. */
const FIRED_HEADER = "named a next action and did not take it";

/** mt#3207's shared calibration field; empty means "recorded, did not suppress". */
const SUPPRESSION_REASONS_KEY = "suppressionReasons";

let storeDir: string;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "mt3179-store-"));
  delete process.env[OVERRIDE_ENV_VAR];
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
  delete process.env[OVERRIDE_ENV_VAR];
});

describe("detectUntakenAction (mt#3179)", () => {
  test("fires on the R3 incident text (commitment-shaped stop)", () => {
    const matches = detectUntakenAction(R3_FINAL_MESSAGE);
    expect(matches.length).toBeGreaterThan(0);
    const families = matches.map((m) => m.family);
    expect(families).toContain("taking-forward");
    expect(families).toContain("next-step");
  });

  test("fires on the R2 incident text (deferral-shaped stop)", () => {
    const matches = detectUntakenAction(R2_FINAL_MESSAGE);
    expect(matches.map((m) => m.family)).toContain("give-go-ahead");
  });

  test("stays silent when an armed watcher explains the stop", () => {
    expect(detectUntakenAction(LEGITIMATE_WATCHER_MESSAGE)).toEqual([]);
  });

  test("stays silent on an announcement the turn then acted on (outside the tail window)", () => {
    // Announce-then-do: the announcement is followed by enough subsequent
    // content that it falls outside the tail window. Announce-then-STOP puts
    // the announcement last, which is the whole discriminator.
    const message = `I'll proceed to the migration now.\n${"x".repeat(TAIL_WINDOW_CHARS + 200)}`;
    expect(detectUntakenAction(message)).toEqual([]);
  });

  // mt#3853: the verbatim tail the guard MISSED on 2026-08-08. It failed the
  // old `ill-action` pattern on all three axes at once — `I'm going to` was in
  // no pattern, `write`/`PR` were not action verbs, and `option 1` was not an
  // allowed object. The principal had to ask why nothing caught it.
  test("mt#3853: fires on 'I'm going to write and PR option 1'", () => {
    const missed =
      "I'm going to write and PR option 1, verifying the endpoint against current GitHub docs " +
      "first rather than swapping one unverified vendor premise for another. Deploying it to " +
      "the reviewer service is a shared-production change, so that step is yours.";
    const matches = detectUntakenAction(missed);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.map((m) => m.family)).toContain("going-to");
  });

  test("mt#3853: the going-to family covers its contraction variants", () => {
    for (const form of [
      "I'm going to fix it",
      "I am going to implement the detector",
      "I'm gonna ship this",
    ]) {
      expect(detectUntakenAction(form).length).toBeGreaterThan(0);
    }
  });

  test("mt#3853: new action verbs fire in BOTH the I'll and I'm-going-to forms", () => {
    for (const verb of ["write", "open", "build", "patch", "draft", "wire"]) {
      expect(detectUntakenAction(`I'll ${verb} the fix`).length).toBeGreaterThan(0);
      expect(detectUntakenAction(`I'm going to ${verb} the fix`).length).toBeGreaterThan(0);
    }
  });

  // The widening must not turn ordinary reasoning prose into a fire. An
  // announcement needs an OBJECT; a bare verb is not a commitment to an
  // immediately-executable action.
  test("mt#3853: object-less and non-action phrasing stays silent", () => {
    for (const benign of [
      "I'm going to think about how this works before deciding.",
      "I'm going to need more evidence before calling it.",
      "Going to the docs was what settled it.",
      "I'll consider whether that holds.",
    ]) {
      expect(detectUntakenAction(benign)).toEqual([]);
    }
  });

  test("mt#3853: a turn that legitimately ended still stays silent after the widening", () => {
    // Same suppression fixture as above, re-asserted against the wider patterns —
    // the widening is only safe if it did not eat the armed-watcher case.
    expect(detectUntakenAction(LEGITIMATE_WATCHER_MESSAGE)).toEqual([]);
  });

  test("stays silent on empty input", () => {
    expect(detectUntakenAction("")).toEqual([]);
  });
});

describe("run (mt#3179)", () => {
  function inputWith(message: string): StopHookInput {
    return {
      session_id: "mt3179-test",
      last_assistant_message: message,
    } as StopHookInput;
  }

  test("returns an advisory additionalContext, never a deny", () => {
    const outcome = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.deny).toBeUndefined();
    expect(outcome?.additionalContext).toContain(
      // Trimmed by mt#3767 to buy ceiling headroom; the guard is Stop-keyed, so
      // "ended the turn" was already implied by when it fires.
      "named a next action and did not take it"
    );
  });

  test("dedups: the same phrase does not fire twice for one turn", () => {
    const first = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(first?.additionalContext).toBeDefined();
    const second = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(second).toBeNull();
  });

  test("a DIFFERENT later turn in the same session still fires (PR #2293 R1)", () => {
    // The regression this pins: keying dedup on the transcript's opening prompt
    // collapses to the literal "session-start" when no transcript is present
    // (which is the case throughout these tests — `ctx` carries none), so the
    // first fire would have suppressed the phrase for the REST of the session,
    // silencing exactly the repeat offenses the guard exists to catch. Keying
    // on the final message instead makes each distinct turn fire on its own.
    const first = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(first?.additionalContext).toBeDefined();

    // Same family ("say-the-word"/"give-go-ahead" vs "taking-forward") is not
    // required — what matters is that a different turn is not pre-suppressed.
    const second = run(inputWith(R2_FINAL_MESSAGE), ctx, storeDir);
    expect(second?.additionalContext).toBeDefined();

    // And a third turn repeating the SAME commitment family in new prose fires
    // too — the offense recurring is the signal, not noise to be deduped.
    const third = run(
      inputWith("Different wrap-up prose entirely. I'm taking it forward from here."),
      ctx,
      storeDir
    );
    expect(third?.additionalContext).toBeDefined();
  });

  test("returns null when there is no final message", () => {
    expect(run({ session_id: "x" } as StopHookInput, ctx, storeDir)).toBeNull();
  });

  test("override emits an audit line and no reminder", () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    const outcome = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(outcome?.additionalContext).toBeUndefined();
    expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
  });
});

// ---------------------------------------------------------------------------
// mt#3336 (ask#6448 dispositions): quoted-context elision + same-turn dedup
// against ask-routing-deferral.
// ---------------------------------------------------------------------------

describe("mt#3336 — quoted-context elision", () => {
  // Replay of the self-demonstrating false positive recorded in mt#3303's
  // spec: a handoff QUOTING detector data in a markdown blockquote tripped
  // the "say-the-word" family. Quoted text is reported, not said.
  test("a commitment phrase inside a blockquote does NOT match", () => {
    const handoffShape =
      "Recording the calibration backlog for the next session. The flagged text was:\n\n" +
      '> the open question is a 7-of-10 "Say the word" cluster that needs turn context\n\n' +
      "No disposition was recorded; the review task carries the details.";
    expect(detectUntakenAction(handoffShape)).toEqual([]);
  });

  test("a commitment phrase inside a code fence or inline code does NOT match", () => {
    const fenced =
      "Documented the detector families.\n\n```\n{ family: 'say-the-word' } matches: say the word\n```\nDone.";
    expect(detectUntakenAction(fenced)).toEqual([]);
    const inline = "The `say the word` pattern stays as-is; nothing else changed.";
    expect(detectUntakenAction(inline)).toEqual([]);
  });

  test("the same phrase UNQUOTED still matches (elision does not over-suppress)", () => {
    const matches = detectUntakenAction("Everything is staged. Say the word and it ships.");
    expect(matches.map((m) => m.family)).toContain("say-the-word");
  });
});

describe("mt#3336 — dedup against ask-routing-deferral", () => {
  function inputFor(message: string): StopHookInput {
    return {
      session_id: "mt3336-dedup-session",
      last_assistant_message: message,
    } as StopHookInput;
  }

  // "say the word" sits in BOTH detectors' pattern sets. mt#3336 made THIS
  // guard yield; mt#3620 inverted that, because the sibling only runs at the
  // NEXT UserPromptSubmit — after the principal has already read the closing
  // sentence and replied. The dedup still holds at one injection per sentence;
  // the Stop guard is now the one that speaks.
  /** Matches BOTH pattern sets — the overlap case the direction change is about. */
  const OVERLAPPING_MESSAGE = "Everything is staged and green. Say the word and it ships.";

  test("mt#3620: a message also matching the deferral patterns INJECTS at Stop", () => {
    const outcome = run(inputFor(OVERLAPPING_MESSAGE), ctx, storeDir);
    expect(outcome?.calibration).toBeDefined();
    expect((outcome?.calibration as Record<string, unknown>).deferralOverlap).toBe(true);
    expect(outcome?.additionalContext).toBeDefined();
  });

  test("mt#3620: the overlap is recorded in the store for the prompt-time sibling to read", () => {
    run(inputFor(OVERLAPPING_MESSAGE), ctx, storeDir);
    const flagged = readFlagged("mt3336-dedup-session", storeDir);
    const overlapKeys = [...flagged].filter((k) => k.includes(`|${STOP_INJECTED_OVERLAP_FAMILY}|`));
    expect(overlapKeys.length).toBeGreaterThan(0);
  });

  test("a commitment-only message (no deferral shape) still injects", () => {
    const outcome = run(inputFor(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(outcome?.calibration).toBeDefined();
    expect((outcome?.calibration as Record<string, unknown>).deferralOverlap).toBe(false);
    expect(outcome?.additionalContext).toBeDefined();
  });

  // mt#3620: this guard no longer suppresses at all, so the shared field the
  // cadence reads is always empty. The retired reason string stays exported for
  // the ~18 pre-mt#3620 records that still carry it.
  test("mt#3620: an overlapping fire records NO suppression reason — it injected", () => {
    const outcome = run(inputFor(OVERLAPPING_MESSAGE), ctx, storeDir);
    expect((outcome?.calibration as Record<string, unknown>).suppressionReasons).toEqual([]);
    expect(SUPPRESSION_DEDUPED_BY_ASK_ROUTING_DEFERRAL).toBe("deduped-by-ask-routing-deferral");
  });

  test("mt#3207: an injected fire records an EMPTY suppressionReasons, not an absent one", () => {
    const outcome = run(inputFor(R3_FINAL_MESSAGE), ctx, storeDir);
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressionReasons).toEqual([]);
    expect(Object.keys(cal)).toContain("suppressionReasons");
  });

  // mt#3767. mt#3620 gave this guard the speaking slot on an overlap and
  // silenced the prompt-time sibling; the DIRECTIVE stayed commitment-only, so
  // an offer-shaped closing sentence was told to "take it now" when the correct
  // disposition is usually to retract the sentence. These pin the two branches
  // apart — asserting on the directive's MEANING, not on its exact wording,
  // which is trimmed whenever the ceiling binds.
  describe("mt#3767: the directive matches the shape of the fire", () => {
    test("an overlap fire gets the retract-or-classify directive, not 'take it now'", () => {
      const ctxText = run(inputFor(OVERLAPPING_MESSAGE), ctx, storeDir)?.additionalContext ?? "";
      expect(ctxText).toContain("OFFERED");
      expect(ctxText).toContain("drop the offer");
      // The commitment directive's imperative must NOT be what an offer is told.
      expect(ctxText).not.toContain("Take it now");
    });

    test("a commitment-only fire is UNCHANGED — it still gets 'take it now'", () => {
      const ctxText = run(inputFor(R3_FINAL_MESSAGE), ctx, storeDir)?.additionalContext ?? "";
      expect(ctxText).toContain("Take it now");
      expect(ctxText).not.toContain("OFFERED");
    });

    // mt#3801 AT2. mt#3767 built this offer branch for exactly this sentence
    // and the classification never reached it: the shape matched the `next-up`
    // COMMITMENT family, while `deferralShaped` — which comes from
    // `detectDeferralPhrases` — was false, because neither deferral corpus had
    // an entry for a negated default. So the guard told an OFFER to "take it
    // now". The branch did not change; what changed is that the sibling now
    // recognizes the shape, which is the whole of the fix on this surface.
    test("mt#3801: the negated-default offer now selects the offer directive", () => {
      const offerShaped =
        "Next step is /plan-task mt#3799 unless you'd rather I go straight at it.";

      // Both halves, so a failure says WHICH one broke: the guard must still
      // fire on this sentence at all, and it must pick the offer branch.
      expect(detectUntakenAction(offerShaped).length).toBeGreaterThan(0);

      const ctxText = run(inputFor(offerShaped), ctx, storeDir)?.additionalContext ?? "";
      expect(ctxText).toContain("OFFERED");
      expect(ctxText).toContain("drop the offer");
      expect(ctxText).not.toContain("Take it now");
    });

    // The ceiling is enforced corpus-wide by guard-feedback-shape.test.ts against
    // the registry's worstCaseCanary. This asserts the SATURATING shape locally,
    // so a future edit to either directive fails here — next to the text — rather
    // than only in the corpus-wide test. Both axes at once: the evidence list at
    // its cap AND the longer directive selected.
    test("the saturating render stays under the declared ceiling", () => {
      const saturating =
        "I'm taking it forward — that's the next step. Next step: I'll proceed ahead " +
        "with the cleanup, then moving on to the rest. Say the word if you'd rather " +
        "I file it.";
      const ctxText = run(inputFor(saturating), ctx, storeDir)?.additionalContext ?? "";

      // Confirms this input really is saturating on both axes — without these the
      // length assertion below could pass on an under-posed input, which is the
      // exact defect this test exists to prevent.
      expect(ctxText).toContain("…and");
      expect(ctxText).toContain("OFFERED");

      // Read the ceiling from the registry and sanity-check its PRESENCE, not
      // its value — matching the mt#3699 sibling. Pinning the literal was the
      // first draft's mistake (PR #2666 R1): it makes a legitimate annotation
      // change fail here for the wrong reason, and `dispatcher.test.ts` records
      // the design intent explicitly — reading the registry means an annotation
      // change automatically changes what the test asserts. The "don't raise the
      // annotation to make this pass" discipline is prose-tier
      // (`guard-feedback-authoring.mdc`), because a raise is sometimes correct
      // and no test can tell the two apart.
      const ceiling = GUARD_REGISTRY.find((r) => r.name === "turn-end-untaken-action-scan")
        ?.attentionCost?.denialMessageSizeChars;
      expect(ceiling).toBeGreaterThan(0);
      expect(ctxText.length).toBeLessThanOrEqual(ceiling as number);
    });
  });
});

describe("mt#3768 — reserved-category halts are suppressed", () => {
  function inputWith(message: string): StopHookInput {
    return {
      session_id: "mt3768-test",
      last_assistant_message: message,
    } as StopHookInput;
  }

  // Verbatim tails from `.minsky/untaken-action-calibration.jsonl`. These are the
  // only three fires in 130 records that name a reserved category, and each is a
  // false positive: the turn stopped because the next step was the principal's,
  // which is what `principal-context.mdc §Decisions Eugene reserves` requires.
  const NAMING_HALT_2026_07_30 =
    "**Next: mt#3374 needs a call from you.** The fix is clear, but its deliverable is a " +
    "user-facing label — what harness-origin turns should be called instead of “user.” " +
    "Naming is yours, not mine. Options I'd consider: harness, system, or per-origin labels. " +
    "I lean toward per-origin — but say the word and I'll build whichever.";

  const NAMING_HALT_2026_07_31 =
    "It's blocked on you picking the user-facing name — session film as-is, or something from " +
    "the locked brand vocabulary — since that determines both the route path and the nav " +
    "label. Tell me the name and I'll implement it.";

  const PRODUCT_SURFACE_HALT_2026_08_04 =
    "I scoped them as complementary rather than folding one into the other. Next: I'll plan " +
    "mt#3712 unless you want to argue with the recommendation first — it's your product " +
    "surface and the call to make it the phone default is the contestable part.";

  const RESERVED_CATEGORY_HALTS = [
    NAMING_HALT_2026_07_30,
    NAMING_HALT_2026_07_31,
    PRODUCT_SURFACE_HALT_2026_08_04,
  ];

  test("each real reserved-category halt is suppressed, and RECORDED as suppressed", () => {
    for (const message of RESERVED_CATEGORY_HALTS) {
      const outcome = run(inputWith(message), ctx, storeDir);

      // Not null: a suppression that returns null is invisible to calibration,
      // and the failure worth catching is this predicate swallowing a TRUE
      // positive (mt#3207's contract).
      expect(outcome).not.toBeNull();
      expect(outcome?.additionalContext).toBeUndefined();
      expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).toEqual([
        SUPPRESSION_RESERVED_CATEGORY_HALT,
      ]);
      // The commitment match is still recorded — this narrows the VERDICT, not
      // what matches, so the fire must remain visible in the log.
      expect(
        (outcome?.calibration?.["matches"] as Array<Record<string, unknown>>).length
      ).toBeGreaterThan(0);
      expect(
        (outcome?.calibration?.["reservedCategoryPhrases"] as string[]).length
      ).toBeGreaterThan(0);
    }
  });

  test("negative control: the same fixtures FIRE against the un-suppressed detector", () => {
    // SC4/AT5, automated (PR #2731 R1 flagged the criterion as met only by a
    // manual run). No production seam is needed and none was added: the
    // suppression lives in `run`, so `detectUntakenAction` IS the un-tuned
    // detector. Asserting these fixtures match there proves the suppression —
    // rather than a failure to match — is what silences them in `run`.
    for (const message of RESERVED_CATEGORY_HALTS) {
      expect(detectUntakenAction(message).length).toBeGreaterThan(0);
    }
  });

  test("a bare “your call” with no category named still fires", () => {
    // The signature of the confabulated halt (mem#823, mem#367 R5) — precisely
    // what this guard must keep catching. If a bare deferral phrase could
    // suppress, the tune would hollow the detector out.
    const outcome = run(
      inputWith(
        "mt#3845 could reasonably fold into mt#3130 rather than stay a separate task; I'd keep " +
          "it separate since elapsed time is genuinely independent of turn grouping, but say " +
          "the word if you'd rather consolidate."
      ),
      ctx,
      storeDir
    );

    expect(outcome?.additionalContext).toContain(FIRED_HEADER);
    expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).toEqual([]);
  });

  test("an option set plus a recommendation, naming no category, still fires (mt#3801)", () => {
    // mt#3801 recorded this exact shape as a TRUE positive: the agent could have
    // walked the chain itself. An option-set discriminator would have silenced it,
    // which is why the discriminator is a named category instead.
    const outcome = run(
      inputWith(
        "Next step is /plan-task mt#3799 unless you'd rather I go straight at it — say the word."
      ),
      ctx,
      storeDir
    );

    expect(outcome?.additionalContext).toContain(FIRED_HEADER);
    expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).toEqual([]);
  });

  test("the original incident anchors still fire", () => {
    for (const message of [R3_FINAL_MESSAGE, R2_FINAL_MESSAGE]) {
      const outcome = run(inputWith(message), ctx, storeDir);
      expect(outcome?.additionalContext).toContain(FIRED_HEADER);
      expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).toEqual([]);
    }
  });

  test("a category named inside a quotation cannot suppress", () => {
    // This rule's own prose quotes the trigger vocabulary. A turn discussing the
    // guard must not silence it — same elision posture as the commitment scan.
    const outcome = run(
      inputWith(
        'The suppression fires on phrases like "Naming is yours, not mine" and "your product ' +
          "surface\". I'll implement the fixture set for it."
      ),
      ctx,
      storeDir
    );

    expect(outcome?.additionalContext).toContain(FIRED_HEADER);
    expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).toEqual([]);
  });
});

describe("detectReservedCategoryHalt (mt#3768)", () => {
  test("matches a category named far above the closing sentence", () => {
    // The commitment scan reads only the TAIL; the halt basis is routinely stated
    // where the reasoning is. A whole-message scan is why this passes.
    const message = `Naming is yours, not mine.\n\n${"filler. ".repeat(400)}\nI'll implement the route.`;
    expect(detectReservedCategoryHalt(message).length).toBeGreaterThan(0);
  });

  test("does not match ordinary shared-code prose", () => {
    // "shared source contract" must not read as a shared-STATE authorization.
    // Real tail, 2026-08-08T05:46 — classified a true positive.
    expect(
      detectReservedCategoryHalt(
        "it edits a shared source contract with corpus-wide blast radius, and doing it " +
          "carefully is worth more than doing it now. That's my call, not a blocker."
      )
    ).toEqual([]);
  });

  test("empty and absent input are safe", () => {
    expect(detectReservedCategoryHalt("")).toEqual([]);
  });
});

// mt#3917: precision fixes from the 2026-08-10 calibration pass. Each case is a
// VERBATIM tail from `.minsky/untaken-action-calibration.jsonl`, not an invented
// example — the file's own tuning discipline.
describe("mt#3917 precision fixes", () => {
  describe("durable-default preference is reserved; a one-off is not (ask#7587)", () => {
    test("suppresses the 2026-08-09T00:09Z fire", () => {
      const real =
        "picking the replacement myself because which model becomes your default is your " +
        "preference, not a capability gap. Say the word and a model and it's done.";
      expect(detectReservedCategoryHalt(real).length).toBeGreaterThan(0);
    });

    test("a ONE-OFF preference still fires — the discriminator is durability, not taste", () => {
      // The operator chose C: reserve a preference only once it sets a durable
      // default. A bare "your preference" must NOT suppress, or the fix inverts
      // the decision it is implementing.
      const oneOff =
        "Which shade of blue do you want for this one diagram? It's your preference. " +
        "Say the word and it's done.";
      expect(detectReservedCategoryHalt(oneOff)).toEqual([]);
    });

    test("durability alone, with no preference framing, does not suppress", () => {
      const durableOnly = "This becomes the default timeout for every retry. I'll wire it up.";
      expect(detectReservedCategoryHalt(durableOnly)).toEqual([]);
    });
  });

  describe("a delegated watcher is not an untaken action", () => {
    test("suppresses the 2026-08-09T04:18Z fire", () => {
      const real =
        "Decision and its basis are recorded in the spec. Blocked only on CI now — " +
        "I'll merge when the checks task reports back.";
      expect(detectUntakenAction(real)).toEqual([]);
    });

    test("an unarmed commitment with no watcher still fires", () => {
      expect(detectUntakenAction("I'll merge it once I get to it.").length).toBeGreaterThan(0);
    });

    describe("mt#3948's phrasings — the contract MOVED in mt#4063, it did not vanish", () => {
      // These four attested messages (2026-08-10 / 2026-08-11 windows) each report a wait the
      // agent armed ITSELF, which `work-completion.mdc §External self-resolving waits`
      // prescribes. mt#3948 kept them quiet by EXCLUDING them at detection, via prose patterns.
      //
      // mt#4063 retired those patterns: prose alone suppressing meant a message merely CLAIMING
      // a watcher went quiet whether or not one existed, which is what SC2 rules out. So these
      // now MATCH at detection, and go quiet at `run()` only when the turn's tool calls show a
      // wait was actually armed.
      //
      // Asserted here at the detection level, because the evidence-paired assertions need the
      // transcript fixtures built in the mt#4063 describe block below — see "run() — evidence
      // decides, not prose", which runs each window phrasing twice against opposite tool state.
      test.each([
        [
          "participle after the noun, with a preposition",
          "The merge call refuses until it completes, and I have a background wait armed on it — I'll merge and write the handoff when it fires.",
        ],
        [
          "an intervening modifier the old single-modifier slot missed",
          "CI is still running on the R3 commit and I have a blocking watcher armed on the checks — I'll merge the moment they go green.",
        ],
        [
          "participle after the noun, no preposition",
          "CI is running on the approved HEAD; watcher armed, I'll merge when it's green.",
        ],
        [
          "the noun is `wait`, which the copula pattern bound to `watcher`",
          "A background wait is armed; I'll merge when the timer fires and the build has concluded.",
        ],
      ])("now MATCHES at detection, suppressed later only on evidence: %s", (_label, message) => {
        expect(detectUntakenAction(message).length).toBeGreaterThan(0);
      });

      test("the pre-existing word orders also match now", () => {
        // The retired patterns' own shapes. Under mt#3948 these were excluded at
        // detection; under mt#4063 they match, and the tool-call evidence decides.
        expect(
          detectUntakenAction("I armed a background poll; I'll merge the PR when it clears.")
        ).not.toEqual([]);
        expect(
          detectUntakenAction("A retry watcher is armed; I'll merge when it fires.")
        ).not.toEqual([]);
      });

      test("NEGATIVE CONTROL: naming a blocker without a wait still fires", () => {
        // The discriminator this fix must not buy its way past. `work-completion.mdc` asks for
        // evidence the watcher EXISTS, not for an excuse — the same line PR #2784 R1 drew when
        // it rejected a broader `blocked only on ci` pattern. Every sentence here mentions CI, a
        // review, or a check and arms nothing.
        //
        // PR #2904 R1: asserts the SPECIFIC family, not `length > 0`. A bare length assertion
        // passes when the intended family was wrongly suppressed and some OTHER family happened
        // to match the same sentence — so it can go green on exactly the regression it exists to
        // catch.
        for (const unarmed of [
          "I'll merge the PR when the review lands.",
          "Blocked only on CI now — I'll merge the PR when it goes green.",
          "The checks are still running; I'll merge the PR after they finish.",
        ]) {
          expect(detectUntakenAction(unarmed).map((m) => m.family)).toContain("ill-action");
        }
      });
    });

    describe("mt#3948 — a next step inside a handoff block is the deliverable (absorbs mt#3998)", () => {
      const HANDOFF = [
        "## Handoff — calibration pass",
        "",
        "Two PRs merged, a retrospective, and a 13-hour data operation.",
        "",
        "### Resume — New session",
        "",
        "The queue is worked; the next step is a clean self-contained scope.",
      ].join("\n");

      test("suppresses the next-up family inside a handoff/resume block", () => {
        expect(detectUntakenAction(HANDOFF).filter((m) => m.family === "next-up")).toEqual([]);
      });

      test("NEGATIVE CONTROL: the same phrasing outside a handoff block still fires", () => {
        // PR #2904 R1: family-specific. `length > 0` would pass if `next-up` were wrongly
        // suppressed here and any other family matched the sentence.
        expect(
          detectUntakenAction(
            "The queue is worked; the next step is a clean self-contained scope."
          ).map((m) => m.family)
        ).toContain("next-up");
      });

      test("the suppression is scoped to next-up — `next-step` in a handoff still fires", () => {
        // PR #2904 R1 BLOCKING: the first version gated on `ATTRIBUTABLE_FAMILIES`, which also
        // carries `next-step`, silently widening past both the spec and the evidence. Every
        // attested handoff fire is the `next step is` phrasing. This pins the scope so a future
        // widening is a deliberate edit with a fixture behind it, not a set reused by accident.
        const withNextStep = `${HANDOFF}\n\nThat's the next step.`;
        expect(detectUntakenAction(withNextStep).map((m) => m.family)).toContain("next-step");
      });

      test("a real commitment in the SAME message still fires — suppression is per-family", () => {
        // Why this is a per-family filter rather than a SUPPRESSION_PATTERNS entry: a handoff is
        // a long closing message, exactly where a genuine commitment is most likely to also
        // appear. A global suppression would silence it.
        const withCommitment = `${HANDOFF}\n\nI'll merge the PR once you confirm.`;
        expect(detectUntakenAction(withCommitment).some((m) => m.family === "ill-action")).toBe(
          true
        );
      });

      test("the heading may sit above the 600-char tail window", () => {
        // The bug this pins: checking the tail alone would suppress only handoffs short enough
        // to fit the window, so a real handoff — where the heading is far above the closing
        // sentence — would still fire while the short fixture passed.
        const padded = [
          "### Resume — New session",
          "",
          "x".repeat(900),
          "",
          "The next step is a clean self-contained scope.",
        ].join("\n");
        expect(detectUntakenAction(padded).filter((m) => m.family === "next-up")).toEqual([]);
      });
    });

    test("delegating the wait to the PRINCIPAL still fires (PR #2784 R3)", () => {
      // "when you report back" is operator-delegation, which
      // `work-completion.mdc` names as the anti-pattern ("Ping me when GitHub's
      // back"). Suppressing it inverted the rule the suppression exists to
      // serve. The subject has to be a mechanism, not a person.
      //
      // Each fixture carries an OBJECT (`the PR`). Written without one —
      // "I'll merge when you report back" — nothing fires at all, because no
      // commitment family matches, and the test then passes or fails for a
      // reason unrelated to suppression. That is the third fixture-choice slip
      // in this block: verify a fixture against the matcher before asserting on
      // it, rather than writing what the sentence ought to trip.
      for (const delegated of [
        "I'll merge the PR when you report back.",
        "I'll merge the PR when the operator reports back.",
      ]) {
        expect(detectUntakenAction(delegated).length).toBeGreaterThan(0);
      }
      // Positive control on the same shape: a MECHANISM subject still suppresses.
      expect(detectUntakenAction("I'll merge the PR when the checks task reports back.")).toEqual(
        []
      );
    });

    test("naming CI as the blocker, with no watcher, still fires (PR #2784 R1)", () => {
      // The first draft suppressed on `blocked only on ci` too. Naming a blocker
      // is not evidence a watcher was armed — it is the announce-and-stop turn
      // this guard exists to catch, so the suppression keys on the report-back
      // clause instead.
      const announceAndStop = "Blocked only on CI now — I'll merge the PR.";
      expect(detectUntakenAction(announceAndStop).length).toBeGreaterThan(0);
    });
  });

  describe("an attributed next step is a description, not a commitment", () => {
    test("suppresses the 2026-08-10T10:09Z fire", () => {
      const real =
        "every rung reported absent while the service was actively 422ing, and the " +
        "documented next step is bypass merge.";
      expect(detectUntakenAction(real)).toEqual([]);
    });

    test("attribution to a PERSON does not suppress (PR #2784 R3)", () => {
      // A next step the principal named is still one the agent owes an action
      // or an ask on — suppressing it hides a true positive, which is the
      // opposite of citing a runbook.
      for (const personal of [
        "According to you, next step is the migration.",
        "Per your last message, next step is to rerun it.",
      ]) {
        expect(detectUntakenAction(personal).length).toBeGreaterThan(0);
      }
    });

    test("the agent's OWN next step still fires", () => {
      expect(detectUntakenAction("Next step is to rerun the migration.").length).toBeGreaterThan(0);
    });

    test("attribution ADJACENT to a first-person commitment does not suppress it (PR #2784 R2)", () => {
      // The first draft ran the attribution filter on every family, so this
      // sentence was silenced entirely.
      //
      // The fixture is chosen, not guessed. "Per the plan, I'll implement the
      // fix" reads like the right control and is NOT one: the comma falls
      // outside `[\w\s.'-]`, so the attribution pattern never matches and the
      // case passes with or without the fix. Verified against
      // `isAttributedStep` directly before writing this — the form below
      // returns true at the match index, so it is the one that exercises the
      // condition. Same trap as the bug: a test can agree with a defect by
      // accidentally avoiding it.
      const adjacent = "According to the runbook I'll implement the fix.";
      expect(detectUntakenAction(adjacent).map((m) => m.family)).toContain("ill-action");
    });

    test("attribution suppresses only its own match, not a real commitment beside it", () => {
      // Per-match, not global: the quoted procedure must not silence the
      // commitment that follows it.
      const mixed =
        "The documented next step is bypass merge. I'll implement the fix in this session.";
      const families = detectUntakenAction(mixed).map((m) => m.family);
      expect(families).toContain("ill-action");
      expect(families).not.toContain("next-up");
    });
  });
});

describe("armed-watcher evidence suppression (mt#4063)", () => {
  function userPrompt(text: string): TranscriptLine {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    } as unknown as TranscriptLine;
  }

  function toolUse(id: string, name: string, input: Record<string, unknown>): TranscriptLine {
    return {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    } as unknown as TranscriptLine;
  }

  function ctxWith(...lines: TranscriptLine[]): DispatchContext {
    return {
      transcriptLines: [userPrompt("go"), ...lines],
    } as unknown as DispatchContext;
  }

  // The three phrasings from the 2026-08-12 window that escape BOTH of the
  // phrase patterns mt#3917/mt#3948 shipped. Each names an action gated on a
  // wait, which is what `work-completion.mdc §External self-resolving waits`
  // asks for — so each must go quiet when a wait was actually armed.
  // Written out here, independently of the source's own set — that
  // independence is what makes the membership pin below a real check rather
  // than a tautology.
  const WAIT_FOR_REVIEW_TOOL = "mcp__minsky__session_pr_wait-for-review";
  const PR_WATCH_CREATE_TOOL = "mcp__minsky__pr_watch_create";
  const PR_WATCH_RUN_TOOL = "mcp__minsky__pr_watch_run";

  const WINDOW_PHRASINGS = [
    "That watch is armed in the background — I'll merge when it concludes.",
    "The watcher for it is armed — I'll merge when it lands.",
    // Faithful to the record rather than trimmed to the watcher clause: the
    // real 2026-08-12 fire on this message was `say-the-word`, from the
    // sentence AFTER the watcher clause. A trimmed version matches no family
    // at all, so it would have tested nothing in either direction.
    "A background watcher is polling PR #2929; when it merges I'll rebase, commit, and open the " +
      "PR without needing you. If you'd rather not wait, say the word and I'll set the override.",
  ];

  describe("detectArmedWatcherEvidence", () => {
    test("finds an explicitly armed wake", () => {
      const lines = [toolUse("t1", "ScheduleWakeup", { delaySeconds: 600 })];
      expect(detectArmedWatcherEvidence(lines)).toContain("ScheduleWakeup");
    });

    test("finds a blocking reviewer wait", () => {
      const lines = [toolUse("t1", WAIT_FOR_REVIEW_TOOL, { task: "mt#1" })];
      expect(detectArmedWatcherEvidence(lines)).toContain(WAIT_FOR_REVIEW_TOOL);
    });

    test("finds a backgrounded Bash task", () => {
      const lines = [toolUse("t1", "Bash", { command: "sleep 60", run_in_background: true })];
      expect(detectArmedWatcherEvidence(lines)).toContain("Bash(run_in_background)");
    });

    test("a FOREGROUND Bash call is not a watcher", () => {
      const lines = [toolUse("t1", "Bash", { command: "ls" })];
      expect(detectArmedWatcherEvidence(lines)).toEqual([]);
    });

    test("session_pr_checks counts only when it was asked to wait", () => {
      const waiting = [toolUse("t1", CONDITIONAL_WAIT_TOOL, { wait: true })];
      const snapshot = [toolUse("t1", CONDITIONAL_WAIT_TOOL, { task: "mt#1" })];
      expect(detectArmedWatcherEvidence(waiting)).toContain(CONDITIONAL_WAIT_TOOL);
      // Without `wait`, the call returns once and leaves nothing running — the
      // distinction between arming a watcher and looking at the state one time.
      expect(detectArmedWatcherEvidence(snapshot)).toEqual([]);
    });

    test("a turn that armed nothing yields no evidence", () => {
      const lines = [toolUse("t1", "Read", { file_path: "/tmp/x" })];
      expect(detectArmedWatcherEvidence(lines)).toEqual([]);
    });

    // mt#3560: `pr_watch_create` is the call `/plan-task` Step 4's self-resolving
    // branch instructs an agent to arm — "register the wait on the specific
    // unblocking event ... `pr_watch_create` with `event: 'merged'` for a PR" —
    // and it was absent from the set, so a turn that followed that prescription
    // exactly was scored as having armed nothing. Both consumers fired on it:
    // this guard's suppression and `stop-at-decision-scan`'s.
    //
    // `pr_watch_run` (present since mt#4063) is a DIFFERENT call — it executes a
    // watch cycle; `pr_watch_create` is what registers one. Having only the
    // former is why the miss reads as an oversight rather than a judgment.
    test("pr_watch_create counts — it is the call /plan-task prescribes", () => {
      const lines = [toolUse("t1", PR_WATCH_CREATE_TOOL, { event: "merged", session: "s1" })];
      expect(detectArmedWatcherEvidence(lines)).toEqual([PR_WATCH_CREATE_TOOL]);
    });

    // PR #3416 review 5045481759 asked for a `run`-only turn to be covered, since
    // the docblock's create/run distinction reads as if only `create` should count.
    // This pins CURRENT behavior — `run` DOES count — so the state is explicit
    // rather than accidental, and so a change to it fails visibly here.
    //
    // It is NOT an endorsement. `pr.watch.run` is one pass over already-registered
    // watches (`pr-watch.ts:386`), which the set's own "only calls that actually
    // leave something running" criterion arguably excludes. **mt#4696** owns that
    // question and will update this assertion either way; do not read a green test
    // as the membership having been justified.
    test("a run-only turn counts today — behavior pinned, question open (mt#4696)", () => {
      const lines = [toolUse("t1", PR_WATCH_RUN_TOOL, {})];
      expect(detectArmedWatcherEvidence(lines)).toEqual([PR_WATCH_RUN_TOOL]);
    });

    // PR #2972 R1: the set is hand-maintained and cannot be derived — blocking-
    // ness is a property of each tool's semantics, not of anything declared. So
    // pin its exact contents instead: a member added or removed fails here,
    // which makes drift a deliberate edit with a visible diff rather than a
    // silent one.
    test("the evidence set's membership is pinned, so drift is deliberate", () => {
      expect([...ARMED_WAIT_TOOLS].sort()).toEqual([
        "Monitor",
        "ScheduleWakeup",
        "mcp__minsky__asks_wait-for-response",
        "mcp__minsky__deployment_wait-for-latest",
        PR_WATCH_CREATE_TOOL,
        PR_WATCH_RUN_TOOL,
        "mcp__minsky__reviewer_watch_run",
        WAIT_FOR_REVIEW_TOOL,
      ]);
      // The conditional member is deliberately NOT in that set — it is a
      // watcher only with `wait: true`, asserted separately above.
      expect(ARMED_WAIT_TOOLS.has(CONDITIONAL_WAIT_TOOL)).toBe(false);
    });
  });

  describe("run() — evidence decides, not prose", () => {
    for (const [i, message] of WINDOW_PHRASINGS.entries()) {
      test(`window phrasing ${i + 1} is suppressed when a wait WAS armed`, () => {
        const outcome = run(
          { session_id: `armed-${i}`, last_assistant_message: message } as StopHookInput,
          ctxWith(toolUse("t1", CONDITIONAL_WAIT_TOOL, { wait: true })),
          storeDir
        );
        expect(outcome?.additionalContext ?? "").not.toContain(FIRED_HEADER);
        expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).toEqual([
          SUPPRESSION_ARMED_WATCHER_EVIDENCE,
        ]);
      });

      // The discriminator. Identical prose, no armed wait — the guard must
      // still speak, or the suppression is keying on language after all and
      // has reproduced the defect it replaces.
      test(`window phrasing ${i + 1} still FIRES when nothing was armed`, () => {
        const outcome = run(
          { session_id: `bare-${i}`, last_assistant_message: message } as StopHookInput,
          ctxWith(toolUse("t1", "Read", { file_path: "/tmp/x" })),
          storeDir
        );
        expect(outcome?.additionalContext ?? "").toContain(FIRED_HEADER);
      });
    }

    test("the suppression records what it found, so it stays measurable", () => {
      const outcome = run(
        { session_id: "records", last_assistant_message: WINDOW_PHRASINGS[0] } as StopHookInput,
        ctxWith(toolUse("t1", "ScheduleWakeup", { delaySeconds: 600 })),
        storeDir
      );
      expect(outcome?.calibration?.["armedWatcherEvidence"]).toEqual(["ScheduleWakeup"]);
    });

    test("an unrelated untaken action IS swallowed when a wait was armed (accepted cost)", () => {
      // The turn armed a watcher AND named an action that has nothing to do
      // with it. This is the true positive most at risk from the suppression;
      // it is knowingly accepted, and recorded here so the trade is visible
      // rather than discovered later.
      const outcome = run(
        { session_id: "collateral", last_assistant_message: R3_FINAL_MESSAGE } as StopHookInput,
        ctxWith(toolUse("t1", "ScheduleWakeup", { delaySeconds: 600 })),
        storeDir
      );
      expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).toEqual([
        SUPPRESSION_ARMED_WATCHER_EVIDENCE,
      ]);
    });

    // SC2's literal test, and the one PR #2972 R2 caught missing. With the old
    // prose patterns still in place this passed for the wrong reason — a
    // message SAYING a watcher was armed was suppressed whether or not one
    // was. The patterns are gone; this asserts the property directly, using
    // the exact phrasing the retired pattern used to match.
    test("prose CLAIMING an armed watcher, with nothing armed, still fires", () => {
      const outcome = run(
        {
          session_id: "prose-only",
          last_assistant_message:
            "A retry watcher is armed (~7 min); I'll merge the PR when it fires.",
        } as StopHookInput,
        ctxWith(toolUse("t1", "Read", { file_path: "/tmp/x" })),
        storeDir
      );
      expect(outcome?.additionalContext ?? "").toContain(FIRED_HEADER);
    });

    // PR #2972 R1 asked whether the new suppression could skip the
    // reserved-category one when both conditions hold. It cannot — the
    // reserved-category check returns before this one is reached — but the
    // ordering was load-bearing and unpinned, so pin it rather than argue it.
    // Reserved-category must win: it is the more specific reason, and it is the
    // one whose calibration record a reviewer of THIS guard would look for.
    test("reserved-category wins when a reserved halt and an armed wait both hold", () => {
      const outcome = run(
        {
          session_id: "both-conditions",
          last_assistant_message: RESERVED_CATEGORY_HALT_MESSAGE,
        } as StopHookInput,
        ctxWith(toolUse("t1", "ScheduleWakeup", { delaySeconds: 600 })),
        storeDir
      );
      expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).toEqual([
        SUPPRESSION_RESERVED_CATEGORY_HALT,
      ]);
      expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).not.toContain(
        SUPPRESSION_ARMED_WATCHER_EVIDENCE
      );
    });

    test("with no transcript in context the guard behaves exactly as before", () => {
      const outcome = run(
        { session_id: "no-transcript", last_assistant_message: R3_FINAL_MESSAGE } as StopHookInput,
        ctx,
        storeDir
      );
      expect(outcome?.additionalContext ?? "").toContain(FIRED_HEADER);
    });
  });
});

// ---------------------------------------------------------------------------
// mt#4116 / mt#4113 — the four corpus-mandated halts the suppression missed
// ---------------------------------------------------------------------------

describe("corpus-mandated halt suppressions (mt#4116, absorbing mt#4113)", () => {
  function userPrompt2(text: string): TranscriptLine {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    } as unknown as TranscriptLine;
  }

  function toolUse2(name: string): TranscriptLine {
    return {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t", name, input: {} }] },
    } as unknown as TranscriptLine;
  }

  function ctx2(...lines: TranscriptLine[]): DispatchContext {
    return { transcriptLines: [userPrompt2("go"), ...lines] } as unknown as DispatchContext;
  }

  function runOn(msg: string, c: DispatchContext, store: string): GuardOutcome | null {
    return run(
      { session_id: `s-${Math.abs(hashOf(msg))}`, last_assistant_message: msg } as never,
      c,
      store
    );
  }
  // Distinct session per message so the dedup store never masks a result.
  function hashOf(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  describe("destructive action (shape 1)", () => {
    test("the 2026-08-13T15:24 fixture goes quiet", () => {
      const msg = "Say the word and I'll SIGKILL both.";
      const out = runOn(msg, ctx2(), storeDir);
      expect(out?.calibration?.suppressionReasons).toEqual([SUPPRESSION_DESTRUCTIVE_ACTION_HALT]);
      expect(out?.additionalContext).toBeUndefined();
    });

    test("keys on the VERB, not on a claim of destructiveness", () => {
      // The manufacturable form: asserts the category, names no destructive act.
      const msg = "This next step is destructive, so say the word and I'll do it.";
      const out = runOn(msg, ctx2(), storeDir);
      expect(out?.calibration?.suppressionReasons ?? []).not.toContain(
        SUPPRESSION_DESTRUCTIVE_ACTION_HALT
      );
    });
  });

  describe("harness command (shape 3)", () => {
    // mt#4139 inverts this expectation. mt#4116 suppressed the fixture on the ground that the
    // agent cannot issue `/mcp` — true, and not what the halt rested on. The agent's goal was
    // MERGING, which `minsky session pr merge` reaches without MCP, so this is a
    // probe-before-deferring failure and the guard must say so.
    test("the 2026-08-12T22:16 fixture FIRES — /mcp was a precondition, not the goal", () => {
      const msg = "What's needed: run /mcp to reconnect, then I'll merge the PR.";
      const out = runOn(msg, ctx2(), storeDir);
      expect(out?.calibration?.suppressionReasons).toEqual([]);
      expect(out?.additionalContext).toBeDefined();
    });

    test("declining the suppression is RECORDED, not silent", () => {
      const msg = "What's needed: run /mcp to reconnect, then I'll merge the PR.";
      const out = runOn(msg, ctx2(), storeDir);
      expect(out?.calibration?.harnessCommandDeclined).toBeDefined();
    });

    test("the harness command as the TERMINAL action still goes quiet", () => {
      // Claims (1) and (2) collapse into one here: the command IS the step, so there is no
      // second, unexamined inference for the suppression to hide.
      const msg = "I can't run /clear for you — say the word.";
      const out = runOn(msg, ctx2(), storeDir);
      expect(out?.calibration?.suppressionReasons).toEqual([SUPPRESSION_HARNESS_COMMAND_HALT]);
    });

    test("an offer alongside a harness command is not a committed action", () => {
      // `say-the-word` hands the principal a choice and names no verb of the agent's own, so it
      // must not be read as a distinct action gated behind the command.
      const msg = "Your MCP server is down. Say the word and I'll wait — or run /config yourself.";
      const out = runOn(msg, ctx2(), storeDir);
      expect(out?.calibration?.suppressionReasons).toEqual([SUPPRESSION_HARNESS_COMMAND_HALT]);
    });

    test("a general participation excuse still fires — deliberately out of scope", () => {
      const msg = "I need you to reproduce the hang, then I'll merge the fix.";
      const out = runOn(msg, ctx2(), storeDir);
      expect(out?.additionalContext).toBeDefined();
    });

    // PR #2994 R1. The decision must read the MESSAGE's matches, not the dedup-filtered set.
    // Seed the store so the commitment (`ill-action`) is already flagged for this exact turn and
    // only the offer survives deduping: keyed on `newMatches` the guard sees no committed action
    // and wrongly goes quiet, which is the false-suppression path the review named.
    test("declines the suppression even when the commitment match is already deduped", () => {
      // Carries TWO matches: the `ill-action` commitment (seeded as already-flagged below) and a
      // `say-the-word` offer that survives deduping — so the guard still reaches the suppression
      // decision with a match list whose commitment is visible only in the UNfiltered set.
      const msg =
        "What's needed: run /mcp to reconnect, then I'll merge the PR. Say the word and I'll go.";
      const sessionId = "mt4139-dedup-leak";
      const turnKey = turnKeyForMessage(msg);
      const matches = detectUntakenAction(msg);
      const commitment = matches.find((m) => m.family === "ill-action");
      // Guards the seed itself: if the fixture stops producing a commitment match, the seeded
      // state would be meaningless and the test would pass for the wrong reason.
      if (!commitment) throw new Error("fixture no longer yields an ill-action match");

      writeFlagged(
        sessionId,
        new Set([flagKey(turnKey, commitment.family, commitment.matchedPhrase)]),
        storeDir
      );

      const out = run(
        { session_id: sessionId, last_assistant_message: msg } as never,
        ctx2(),
        storeDir
      );
      expect(out?.calibration?.suppressionReasons).toEqual([]);
      expect(out?.additionalContext).toBeDefined();
    });
  });

  describe("filed-for-later-by-design (shape 2)", () => {
    test("suppressed only when the turn ACTUALLY minted a task", () => {
      const msg =
        "That's the background/tracking task case, filed for later by design. " +
        "Say the word and I'll start it.";
      const withCreate = runOn(msg, ctx2(toolUse2("mcp__minsky__tasks_create")), storeDir);
      expect(withCreate?.calibration?.suppressionReasons).toEqual([
        SUPPRESSION_FILED_BY_DESIGN_HALT,
      ]);
    });

    test("the same prose with NO task created still fires", () => {
      // The confabulated-halt shape: says the words, filed nothing. This must not
      // become a way to talk past the sibling unwalked-task guard.
      const msg =
        "That's the background/tracking task case, filed for later by design. " +
        "Say the word and I'll start it.";
      const out = runOn(msg, ctx2(), storeDir);
      expect(out?.additionalContext).toBeDefined();
    });
  });

  describe("principal instruction (shape 4, from mt#4113)", () => {
    test("suppressed when the opening prompt actually bounded the scope", () => {
      const msg =
        "Filed only, not planned — you said file. Say the word and I'll take it to READY.";
      const c = { transcriptLines: [userPrompt2("just file it")] } as unknown as DispatchContext;
      const out = runOn(msg, c, storeDir);
      expect(out?.calibration?.suppressionReasons).toEqual([
        SUPPRESSION_PRINCIPAL_INSTRUCTION_HALT,
      ]);
    });

    test("the SAME citation with no such instruction still fires (mt#4113 SC3)", () => {
      const msg =
        "Filed only, not planned — you said file. Say the word and I'll take it to READY.";
      const c = {
        transcriptLines: [userPrompt2("take mt#1 all the way through and merge it")],
      } as unknown as DispatchContext;
      const out = runOn(msg, c, storeDir);
      expect(out?.additionalContext).toBeDefined();
    });

    test("the retired prose-only pattern no longer suppresses on its own", () => {
      // `you asked me to stop` was a SUPPRESSION_PATTERNS entry until mt#4113.
      // With no corroborating prompt it must fire.
      const msg = "you asked me not to — say the word and I'll merge it.";
      const c = { transcriptLines: [userPrompt2("keep going")] } as unknown as DispatchContext;
      const out = runOn(msg, c, storeDir);
      expect(out?.additionalContext).toBeDefined();
    });
  });
});

describe("suppressions run over ELIDED text (PR #2976 R1)", () => {
  function up(text: string): TranscriptLine {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    } as unknown as TranscriptLine;
  }
  const c = { transcriptLines: [up("go")] } as unknown as DispatchContext;

  // The asymmetry that makes this worse than the firing direction: a fire
  // manufactured by quoted text costs one advisory beat; a SUPPRESSION
  // manufactured by quoted text silences a real fire, and nothing downstream
  // notices silence.
  test("a QUOTED destructive verb does not manufacture a suppression", () => {
    const msg =
      "The rule says: `Say the word and I'll SIGKILL both.` was a false positive.\n" +
      "Say the word and I'll merge it.";
    const out = run({ session_id: "elide-1", last_assistant_message: msg } as never, c, storeDir);
    expect(out?.additionalContext).toBeDefined();
  });

  test("a QUOTED harness command does not manufacture a suppression", () => {
    const msg = "Earlier I wrote `run /mcp to reconnect`. Say the word and I'll merge it.";
    const out = run({ session_id: "elide-2", last_assistant_message: msg } as never, c, storeDir);
    expect(out?.additionalContext).toBeDefined();
  });

  test("a QUOTED instruction citation does not manufacture a suppression", () => {
    const msg = "The detector matched `you said file` in that report. Say the word and I'll merge.";
    const c2 = { transcriptLines: [up("just file it")] } as unknown as DispatchContext;
    const out = run({ session_id: "elide-3", last_assistant_message: msg } as never, c2, storeDir);
    expect(out?.additionalContext).toBeDefined();
  });

  test("the UNQUOTED forms still suppress — elision did not break the feature", () => {
    const out = run(
      {
        session_id: "elide-4",
        last_assistant_message: "Say the word and I'll SIGKILL both.",
      } as never,
      c,
      storeDir
    );
    expect(out?.calibration?.suppressionReasons).toEqual([SUPPRESSION_DESTRUCTIVE_ACTION_HALT]);
  });
});

// ---------------------------------------------------------------------------
// mt#4697 — the tool-call-state match arm.
//
// SC4 requires each attested miss the trigger claims to cover to appear as a NAMED fixture with
// its date, and each one it does NOT cover to be listed explicitly. SC5 requires every one of
// those fixtures to be shown FIRING with the arm reachable and SILENT with it unreachable —
// because `[]` is what "nothing matched" and "never reached the matcher" both return, so a green
// negative assertion is not evidence on its own.
// ---------------------------------------------------------------------------

describe("tool-call-state match arm (mt#4697)", () => {
  const REFS_STATUS = "mcp__minsky__refs_status";
  const SESSION_COMMIT = "mcp__minsky__session_commit";
  const OK_RESULT = '{"success":true}';
  let armStore: string;
  beforeEach(() => {
    armStore = mkdtempSync(join(tmpdir(), "untaken-arm-"));
  });
  afterEach(() => {
    rmSync(armStore, { recursive: true, force: true });
  });

  function up(text: string): TranscriptLine {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    } as unknown as TranscriptLine;
  }

  /** One tool call, optionally joined to the result body the arm reads. */
  function call(
    id: string,
    name: string,
    input: Record<string, unknown>,
    result?: string
  ): TranscriptLine[] {
    const lines: TranscriptLine[] = [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      } as unknown as TranscriptLine,
    ];
    if (result !== undefined) {
      lines.push({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: result }],
        },
      } as unknown as TranscriptLine);
    }
    return lines;
  }

  function ctxOf(...lines: TranscriptLine[]): DispatchContext {
    return { transcriptLines: [up("go"), ...lines] } as unknown as DispatchContext;
  }

  function runOn(msg: string, c: DispatchContext, session: string): GuardOutcome | null {
    return run({ session_id: session, last_assistant_message: msg } as never, c, armStore);
  }

  function families(out: GuardOutcome | null): string[] {
    // `calibration` is an open record on GuardOutcome, so `matches` arrives as `{}`; narrow at the
    // read rather than widening the shared type for a test helper.
    const raw = (out?.calibration?.matches ?? []) as Array<{ family: string }>;
    return raw.map((m) => m.family);
  }

  function turnLinesOf(c: DispatchContext): TranscriptLine[] {
    return (c as unknown as { transcriptLines: TranscriptLine[] }).transcriptLines;
  }

  // -- Occurrence 3, 2026-08-21T20:34:28Z (the originating miss) ------------
  // Verbatim shape: `refs_status` returned mt#4323 DONE and mt#4324 TODO; the turn advanced
  // mt#4323 (spec patch) and merely NAMED mt#4324 at the close. Settled against the transcript
  // and the event ledger during this task's planning pass — mt#4324 went TODO -> PLANNING eight
  // hours LATER, so TODO is what the turn actually saw.
  const OCC3_REFS_RESULT = JSON.stringify({
    success: true,
    results: [
      {
        ref: "mt#4323",
        kind: "task",
        id: "mt#4323",
        found: true,
        outcome: "found",
        status: "DONE",
      },
      {
        ref: "mt#4324",
        kind: "task",
        id: "mt#4324",
        found: true,
        outcome: "found",
        status: "TODO",
      },
    ],
  });
  const OCC3_MESSAGE =
    "mt#4323 is merged, deployed, and verified. " +
    "mt#4324 is the unblocked successor but sits at TODO, so it needs /plan-task first.";
  const OCC3_CTX = (): DispatchContext =>
    ctxOf(
      ...call("c1", "mcp__minsky__tasks_spec_patch", { taskId: "mt#4323" }, OK_RESULT),
      ...call("c2", REFS_STATUS, { refs: ["mt#4323", "mt#4324"] }, OCC3_REFS_RESULT)
    );

  test("occurrence 3 (2026-08-21) FIRES on the stranded task, not the advanced one", () => {
    const matches = detectStrandedTaskState(OCC3_MESSAGE, turnLinesOf(OCC3_CTX()));
    expect(matches).toEqual([{ family: STRANDED_TASK_FAMILY, matchedPhrase: "mt#4324 (TODO)" }]);
  });

  test("occurrence 3 reaches run() and is RECORDED — log-only, not injected (SC6)", () => {
    const out = runOn(OCC3_MESSAGE, OCC3_CTX(), "occ3-fire");
    // Recorded: the match is in the calibration payload, under its own field so a calibration
    // pass can classify arm fires without separating them from the phrase side by hand.
    expect(families(out)).toContain(STRANDED_TASK_FAMILY);
    expect(out?.calibration?.strandedTaskArm).toEqual(["mt#4324 (TODO)"]);
    expect(out?.calibration?.strandedArmLogOnly).toBe(true);
    // NOT injected: this message matches nothing on the phrase side, so the arm was the only
    // match and the turn gets no advisory. That is the log-only rung, asserted rather than
    // assumed — measured at 994 fires vs the phrase side's 345 over 11,196 replayed turns.
    expect(out?.calibration?.suppressionReasons).toEqual([]);
    expect(out?.additionalContext).toBeUndefined();
  });

  test("a phrase-side match in the SAME turn still injects, and the arm rides along recorded", () => {
    // The log-only rung silences the ARM, not the guard: a turn that also trips a commitment
    // pattern must keep its advisory, or this change would have quietly weakened the live half.
    const msg = `${OCC3_MESSAGE} Say the word and I'll pick it up.`;
    const out = runOn(msg, OCC3_CTX(), "occ3-mixed");
    expect(out?.additionalContext).toBeDefined();
    expect(out?.additionalContext).not.toContain(STRANDED_TASK_FAMILY);
    expect(out?.calibration?.strandedTaskArm).toEqual(["mt#4324 (TODO)"]);
  });

  test("occurrence 3 INERTNESS CONTROL — silent with the arm unreachable", () => {
    // Same message, no turn state for the arm to read. If this also fired, the fire above would
    // be the prose patterns and would say nothing about the arm.
    expect(detectStrandedTaskState(OCC3_MESSAGE, [])).toEqual([]);
    const out = runOn(OCC3_MESSAGE, ctxOf(), "occ3-inert");
    expect(families(out)).not.toContain(STRANDED_TASK_FAMILY);
  });

  // -- Occurrence 2, 2026-08-16 --------------------------------------------
  // The turn SET mt#4183 to PLANNING and closed by naming what would happen once PR #3039 merged,
  // without advancing it. `tasks_status_set` counts as establishing the state, which is why it is
  // in TASK_STATUS_READ_TOOLS and NOT in TASK_ADVANCING_TOOLS.
  const OCC2_SET_RESULT = JSON.stringify({
    success: true,
    taskId: "mt#4183",
    previousStatus: "TODO",
    newStatus: "PLANNING",
  });
  const OCC2_MESSAGE = "once PR #3039 merges, re-running the gate on mt#4183 picks it up";
  const OCC2_CTX = (): DispatchContext =>
    ctxOf(
      ...call(
        "c1",
        "mcp__minsky__tasks_status_set",
        { taskId: "mt#4183", status: "PLANNING" },
        OCC2_SET_RESULT
      )
    );

  test("occurrence 2 (2026-08-16) FIRES — a status_set to PLANNING is the stranding", () => {
    expect(detectStrandedTaskState(OCC2_MESSAGE, turnLinesOf(OCC2_CTX()))).toEqual([
      { family: STRANDED_TASK_FAMILY, matchedPhrase: "mt#4183 (PLANNING)" },
    ]);
  });

  test("occurrence 2 INERTNESS CONTROL — silent with the arm unreachable", () => {
    expect(detectStrandedTaskState(OCC2_MESSAGE, [])).toEqual([]);
    const out = runOn(OCC2_MESSAGE, ctxOf(), "occ2-inert");
    expect(families(out)).not.toContain(STRANDED_TASK_FAMILY);
  });

  // -- Occurrence 1, 2026-08-01 — EXPLICITLY OUT OF REACH -------------------
  test("occurrence 1 (2026-08-01) is NOT covered by this arm, by design", () => {
    // A first-person commitment with no task or PR state in the turn at all. The phrase side owns
    // it; SC4 requires this to be stated rather than implied.
    const msg = "Let me pull the current state and see where that leaves the queue.";
    expect(detectStrandedTaskState(msg, turnLinesOf(ctxOf()))).toEqual([]);
  });

  // -- Precision: each conjunct is load-bearing -----------------------------
  test("named but NEVER READ does not fire — a status report is not a stranding", () => {
    const msg = "Remaining: mt#4321 and mt#4322, both wanting a design pass.";
    expect(detectStrandedTaskState(msg, turnLinesOf(ctxOf()))).toEqual([]);
  });

  test("read and named but ADVANCED does not fire", () => {
    const result = JSON.stringify({
      results: [{ ref: "mt#500", id: "mt#500", status: "IN-PROGRESS" }],
    });
    const c = ctxOf(
      ...call("c1", REFS_STATUS, { refs: ["mt#500"] }, result),
      ...call("c2", SESSION_COMMIT, { task: "mt#500" }, OK_RESULT)
    );
    expect(detectStrandedTaskState("mt#500 is coming along.", turnLinesOf(c))).toEqual([]);
  });

  test("a TERMINAL status does not fire", () => {
    const result = JSON.stringify({ results: [{ ref: "mt#600", id: "mt#600", status: "DONE" }] });
    const c = ctxOf(...call("c1", REFS_STATUS, { refs: ["mt#600"] }, result));
    expect(detectStrandedTaskState("mt#600 is finished.", turnLinesOf(c))).toEqual([]);
  });

  test("read as non-terminal but NOT named at the close does not fire", () => {
    const result = JSON.stringify({ results: [{ ref: "mt#700", id: "mt#700", status: "READY" }] });
    const c = ctxOf(...call("c1", REFS_STATUS, { refs: ["mt#700"] }, result));
    expect(detectStrandedTaskState("All set; nothing outstanding.", turnLinesOf(c))).toEqual([]);
  });

  test("a call with no correlated result contributes nothing", () => {
    // `hasResult` distinguishes "returned empty" from "never returned"; the arm must not read a
    // still-in-flight call as a status of any kind.
    const c = ctxOf(...call("c1", REFS_STATUS, { refs: ["mt#800"] }));
    expect(detectStrandedTaskState("mt#800 is next.", turnLinesOf(c))).toEqual([]);
  });

  test("the row bound holds — row N's id is never paired with row N+1's status", () => {
    // mt#900 has no status field at all. Without the `[^}]` object bound the lazy span would run
    // on and pair it with mt#901's READY.
    const result = JSON.stringify({
      results: [
        { ref: "mt#900", outcome: "unavailable" },
        { ref: "mt#901", id: "mt#901", status: "READY" },
      ],
    });
    const c = ctxOf(...call("c1", REFS_STATUS, { refs: ["mt#900"] }, result));
    const matches = detectStrandedTaskState("mt#900 and mt#901 both matter.", turnLinesOf(c));
    expect(matches.map((m) => m.matchedPhrase)).toEqual(["mt#901 (READY)"]);
  });

  // -- PR #3420 R1: the advancing-tool key set -----------------------------
  test("advancing-tool-key-parity — both hand-maintained sets are pinned", () => {
    // The blocking finding's structural defense. These two lists must agree, and a mismatch is
    // SILENT: a tool naming its id differently simply stops being credited as advancing, turning
    // every one of its turns into a fire. Pinning both makes drift a visible diff, which is the
    // same defense ARMED_WAIT_TOOLS documents for itself.
    expect([...TASK_ID_INPUT_KEYS]).toEqual(["task", "taskId", "id", "parentTaskId"]);
    expect([...TASK_ADVANCING_TOOLS].sort()).toEqual([
      SESSION_COMMIT,
      "mcp__minsky__session_pr_create",
      "mcp__minsky__session_pr_merge",
      "mcp__minsky__session_start",
      "mcp__minsky__tasks_dispatch",
      "mcp__minsky__tasks_spec_patch",
      "mcp__minsky__tasks_spec_search_replace",
    ]);
  });

  test("an advancing call carrying its id as `id` is credited", () => {
    // Not reached by today's tool set — every member takes `task` or `taskId` — so this pins the
    // BEHAVIOUR the widened key list buys, rather than leaving it as an untested claim.
    const result = JSON.stringify({ results: [{ ref: "mt#510", id: "mt#510", status: "READY" }] });
    const c = ctxOf(
      ...call("c1", REFS_STATUS, { refs: ["mt#510"] }, result),
      ...call("c2", SESSION_COMMIT, { id: "mt#510" }, OK_RESULT)
    );
    expect(detectStrandedTaskState("mt#510 is moving.", turnLinesOf(c))).toEqual([]);
  });

  test("a result far longer than any positional window still yields its status", () => {
    // The old regex bounded the id->status span at 400 chars, which silently dropped exactly the
    // largest results (a `tasks_get` with a spec attached). The JSON walk has no such window.
    const result = JSON.stringify({
      task: { id: "mt#520", spec: "x".repeat(20000), status: "PLANNING" },
    });
    const c = ctxOf(...call("c1", "mcp__minsky__tasks_get", { taskId: "mt#520" }, result));
    expect(detectStrandedTaskState("mt#520 still needs planning.", turnLinesOf(c))).toEqual([
      { family: STRANDED_TASK_FAMILY, matchedPhrase: "mt#520 (PLANNING)" },
    ]);
  });

  test("a non-JSON result body degrades to the regex path rather than throwing", () => {
    const c = ctxOf(
      ...call("c1", REFS_STATUS, { refs: ["mt#530"] }, 'plain text {"id":"mt#530","status":"TODO"}')
    );
    expect(detectStrandedTaskState("mt#530 is next.", turnLinesOf(c))).toEqual([
      { family: STRANDED_TASK_FAMILY, matchedPhrase: "mt#530 (TODO)" },
    ]);
  });

  // -- SC3: the existing armed-watcher suppression covers the arm -----------
  test("SC3 — an armed watcher suppresses an arm fire, with no duplicate check in the arm", () => {
    const c = ctxOf(
      ...call(
        "c1",
        REFS_STATUS,
        { refs: ["mt#4324"] },
        JSON.stringify({ results: [{ ref: "mt#4324", id: "mt#4324", status: "TODO" }] })
      ),
      ...call("c2", "mcp__minsky__pr_watch_run", {}, '{"ok":true}')
    );
    // The arm itself still matches — it does not know about watchers.
    expect(detectStrandedTaskState("mt#4324 is next.", turnLinesOf(c))).toHaveLength(1);
    // run() suppresses it downstream, which is what SC3 asks to be asserted rather than assumed.
    const out = runOn("mt#4324 is next.", c, "sc3-armed");
    expect(out?.calibration?.suppressionReasons).toEqual([SUPPRESSION_ARMED_WATCHER_EVIDENCE]);
    expect(out?.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mt#4117 — the evaluation stream: every scanned turn-ending message writes a
// record, fired or not, distinct from the fire-only calibration log above.
// ---------------------------------------------------------------------------

describe("evaluation stream (mt#4117)", () => {
  function withProjectDir<T>(dir: string, fn: () => T): T {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = dir;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
  }

  function readEvaluationRecords(dir: string): Record<string, unknown>[] {
    const path = evaluationLogPath("untaken-action", { projectDir: dir });
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function evalToolUse(id: string, name: string, input: Record<string, unknown>): TranscriptLine {
    return {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    } as unknown as TranscriptLine;
  }

  // A preceding user turn is required so `extractFinalTurn` can delimit the
  // final assistant turn — mirrors the "armed-watcher evidence suppression"
  // describe block's own `ctxWith` fixture above.
  function evalCtxWith(...lines: TranscriptLine[]): DispatchContext {
    const userTurn: TranscriptLine = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    } as unknown as TranscriptLine;
    return { transcriptLines: [userTurn, ...lines] } as unknown as DispatchContext;
  }

  let projectDir: string;
  let evalStoreDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "mt4117-project-"));
    mkdirSync(join(projectDir, ".git"));
    evalStoreDir = mkdtempSync(join(tmpdir(), "mt4117-store-"));
    delete process.env[EVALUATION_SKIP_ENV_VAR];
  });

  afterEach(() => {
    rmSync(evaluationLogPath("untaken-action", { projectDir }), { force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(evalStoreDir, { recursive: true, force: true });
    delete process.env[EVALUATION_SKIP_ENV_VAR];
  });

  test("a fire writes BOTH a calibration record (unchanged) and an evaluation record marked fired", () => {
    const outcome = withProjectDir(projectDir, () =>
      run(
        { session_id: "eval-fire", last_assistant_message: R3_FINAL_MESSAGE } as StopHookInput,
        ctx,
        evalStoreDir
      )
    );
    // Existing calibration behavior is unchanged by this task.
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.additionalContext ?? "").toContain(FIRED_HEADER);

    const records = readEvaluationRecords(projectDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.["fired"]).toBe(true);
    expect(records[0]?.["suppressed"]).toBe(false);
    expect(records[0]?.["injected"]).toBe(true);
  });

  test("a non-fire writes an evaluation record marked non-fire, with no additionalContext", () => {
    const nonFiringMessage =
      "Everything here has already merged and the pipeline is green across the board.";
    const outcome = withProjectDir(projectDir, () =>
      run(
        { session_id: "eval-nonfire", last_assistant_message: nonFiringMessage } as StopHookInput,
        ctx,
        evalStoreDir
      )
    );
    expect(outcome).toBeNull();

    const records = readEvaluationRecords(projectDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.["fired"]).toBe(false);
    expect(records[0]?.["suppressed"]).toBe(false);
    expect(records[0]).not.toHaveProperty("additionalContext");
  });

  test("an armed-watcher-suppressed fire is recorded as suppressed, naming the suppression", () => {
    // Same fixture as the "run() — evidence decides, not prose" suite above:
    // a message that WOULD fire, alongside tool-call evidence that a wait is
    // armed. The mt#4063/mt#3768 classes are the ones most likely to hide a
    // regression if folded into a non-fire, so this is asserted directly.
    const armedMessage = "That watch is armed in the background — I'll merge when it concludes.";
    const outcome = withProjectDir(projectDir, () =>
      run(
        { session_id: "eval-suppressed", last_assistant_message: armedMessage } as StopHookInput,
        evalCtxWith(evalToolUse("t1", CONDITIONAL_WAIT_TOOL, { wait: true })),
        evalStoreDir
      )
    );
    expect(outcome?.calibration?.[SUPPRESSION_REASONS_KEY]).toEqual([
      SUPPRESSION_ARMED_WATCHER_EVIDENCE,
    ]);
    expect(outcome?.additionalContext).toBeUndefined();

    const records = readEvaluationRecords(projectDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.["fired"]).toBe(true);
    expect(records[0]?.["suppressed"]).toBe(true);
    expect(records[0]?.["suppressionReason"]).toBe(SUPPRESSION_ARMED_WATCHER_EVIDENCE);
    expect(records[0]?.["injected"]).toBe(false);
  });

  test("a reserved-category-suppressed fire is also recorded as suppressed, naming the suppression", () => {
    withProjectDir(projectDir, () =>
      run(
        {
          session_id: "eval-reserved",
          last_assistant_message: RESERVED_CATEGORY_HALT_MESSAGE,
        } as StopHookInput,
        ctx,
        evalStoreDir
      )
    );

    const records = readEvaluationRecords(projectDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.["fired"]).toBe(true);
    expect(records[0]?.["suppressed"]).toBe(true);
    expect(records[0]?.["suppressionReason"]).toBe(SUPPRESSION_RESERVED_CATEGORY_HALT);
  });

  test("the evaluation path resolves under the repo root, not the session workspace cwd", () => {
    const strayCwd = mkdtempSync(join(tmpdir(), "mt4117-stray-cwd-"));
    try {
      withProjectDir(projectDir, () =>
        run(
          {
            session_id: "eval-rooting",
            cwd: strayCwd,
            last_assistant_message: R3_FINAL_MESSAGE,
          } as StopHookInput,
          ctx,
          evalStoreDir
        )
      );

      expect(readEvaluationRecords(projectDir)).toHaveLength(1);
      // The defect this guards against: nothing landed under the stray cwd.
      const strayPath = evaluationLogPath("untaken-action", { projectDir: strayCwd });
      expect(existsSync(strayPath)).toBe(false);
    } finally {
      rmSync(strayCwd, { recursive: true, force: true });
    }
  });

  test("with the skip env var set, no evaluation record is written and fire behavior is unchanged", () => {
    process.env[EVALUATION_SKIP_ENV_VAR] = "1";
    const outcome = withProjectDir(projectDir, () =>
      run(
        { session_id: "eval-skip", last_assistant_message: R3_FINAL_MESSAGE } as StopHookInput,
        ctx,
        evalStoreDir
      )
    );
    expect(outcome?.additionalContext ?? "").toContain(FIRED_HEADER);
    expect(readEvaluationRecords(projectDir)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mt#4835 — the present-progressive assertion arm. "Running X now" asserts an
// action is ALREADY UNDERWAY, a stronger claim than "I'll X", and the detector
// matched nothing for it.
//
// Every negative fixture below is VERBATIM from
// `.minsky/untaken-action-calibration.jsonl` (438 real turn-ending tails), not
// invented. That corpus is where the discriminator came from: 9 of the 11
// participle-shaped occurrences in it are gerund SUBJECTS, and six of those are
// the agent explaining why it is deliberately NOT acting.
// ---------------------------------------------------------------------------

describe("present-progressive assertion arm (mt#4835)", () => {
  // The attested miss. The principal caught it: "you said 'Running the dry-run
  // gate now' but then did nothing, why?"
  const SPEC_CASE_1 =
    "Running the dry-run gate now — it's the falsifier that decides A vs B on evidence, " +
    "and it commits to neither.";

  describe("AT1 — the attested miss now matches", () => {
    test("the verbatim incident tail matches the arm", () => {
      const matches = detectPresentProgressiveAssertion(SPEC_CASE_1);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.family).toBe(PRESENT_PROGRESSIVE_FAMILY);
    });

    test("today's phrase families are still silent on it — the negative control", () => {
      // The arm is the ONLY thing that reaches this tail. If this ever starts
      // passing via `detectUntakenAction`, the arm has stopped being the reason
      // the class is covered and this suite is measuring the wrong mechanism.
      expect(detectUntakenAction(SPEC_CASE_1)).toEqual([]);
    });

    test.each([
      ["Filing that as a gap unless you'd rather I leave it."],
      ["Dispatching the reviewer subagent."],
      ["Kicking off the audit pass."],
      ["Filing the umbrella and children next."],
    ])("sibling form matches: %s", (message) => {
      expect(detectPresentProgressiveAssertion(message)).toHaveLength(1);
    });
  });

  describe("AT2 — log-only: it records, it never injects", () => {
    test("a turn matching ONLY the arm produces a calibration record and no advisory", () => {
      const outcome = run(
        { session_id: "pp-log-only", last_assistant_message: SPEC_CASE_1 } as StopHookInput,
        ctx,
        storeDir
      );
      expect(outcome?.calibration).toBeDefined();
      expect(outcome?.additionalContext).toBeUndefined();
    });

    test("the record names the arm so a calibration pass can find it", () => {
      const outcome = run(
        { session_id: "pp-named", last_assistant_message: SPEC_CASE_1 } as StopHookInput,
        ctx,
        storeDir
      );
      expect(outcome?.calibration?.["presentProgressiveArm"]).toEqual(["Running the dry"]);
      expect(outcome?.calibration?.["presentProgressiveArmLogOnly"]).toBe(true);
    });

    test("an injecting family on the SAME turn still injects", () => {
      // The log-only split must scope to the arm, not silence the whole guard.
      const outcome = run(
        {
          session_id: "pp-mixed",
          last_assistant_message: `${SPEC_CASE_1} I'll file it.`,
        } as StopHookInput,
        ctx,
        storeDir
      );
      expect(outcome?.additionalContext ?? "").toContain(FIRED_HEADER);
    });
  });

  describe("AT3 — the gerund-subject class does NOT fire (verbatim corpus fixtures)", () => {
    // Six attested gerund subjects. Each is the participle serving as the
    // SUBJECT of a following finite verb, so it asserts nothing about work in
    // flight — and four of the six are the agent correctly declining to act.
    // Firing here would tell the agent to do what it had just refused, which is
    // the failure class mt#4634 and mt#4438 already track.
    test.each([
      ["Running it is dogfooding the principle."],
      ["Planning it in isolation would produce a plan mt#4113 immediately duplicates."],
      ["Planning it now would either duplicate that work or immediately block on it."],
      ["Planning it now would fork attention while PR #3058 has a CI wait armed."],
      ["Starting it here risks collapsing mid-action, which is the expensive failure."],
      ["Running it turned an honest unknown into a measured negative."],
    ])("gerund subject stays silent: %s", (message) => {
      expect(detectPresentProgressiveAssertion(message)).toEqual([]);
    });
  });

  describe("AT4 — the three long-separation residuals, also excluded", () => {
    // These three separate the gerund from its finite verb by arbitrary
    // material — markdown emphasis, a subordinate clause, an adverbial. A
    // three-word lookahead misses all three; the shipped 60-char window reaches
    // them. Pinned because a later narrowing of that window would silently
    // re-admit them as false positives.
    test.each([
      [
        "Shipping mt#3476 *is* the experiment — and if the predictions don't come back, it's falsified",
      ],
      ["Fixing the docs while leaving that in place would have reproduced the defect."],
      ["Writing it down a fourth time was the failure pattern."],
    ])("long-separation gerund subject stays silent: %s", (message) => {
      expect(detectPresentProgressiveAssertion(message)).toEqual([]);
    });
  });

  describe("AT5 — no regression on the sibling families or the in-flight tunes", () => {
    test.each([
      ["ill-action", "I'll file it."],
      ["going-to", "I'm going to write the PR."],
      ["say-the-word", "Say the word and I'll merge."],
    ])("%s still fires", (_family, message) => {
      expect(detectUntakenAction(message).length).toBeGreaterThan(0);
    });

    test("the arm adds nothing to a `next-up` shape (mt#4560 is tuning that FP down)", () => {
      // mt#4560's false positive is a third-person description of a FILED
      // task's next step. The arm must not become a second way for that same
      // message to fire, which would make mt#4560's tune harder rather than
      // easier.
      const nextUp = "Next up is mt#4560, which tunes the `next-up` family.";
      expect(detectPresentProgressiveAssertion(nextUp)).toEqual([]);
    });

    test("suppression patterns are honoured — the arm is not a bypass", () => {
      // An armed-wait sign-off is exactly the behavior `work-completion.mdc`
      // prescribes; the arm reuses SUPPRESSION_PATTERNS so it cannot re-open a
      // hole the phrase side already closed.
      expect(
        detectPresentProgressiveAssertion("Filing that now — I'll report back when it lands.")
      ).toEqual([]);
    });

    test("a quoted commitment does not fire (elision is applied)", () => {
      expect(detectPresentProgressiveAssertion('The detector matches "Filing that now".')).toEqual(
        []
      );
    });
  });
});
