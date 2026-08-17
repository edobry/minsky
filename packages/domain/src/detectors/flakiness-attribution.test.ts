/**
 * Flakiness-attribution matcher (mt#3658).
 *
 * The acceptance tests are the spec's own, in its numbering: AT1 (fires with no
 * evidence), AT2 (a recorded control silences it), AT3 (the UNVERIFIED marker
 * silences it), AT4 (no vocabulary → no run), AT6 (the negated form fires).
 * AT5 — the negative control proving the evidence check is load-bearing and not
 * just the vocabulary match — is the pair of `hasIsolationControl` cases plus
 * the AT1/AT2 contrast on ONE spec body.
 */
/* eslint-disable custom/no-real-fs-in-tests --
   Reads one real committed fixture, `__fixtures__/mt4158-spec.md`, which is the
   verbatim spec this detector failed to fire on. That is the opposite of the
   mutable test-state faking this rule exists to stop, and it follows the
   existing precedent in `tests/integration/clear-ambiguous-spawn-links.*`
   (reading the real committed migration journal). A text import would avoid
   `fs` but needs a repo-wide ambient `*.md` module declaration this codebase
   does not have, which is a much broader change than the need justifies. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectFlakinessAttribution,
  extractFlakinessClaims,
  hasIsolationControl,
  hasLoadControl,
  hasUnverifiedMarkerNearClaim,
} from "./flakiness-attribution";

/** The spec body every case varies, so the contrast is the evidence alone. */
const FLAKY_SPEC = [
  "## Summary",
  "",
  "`src/foo/bar.test.ts` fails intermittently under load in the gated suite.",
  "It looks load-dependent rather than a real defect.",
].join("\n");

const CONTROL_EVIDENCE = [
  "",
  "## Isolation control",
  "",
  "`bun test --preload ./tests/setup.ts --timeout=15000 src/foo/bar.test.ts`",
  "→ 17 pass / 0 fail (249ms)",
].join("\n");

describe("detectFlakinessAttribution (mt#3658)", () => {
  test("AT1: a flakiness attribution with no control evidence matches", () => {
    const result = detectFlakinessAttribution(FLAKY_SPEC);

    expect(result.matched).toBe(true);
    expect(result.hasIsolationControl).toBe(false);
    expect(result.hasUnverifiedMarker).toBe(false);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims.some((c) => c.family === "attribution")).toBe(true);
    // The record has to carry what tripped it, per guard-feedback-authoring's
    // quoted-evidence requirement.
    expect(result.claims[0]?.excerpt).toContain("intermittently");
  });

  test("AT2: the same spec plus a recorded control does NOT match", () => {
    const result = detectFlakinessAttribution(FLAKY_SPEC + CONTROL_EVIDENCE);

    expect(result.hasIsolationControl).toBe(true);
    expect(result.matched).toBe(false);
    // The vocabulary still matched — only the evidence changed. This is AT5's
    // point: the evidence check, not the vocabulary, is what silences it.
    expect(result.claims.length).toBeGreaterThan(0);
  });

  test("AT3: the same spec plus the literal UNVERIFIED does NOT match", () => {
    const spec = `${FLAKY_SPEC}\n\nUNVERIFIED as load-dependent — isolation control not run.`;
    const result = detectFlakinessAttribution(spec);

    expect(result.hasUnverifiedMarker).toBe(true);
    expect(result.matched).toBe(false);
  });

  test("AT4: a spec with no flakiness vocabulary does not run", () => {
    const spec = "## Summary\n\nAdd a --dry-run flag to session delete.";
    const result = detectFlakinessAttribution(spec);

    expect(result.claims).toEqual([]);
    expect(result.matched).toBe(false);
  });

  test("AT6: the negated form fires — a denial is the same claim class (mt#3719)", () => {
    // Verbatim shape of mt#3719's spec, which read as the careful verdict and
    // was falsified by the control four minutes later.
    const spec = [
      "## Not a flake — the distinction matters for how it gets fixed",
      "",
      "It is not load-dependent and not timing-dependent: it fails deterministically",
      "wherever persistence resolves, and passes deterministically where it does not.",
    ].join("\n");

    const result = detectFlakinessAttribution(spec);

    expect(result.matched).toBe(true);
    expect(result.claims.some((c) => c.family === "denial")).toBe(true);
  });

  test("a denial is recorded as a denial, not swallowed by the attribution it contains", () => {
    const claims = extractFlakinessClaims("It is not load-dependent.");
    const forPhrase = claims.find((c) => /not load/i.test(c.phrase));

    expect(forPhrase?.family).toBe("denial");
  });
});

describe("hasIsolationControl", () => {
  test("requires BOTH an invocation and an observed count", () => {
    // A bare command is a plan, not an observation.
    expect(hasIsolationControl("bun test --timeout=15000 src/foo.test.ts")).toBe(false);
    // A count with no command could be quoting anything.
    expect(hasIsolationControl("17 pass / 0 fail")).toBe(false);
    expect(hasIsolationControl("bun test src/foo.test.ts → 17 pass / 0 fail")).toBe(true);
  });

  test("accepts the gated-runner form", () => {
    expect(hasIsolationControl("bun scripts/run-tests-gated.ts → 1533 pass")).toBe(true);
  });

  test("accepts a fail-only observation — a control that FAILS is the useful one", () => {
    // mt#3557's control failed in isolation, which is what falsified the flake
    // reading. A matcher requiring a pass count would miss exactly that case.
    expect(hasIsolationControl("bun test src/foo.test.ts → 0 pass / 3 fail")).toBe(true);
  });
});

describe("hasUnverifiedMarkerNearClaim", () => {
  const claims = extractFlakinessClaims("The suite is flaky under load.");

  test("accepts a marker beside the claim", () => {
    expect(hasUnverifiedMarkerNearClaim("The suite is flaky under load. UNVERIFIED.", claims)).toBe(
      true
    );
  });

  test("rejects a marker far from the claim — §2b says 'near the attribution'", () => {
    // A spec that marks some OTHER claim UNVERIFIED has not marked this one.
    const spec = `The suite is flaky under load.${"\n".repeat(50)}${"x".repeat(900)}UNVERIFIED`;
    expect(hasUnverifiedMarkerNearClaim(spec, claims)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mt#4166 — the two silencers that kept this quiet on mt#4158
// ---------------------------------------------------------------------------

/**
 * Every negative assertion below is preceded by a POSITIVE liveness assertion on
 * the same fixture, per mem#1020: a fixture that matches nothing passes
 * `toEqual([])` forever AND survives its own negative control, because "nothing
 * matched" is stable whether or not the code under test is disabled. Asserting
 * the fixture is live first turns that silent pass into a loud failure.
 */
describe("mt#4166: a denial is not discharged by single-condition counts", () => {
  // The fixture is the real mt#4158 spec, verbatim and WHOLE — both are
  // load-bearing. The original filing measured this on an EXCERPT and recorded
  // `hasUnverifiedMarker: false`; on the full text it is true, via a marker
  // 2,146 characters from the denial it excused. An abridged fixture reproduces
  // the mis-measurement rather than the defect, which is why it lives in a file
  // (its prose is full of backticks that no template literal survives intact).

  const MT4158_SPEC = readFileSync(join(import.meta.dir, "__fixtures__/mt4158-spec.md"), "utf8");

  /** The denial under test, shared so each case varies only its EVIDENCE. */
  const DENIAL_LINE = "The failure is not load-dependent — it fails deterministically.";

  test("AT1: the mt#4158 spec fires (it did not before this change)", () => {
    const result = detectFlakinessAttribution(MT4158_SPEC);

    // Liveness first: the fixture must actually reach the denial matcher.
    const denial = result.claims.find((c) => c.family === "denial");
    expect(denial?.phrase.toLowerCase()).toBe("not flaky");

    expect(result.matched).toBe(true);
    // The denial is what carries the fire: unexcused on both axes.
    expect(denial?.controlled).toBe(false);
    expect(denial?.markedUnverified).toBe(false);

    // Both pre-fix silencers are still PRESENT — they simply no longer reach
    // this claim. That is the whole change, and asserting it here is what
    // distinguishes the fix from having merely deleted the silencers.
    expect(result.hasIsolationControl).toBe(true);
    expect(result.hasUnverifiedMarker).toBe(true);
    expect(result.hasLoadControl).toBe(false);
  });

  test("AT2: silencer 1 alone — a denial plus one run's counts fires", () => {
    const spec = [
      "## Summary",
      "",
      "`src/foo/bar.test.ts` fails 12 of 67. It is not load-dependent — it fails",
      "deterministically wherever persistence resolves.",
      "",
      "## Isolation control",
      "",
      "`bun test --preload ./tests/setup.ts src/foo/bar.test.ts`",
      "→ 55 pass / 12 fail",
    ].join("\n");

    const result = detectFlakinessAttribution(spec);

    const denial = result.claims.find((c) => c.family === "denial");
    expect(denial).toBeDefined();

    // The counts ARE recorded — this fixture isolates silencer 1 by removing
    // every other excuse, so the only reason it used to stay quiet was that
    // `hasIsolationControl` was read as sufficient for a denial.
    expect(result.hasIsolationControl).toBe(true);
    expect(result.hasUnverifiedMarker).toBe(false);
    expect(denial?.controlled).toBe(false);
    expect(result.matched).toBe(true);
  });

  test("AT3: silencer 2 alone — a marker near an unrelated claim no longer excuses the denial", () => {
    // The mt#4158 shape, minimised: a denial at the top, and >600 chars later an
    // honest UNVERIFIED attached to a different proposition that happens to sit
    // beside the word "intermittently".
    const filler = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i} of unrelated background about the service's boot sequence.`
    ).join("\n");
    const spec = [
      "## Summary",
      "",
      DENIAL_LINE,
      "",
      filler,
      "",
      "Separately, MCP calls were intermittently slow during this window; whether",
      "that shares a root cause with the boot latency is UNVERIFIED.",
    ].join("\n");

    const result = detectFlakinessAttribution(spec);

    const denial = result.claims.find((c) => c.family === "denial");
    const marked = result.claims.filter((c) => c.markedUnverified);
    expect(denial).toBeDefined();
    // Liveness on the OTHER half too: the marker must really be excusing
    // something, or this fixture would prove nothing about scoping.
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((c) => c.family === "attribution")).toBe(true);

    // No counts anywhere, so silencer 1 is out of the picture by construction.
    expect(result.hasIsolationControl).toBe(false);
    expect(result.hasUnverifiedMarker).toBe(true);
    expect(denial?.markedUnverified).toBe(false);
    expect(result.matched).toBe(true);
  });

  test("AT4: the authored Load control record silences a denial, in each accepted form", () => {
    const denialSpec = ["## Summary", "", DENIAL_LINE, ""].join("\n");

    // Liveness: without the record this fixture fires. Every negative assertion
    // below is therefore a real change of state, not an inert fixture.
    expect(detectFlakinessAttribution(denialSpec).matched).toBe(true);

    // What a real record says under the label: both runs, each with its command
    // and its counts. Its own prose contains "under load" — an attribution
    // phrase — and a real record discharges that itself, because the counts are
    // exactly the evidence an attribution takes. A label with no body would
    // leave that incidental claim lit, which is correct and is why the body is
    // part of the fixture rather than omitted for brevity.
    const RECORD_BODY = [
      "",
      "`bun test src/foo/bar.test.ts` alone → 67 pass / 0 fail",
      "`bun test src/foo/bar.test.ts` under load → 55 pass / 12 fail",
    ].join("\n");

    const forms = [
      "Load control:",
      "## Load control",
      "### Load control:",
      "**Load control:**",
      "- **Load control** — isolated vs full-suite",
    ];

    for (const form of forms) {
      const result = detectFlakinessAttribution(`${denialSpec}\n${form}${RECORD_BODY}\n`);
      expect({ form, matched: result.matched, hasLoadControl: result.hasLoadControl }).toEqual({
        form,
        matched: false,
        hasLoadControl: true,
      });
    }
  });

  test("AT4b: a FENCED Load control label does not silence (the mt#3511 trap)", () => {
    const spec = [
      "## Summary",
      "",
      DENIAL_LINE,
      "",
      "The convention to use here is:",
      "",
      "```",
      "Load control: isolated 67/67, under load 55/67.",
      "```",
    ].join("\n");

    const result = detectFlakinessAttribution(spec);

    expect(result.claims.some((c) => c.family === "denial")).toBe(true);
    expect(result.hasLoadControl).toBe(false);
    expect(result.matched).toBe(true);
  });

  test("AT5: the attribution family is unchanged — one run's counts still silence it", () => {
    // Liveness: the same body without the control fires.
    expect(detectFlakinessAttribution(FLAKY_SPEC).matched).toBe(true);

    const result = detectFlakinessAttribution(FLAKY_SPEC + CONTROL_EVIDENCE);

    expect(result.claims.some((c) => c.family === "attribution")).toBe(true);
    expect(result.claims.some((c) => c.family === "denial")).toBe(false);
    expect(result.claims.every((c) => c.controlled)).toBe(true);
    expect(result.matched).toBe(false);
  });

  test("AT6: a marker in the denial's own sentence still silences it", () => {
    const spec = "The failure is not load-dependent — UNVERIFIED, the control was not run.";
    const result = detectFlakinessAttribution(spec);

    const denial = result.claims.find((c) => c.family === "denial");
    expect(denial).toBeDefined();
    expect(denial?.markedUnverified).toBe(true);
    expect(result.matched).toBe(false);
  });
});

describe("hasLoadControl", () => {
  /** The record itself: two runs under two conditions, each with counts. */
  const RECORD = [
    "`bun test src/foo/bar.test.ts` alone → 67 pass / 0 fail",
    "`bun test src/foo/bar.test.ts` under load → 55 pass / 12 fail",
  ].join("\n");

  test("accepts every label form authors write, when a record backs it", () => {
    expect(hasLoadControl(`Load control:\n${RECORD}`)).toBe(true);
    expect(hasLoadControl(`## Load control\n${RECORD}`)).toBe(true);
    expect(hasLoadControl(`###### Load control:\n${RECORD}`)).toBe(true);
    expect(hasLoadControl(`**Load control:**\n${RECORD}`)).toBe(true);
    expect(hasLoadControl(`- **Load control** — isolated vs full-suite\n${RECORD}`)).toBe(true);
    expect(hasLoadControl(`  load control:\n${RECORD}`)).toBe(true);
  });

  test("rejects the label with no record behind it (PR #3034 R1)", () => {
    // The label is a heading FOR the record, not the record. Each of these
    // carries the label and asserts the OPPOSITE of compliance, so accepting
    // them would silence exactly the denial the guard exists to surface.
    expect(hasLoadControl("Load control: was never run for this failure.")).toBe(false);
    expect(hasLoadControl("## Load control")).toBe(false);
    expect(hasLoadControl("**Load control:** pending — will run before merge.")).toBe(false);
    expect(hasLoadControl("Load control — TODO")).toBe(false);
  });

  test("rejects a ONE-run record — a denial is a claim across conditions", () => {
    expect(hasLoadControl("Load control:\n`bun test src/foo/bar.test.ts` → 67 pass / 0 fail")).toBe(
      false
    );
  });

  test("rejects two runs with no observed counts — a plan, not an observation", () => {
    expect(
      hasLoadControl(
        "Load control:\n`bun test src/foo.test.ts` alone\n`bun test src/foo.test.ts` under load"
      )
    ).toBe(false);
  });

  test("rejects a record too far from the label to be its record", () => {
    const gap = "x".repeat(700);
    expect(hasLoadControl(`Load control:\n${gap}\n${RECORD}`)).toBe(false);
  });

  test("rejects a bare mention that asserts nothing", () => {
    expect(hasLoadControl("We should add a load control here.")).toBe(false);
    expect(hasLoadControl("")).toBe(false);
  });

  test("rejects a fenced label — quoted, not asserted", () => {
    expect(hasLoadControl(`\`\`\`\nLoad control:\n${RECORD}\n\`\`\``)).toBe(false);
    expect(hasLoadControl(`~~~\nLoad control:\n${RECORD}\n~~~`)).toBe(false);
    // ...and still finds a real one after the fence closes.
    expect(hasLoadControl(`\`\`\`\nLoad control: quoted\n\`\`\`\n\nLoad control:\n${RECORD}`)).toBe(
      true
    );
  });
});
