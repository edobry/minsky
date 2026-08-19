// Tests for the Rung-2 symbol-FREE claim cohort (mt#3726).
//
// The gap this covers is one step past mt#4155's. That class is symbol-BEARING
// and predicate-free: `symbolsNear` extracts `X` from "`X` is the single
// reader" and only the PREDICATE match fails, so its claims still render as
// (symbol, predicate) pairs. These classes name no symbol at all — measured by
// `symbolsNear` returning `[]` on one sentence per class, against controls that
// extract theirs — so symbol extraction cannot be how they become claims.
//
// Like the identity tests, these exercise the PURE seam with an injected
// nominator and need no embedding provider. What a stub CANNOT answer is
// whether the real embedding actually scores these sentences above threshold
// against these exemplars; that is a live-provider question, answered by
// `scripts/verify-symbol-free-nomination.ts` and recorded in the PR body.

import { describe, test, expect } from "bun:test";
import {
  detectCodeMechanismAssertion,
  augmentWithIdentityNomination,
  dedupeSymbolFreeClaims,
  collectSymbolFreeClaims,
  buildSymbolFreeWarning,
  isSymbolFreeFamily,
  isSymbolFreeCohortDisabled,
  activeExemplarSets,
  symbolsNear,
  IDENTITY_CLAIM_FAMILY,
  SYMBOL_FREE_EXEMPLAR_SETS,
  SYMBOL_FREE_FAMILIES,
  SYMBOL_FREE_SKIP_ENV_VAR,
  INVOCATION_PATH_POSITIVE_FAMILY,
  INVOCATION_PATH_NEGATIVE_FAMILY,
  SUBSYSTEM_PROPERTY_FAMILY,
  EXTERNAL_SYSTEM_FAMILY,
  LOG_ATTRIBUTION_FAMILY,
} from "./code-mechanism-assertion-detector";
import type { IdentityClaimNominator } from "./code-mechanism-assertion-detector";

/**
 * One real sentence per class, drawn from the incident that produced it. These
 * are the fixtures mt#3726's success criteria name, quoted rather than
 * paraphrased so a future reader can trace each back to its record.
 */
const CLASS_FIXTURES: ReadonlyArray<{ family: string; sentence: string; origin: string }> = [
  {
    family: INVOCATION_PATH_POSITIVE_FAMILY,
    sentence: "The missing rows self-heal on the next scheduled run.",
    origin: "mt#3708 / mem#873 — the originating incident",
  },
  {
    family: INVOCATION_PATH_NEGATIVE_FAMILY,
    sentence: "You'll need to run that manually; it won't refresh on its own.",
    origin: "mem#873 R2 — the negative sign",
  },
  {
    family: SUBSYSTEM_PROPERTY_FAMILY,
    sentence: "Two of the three cockpit daemons are stale.",
    origin: "mem#1087 — property claim bounded to the component that was open",
  },
  {
    family: EXTERNAL_SYSTEM_FAMILY,
    sentence: "The repo auto-closes issues after 60 days via a workflow bug.",
    origin: "mt#3726 §Sibling shape — relayed external-system mechanism",
  },
  {
    family: LOG_ATTRIBUTION_FAMILY,
    sentence: "The log shows an unhandled rejection, so the boot migration failure is unhandled.",
    origin: "mem#1123 R9 — a present log line attributed to the path under investigation",
  },
];

/** The behaviour SC6 protects: naming your own caller is the encouraged shape. */
const NEGATIVE_CONTROL = "The `transcripts spawns-extract --all` command runs this.";

/** Nominates every fixture sentence it is handed, tagged with that class's family. */
function nominatorFor(family: string): IdentityClaimNominator {
  return async (prose) => ({ kind: "nominated", segments: [{ family, segment: prose }] });
}

/**
 * Run `fn` with one env var set, restoring whatever was there before.
 *
 * Extracted per PR #3178 R1 (non-blocking): three call sites across two files
 * were each hand-rolling save/set/finally-restore, and a later early return or
 * an added assertion above the `finally` would silently leak the mutation into
 * every test that ran after it. Exported so the identity tests use the same one
 * rather than keeping their own copy — the point of the nit was the duplication,
 * so fixing it in one file only would have missed it.
 */
export function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

describe("symbol-free claim cohort (mt#3726)", () => {
  test("every class fixture is symbol-free — the premise the cohort rests on", () => {
    for (const { family, sentence, origin } of CLASS_FIXTURES) {
      const symbols = symbolsNear(sentence, Math.floor(sentence.length / 2), sentence.length);
      expect({ family, origin, symbols }).toEqual({ family, origin, symbols: [] });
    }
  });

  test("POSITIVE CONTROL: a symbol-bearing sentence still extracts, so the probe can fail", () => {
    // Without this the assertion above is a probe that returns the same answer
    // whether or not `symbolsNear` works at all (mem#704).
    const text = "AgentSpawnsPipeline wires only runForSession for newly-ingested transcripts.";
    const symbols = symbolsNear(text, Math.floor(text.length / 2), text.length);
    expect(symbols).toContain("AgentSpawnsPipeline");
  });

  test("the lexical path is silent on every class fixture — the documented gap", () => {
    for (const { sentence } of CLASS_FIXTURES) {
      expect(detectCodeMechanismAssertion(sentence, "").matched).toBe(false);
    }
  });

  test("a nominated class fixture becomes a symbol-free claim of its own family", async () => {
    for (const { family, sentence } of CLASS_FIXTURES) {
      const base = detectCodeMechanismAssertion(sentence, "");
      const augmented = await augmentWithIdentityNomination(
        base,
        sentence,
        "",
        "",
        nominatorFor(family)
      );
      expect(augmented.symbolFreeClaims).toEqual([
        { family, excerpt: expect.stringContaining(sentence.slice(0, 20)) },
      ]);
    }
  });

  test("a symbol-free claim does NOT flip `matched` — it must not reach injection", async () => {
    // `matched` drives the injection branch and `buildInjectionReminder`, both
    // of which name a symbol back to the agent. This cohort has no suppression
    // yet, so flipping `matched` would promote an unsuppressed cohort straight
    // to operator-facing injection.
    const { sentence, family } = CLASS_FIXTURES[0] as (typeof CLASS_FIXTURES)[number];
    const base = detectCodeMechanismAssertion(sentence, "");
    const augmented = await augmentWithIdentityNomination(
      base,
      sentence,
      "",
      "",
      nominatorFor(family)
    );
    expect(augmented.matched).toBe(false);
    expect(augmented.claims).toEqual([]);
    expect(augmented.detectionRung).toBe("1-lexical");
  });

  test("NEGATIVE CONTROL: naming your own caller yields no symbol-free claim", async () => {
    // Asserted against the NOMINATOR, not the lexical path: mt#3726's planning
    // pass measured that the lexical path is quiet on this sentence only because
    // it is quiet on the whole class, which would make a lexical assertion here
    // vacuous. A nominator that declines it is the real test.
    const declining: IdentityClaimNominator = async () => ({ kind: "none" });
    const base = detectCodeMechanismAssertion(NEGATIVE_CONTROL, "");
    const augmented = await augmentWithIdentityNomination(
      base,
      NEGATIVE_CONTROL,
      "",
      "",
      declining
    );
    expect(augmented.symbolFreeClaims).toBeUndefined();
    expect(augmented.detectionRung).toBe("1-lexical");
  });

  test("an identity nomination still takes the symbol path, unchanged by this cohort", async () => {
    const text = "`resolveNominationDeps` is the single reader of that value.";
    const base = detectCodeMechanismAssertion(text, "");
    const augmented = await augmentWithIdentityNomination(
      base,
      text,
      "",
      "",
      nominatorFor(IDENTITY_CLAIM_FAMILY)
    );
    expect(augmented.symbolFreeClaims).toBeUndefined();
    expect(augmented.claims.map((c) => c.symbol)).toContain("resolveNominationDeps");
    expect(augmented.detectionRung).toBe("2-embedding");
  });

  test("the five families are distinct and every exemplar set is non-empty", () => {
    expect(SYMBOL_FREE_FAMILIES).toHaveLength(5);
    expect(new Set(SYMBOL_FREE_FAMILIES).size).toBe(5);
    for (const set of SYMBOL_FREE_EXEMPLAR_SETS) {
      expect(set.exemplars.length).toBeGreaterThan(0);
      for (const exemplar of set.exemplars) {
        // Same discipline as the identity set: the embedding scores GRAMMAR, so
        // a concrete identifier would bias scores toward turns discussing it.
        expect(exemplar).not.toContain("`");
      }
    }
  });

  test("every class fixture's family is a real member of the cohort", () => {
    for (const { family } of CLASS_FIXTURES) {
      expect(isSymbolFreeFamily(family)).toBe(true);
    }
    expect(isSymbolFreeFamily(IDENTITY_CLAIM_FAMILY)).toBe(false);
  });

  test("dedupe keeps one claim per family and truncates safely", () => {
    const claims = dedupeSymbolFreeClaims([
      { family: SUBSYSTEM_PROPERTY_FAMILY, segment: "first one wins" },
      { family: SUBSYSTEM_PROPERTY_FAMILY, segment: "second is dropped" },
      { family: LOG_ATTRIBUTION_FAMILY, segment: `${"x".repeat(400)} — trailing em dash prose` },
    ]);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual({ family: SUBSYSTEM_PROPERTY_FAMILY, excerpt: "first one wins" });
    expect((claims[1] as { excerpt: string }).excerpt.length).toBeLessThanOrEqual(130);
  });

  test("collect returns undefined when nothing nominated, so old records stay distinguishable", () => {
    const empty = detectCodeMechanismAssertion("nothing to see here", "");
    expect(collectSymbolFreeClaims(empty, empty, empty)).toBeUndefined();
    expect(
      collectSymbolFreeClaims({
        ...empty,
        symbolFreeClaims: [{ family: EXTERNAL_SYSTEM_FAMILY, excerpt: "e" }],
      })
    ).toEqual([{ family: EXTERNAL_SYSTEM_FAMILY, excerpt: "e" }]);
  });

  test("the cohort is on by default once Rung 2 is, and the per-class override turns it off", () => {
    withEnv(SYMBOL_FREE_SKIP_ENV_VAR, undefined, () => {
      expect(isSymbolFreeCohortDisabled()).toBe(false);
      expect(activeExemplarSets()).toHaveLength(6); // identity + five
    });
    withEnv(SYMBOL_FREE_SKIP_ENV_VAR, "1", () => {
      expect(isSymbolFreeCohortDisabled()).toBe(true);
      // The override quiets THIS cohort without reverting mt#4155's family.
      expect(activeExemplarSets()).toEqual([
        expect.objectContaining({ family: IDENTITY_CLAIM_FAMILY }),
      ]);
    });
  });

  // AT4's WARN half (PR #3178 R1). The first draft shipped the calibration
  // record and the blocks-nothing invariant and no WARN, so the cohort fired
  // into a file nobody watches — caught as BLOCKING.
  test("a symbol-free nomination surfaces a WARN naming the families that fired", () => {
    const line = buildSymbolFreeWarning([
      { family: INVOCATION_PATH_POSITIVE_FAMILY, excerpt: "self-heals on the next scheduled run" },
      { family: LOG_ATTRIBUTION_FAMILY, excerpt: "the log shows an unhandled rejection" },
    ]);
    expect(line).toContain("WARN");
    expect(line).toContain(INVOCATION_PATH_POSITIVE_FAMILY);
    expect(line).toContain(LOG_ATTRIBUTION_FAMILY);
    expect(line).toContain("recorded only, not injected");
    expect(line.endsWith("\n")).toBe(true);
  });

  test("the WARN names families, not the agent's own prose", () => {
    // The excerpt is already in the calibration record; repeating it on STDERR
    // widens where the operator's own sentences get written for no added signal.
    const line = buildSymbolFreeWarning([
      { family: SUBSYSTEM_PROPERTY_FAMILY, excerpt: "two of the three daemons are stale" },
    ]);
    expect(line).not.toContain("two of the three daemons are stale");
  });
});
