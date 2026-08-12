/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read) in an isolated mkdtemp dir, mirroring turn-end-retro-scan.test.ts's precedent */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectUntakenAction,
  detectReservedCategoryHalt,
  run,
  TAIL_WINDOW_CHARS,
  OVERRIDE_ENV_VAR,
  SUPPRESSION_DEDUPED_BY_ASK_ROUTING_DEFERRAL,
  SUPPRESSION_RESERVED_CATEGORY_HALT,
} from "./turn-end-untaken-action-scan";
import type { StopHookInput } from "./turn-end-retro-scan";
import { GUARD_REGISTRY, type DispatchContext } from "./registry";
import { STOP_INJECTED_OVERLAP_FAMILY, readFlagged } from "./turn-end-scan-store";

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

    describe("mt#3948 — the armed-watcher suppression is not bound to one word order", () => {
      // The four attested closing messages, verbatim from the 2026-08-10 and 2026-08-11
      // calibration windows. Each reports a wait the agent armed ITSELF and then keeps going,
      // which is what `work-completion.mdc §External self-resolving waits` prescribes.
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
      ])("suppresses: %s", (_label, message) => {
        expect(detectUntakenAction(message)).toEqual([]);
      });

      test("the pre-existing word order still suppresses", () => {
        // The two retired patterns' own shapes, so the widening cannot regress them.
        expect(
          detectUntakenAction("A retry watcher is armed; I'll re-attempt when it fires.")
        ).toEqual([]);
        expect(
          detectUntakenAction("I armed a background poll; I'll merge the PR when it clears.")
        ).toEqual([]);
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
