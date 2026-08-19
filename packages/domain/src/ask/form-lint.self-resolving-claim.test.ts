/**
 * mt#4315 — the `asserted-not-self-resolving` check, asserted against the REAL
 * incident-ask corpus rather than against invented text.
 *
 * The positives are the two asks that produced the check; the negatives are
 * sampled verbatim from the other incident asks that existed when it was
 * written (12 total, 2026-08-05 → 2026-08-19). Fixtures are VERBATIM per
 * mem#1020: a paraphrased detector fixture can reach no matcher, and then a
 * negative assertion passes forever AND survives its own negative control.
 *
 * **The load-bearing tests here are the negatives**, and that is not the usual
 * shape. This pattern was written FROM the two positives, so their recall is
 * fitted rather than predicted and proves little on its own. What the negatives
 * establish is that the fitted pattern does not spray across the rest of the
 * corpus — including ask#7484, a genuine incident that genuinely could not
 * self-resolve, which is exactly the case a sloppier pattern would swallow.
 *
 * Every negative carries a LIVENESS control: the same fixture with the
 * vocabulary appended MUST fire. Without it, "does not fire" would pass against
 * an inert harness just as happily as against a working one.
 */
import { describe, test, expect } from "bun:test";
import {
  computeFormLintMatches,
  NOT_SELF_RESOLVING_PATTERN,
  type FormLintInput,
} from "./form-lint";

/**
 * ask#9278's ORIGINAL question, created 2026-08-19T03:01:12Z. Verbatim excerpt.
 *
 * Recovered from the authoring conversation's raw transcript, NOT from the ask
 * record — that record was edited twice into a RESOLVED notice and no longer
 * contains this text. `metadata.editHistory` retains the editor, the timestamps
 * and the field NAMES changed, but not the prior values, so the escalated text
 * survives only here and in the transcript. Pin it; do not re-read it from the
 * substrate.
 *
 * mt#4329 closed that gap — an ask edited today preserves its pre-edit content
 * under `metadata.originalContent`. It is not retroactive, so ask#9278 stays
 * unrecoverable from the record and this literal stays the source of truth for
 * it. A future fixture from a POST-mt#4329 ask can read the substrate instead.
 */
const ASK_9278_ORIGINAL = `**May I run \`pg_terminate_backend\` on the ~10 wedged Supavisor backends?** It fixes this in about a minute and aborts whatever those clients were mid-transaction on — possibly another agent's in-flight commit. Shared prod state, so it is your call.

**Options:**
- **(a) Terminate them — recommended, needs your yes.**
- **(c) Wait.** They block on \`ClientRead\`, so statement timeouts will not reap them; already held ~14 min with no sign of clearing.`;

/** ask#9279, created 2026-08-19T03:02:12Z — 40 seconds later. Verbatim excerpt. */
const ASK_9279 = `May I run pg_terminate_backend on the 16 backends stuck in state='active', wait_event='ClientRead', older than 5 minutes?

Wedged, not transient: count held at exactly 16 across ~5 minutes while ages advanced 576s->858s, and they survived a restart of my MCP server.`;

/**
 * Real incident asks that do NOT assert persistence. Verbatim excerpts.
 *
 * `ask#7484` is the important one: a 4-day-old image serving because a redeploy
 * call returns `Not Authorized` is an incident that CANNOT self-resolve — no
 * amount of waiting grants a permission. It must stay silent, because the check
 * is about an unsupportable prediction, not about incidents in general.
 */
const NEGATIVES: readonly { id: string; question: string }[] = [
  {
    id: "ask#6977",
    question: `**Only you can grant this — I can't self-grant a merge-gate override.** PR #2640 is otherwise done and green. The bot blocked on \`src/generated/\` being edited directly.`,
  },
  {
    id: "ask#7484",
    question: `**Hosted \`minsky-mcp\` is serving a 4-day-old image.** Every "Deploy MCP" run since 2026-08-05 went green without deploying: the redeploy call returns \`Not Authorized\`, and that step is warn-only.`,
  },
  {
    id: "ask#7793",
    question: `\`@edobry/minsky@0.1.1\` is still the published latest and still declares 2 deps at \`workspace:*\`, so \`bun add -g @edobry/minsky\` fails for every user outside this monorepo.`,
  },
  {
    id: "ask#9214",
    question: `**Premise falsified 2026-08-19T02:26Z. No action needed — close when you see this.** The token was authenticating throughout.`,
  },
];

/**
 * Built with an EXPLICIT severity argument rather than a defaulted one.
 *
 * An earlier revision took `severity: string | undefined = "incident"`, and the
 * AT3 case called it as `incidentInput(text, undefined)` — which re-triggers the
 * default, so that test asserted "severity absent does not fire" while actually
 * passing `"incident"`. It failed loudly here, but the shape is the one that
 * usually does not (mem#704): had the check been severity-blind, the same call
 * would have passed while proving nothing.
 */
function lintInput(question: string, severity: string | undefined): FormLintInput {
  return {
    kind: "authorization.approve",
    question,
    options: [{ label: "Approve" }],
    forceImmediate: true,
    severity,
  };
}

const incidentInput = (question: string): FormLintInput => lintInput(question, "incident");

const fired = (input: FormLintInput): boolean =>
  computeFormLintMatches(input).some((m) => m.check === "asserted-not-self-resolving");

describe("AT1 — the originating pair fires", () => {
  test("ask#9278's original question fires", () => {
    expect(fired(incidentInput(ASK_9278_ORIGINAL))).toBe(true);
  });

  test("ask#9279 fires", () => {
    expect(fired(incidentInput(ASK_9279))).toBe(true);
  });

  test("BOTH stated an observation window — the check fires anyway, by design", () => {
    // This is the whole reason the trigger is the assertion rather than a
    // missing window. If a future change re-scopes the check to "asserts AND
    // states no window", these two inputs stop firing and the check covers
    // nothing that has ever actually happened.
    expect(ASK_9278_ORIGINAL).toContain("~14 min");
    expect(ASK_9279).toContain("~5 minutes");
    expect(fired(incidentInput(ASK_9278_ORIGINAL))).toBe(true);
    expect(fired(incidentInput(ASK_9279))).toBe(true);
  });

  test("the message names the category-(b) alternative, not just the omission", () => {
    const match = computeFormLintMatches(incidentInput(ASK_9279)).find(
      (m) => m.check === "asserted-not-self-resolving"
    );
    expect(match).toBeDefined();
    expect(match?.message).toContain("arm a watcher");
    expect(match?.message).toContain("External");
    // It must NOT ask for a window — that is the specced behavior this task
    // measured and rejected.
    expect(match?.message ?? "").not.toContain("state the window");
  });
});

describe("AT2 — the rest of the incident corpus stays silent", () => {
  for (const negative of NEGATIVES) {
    test(`${negative.id} does not fire`, () => {
      expect(fired(incidentInput(negative.question))).toBe(false);
    });

    test(`${negative.id} liveness: the same input DOES fire once the vocabulary is present`, () => {
      // Without this, the silence above is indistinguishable from a fixture
      // that never reaches the matcher at all (mem#1020).
      const withClaim = `${negative.question}\n\nThis is wedged, not draining.`;
      expect(fired(incidentInput(withClaim))).toBe(true);
    });
  }

  test("an incident that genuinely cannot self-resolve is silent — the case that matters", () => {
    // A revoked permission does not drain on its own. The check exists to
    // question an unsupportable prediction, not to discourage escalation.
    const unauthorized = NEGATIVES.find((n) => n.id === "ask#7484");
    expect(unauthorized).toBeDefined();
    expect(fired(incidentInput(unauthorized?.question ?? ""))).toBe(false);
  });
});

describe("AT3 — severity gates the check", () => {
  test("an ask with NO severity and identical text does not fire", () => {
    expect(fired(lintInput(ASK_9279, undefined))).toBe(false);
  });

  test("a non-incident severity with identical text does not fire", () => {
    expect(fired(lintInput(ASK_9279, "routine"))).toBe(false);
  });

  test("liveness: the same text at severity 'incident' DOES fire", () => {
    // Pins that the two silences above are the severity gate doing its job,
    // not the fixture failing to reach the matcher.
    expect(fired(lintInput(ASK_9279, "incident"))).toBe(true);
  });
});

/** One phrase, quoted verbatim from ask#9278's original question. */
const OBSERVED_PHRASE = "no sign of clearing";

describe("the pattern itself", () => {
  test("matches the phrasings observed in the corpus", () => {
    expect(NOT_SELF_RESOLVING_PATTERN.test(OBSERVED_PHRASE)).toBe(true);
    expect(NOT_SELF_RESOLVING_PATTERN.test("Wedged, not transient")).toBe(true);
    expect(NOT_SELF_RESOLVING_PATTERN.test("statement timeouts will not reap them")).toBe(true);
  });

  test("does not match ordinary incident prose", () => {
    expect(NOT_SELF_RESOLVING_PATTERN.test("the service is down and returning 502")).toBe(false);
    expect(NOT_SELF_RESOLVING_PATTERN.test("the deploy went green without deploying")).toBe(false);
    expect(NOT_SELF_RESOLVING_PATTERN.test("I am waiting for the pool to drain")).toBe(false);
  });

  test("a flat MEASUREMENT is not an assertion of permanence (PR #3158 R2)", () => {
    // `held steady` was in the pattern and is gone. It matched 0 of the 2 corpus
    // fires while describing a shape benign incident prose takes constantly, so
    // it was pure false-positive surface. These pin the removal: reporting that
    // a number did not move is a measurement, and the check is about the
    // PREDICTION someone draws from it.
    expect(NOT_SELF_RESOLVING_PATTERN.test("the rate held steady at 2/s for three minutes")).toBe(
      false
    );
    expect(NOT_SELF_RESOLVING_PATTERN.test("the count held steady at 16")).toBe(false);
    // …and the assertion drawn FROM that measurement still fires, so removing
    // the term cost no recall on the case that matters.
    expect(
      NOT_SELF_RESOLVING_PATTERN.test("the count held steady at 16 — wedged, not draining")
    ).toBe(true);
  });

  test("is stateless across calls — no lastIndex carryover", () => {
    // A /g regex would alternate true/false here. It has no `g` flag; this
    // pins that, because the check calls .test() once per ask and a carryover
    // would make every second incident silent.
    expect(NOT_SELF_RESOLVING_PATTERN.test(OBSERVED_PHRASE)).toBe(true);
    expect(NOT_SELF_RESOLVING_PATTERN.test(OBSERVED_PHRASE)).toBe(true);
  });
});
