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
