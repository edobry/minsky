/**
 * Unit tests for the capability-absence matcher (mt#3999).
 *
 * The hook's own test file exercises the SURFACE — transcript joins, the routed
 * outcome, the advisory. These cover the pure pieces the hook composes, which is
 * why the module lives in the domain package at all: no transcript, no database,
 * no hook imports (`testing-standards.mdc §Testable Design`).
 */

import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_ABSENCE_PATTERNS,
  MAX_SUBJECT_CHARS,
  MIN_INDEPENDENT_CHANNELS,
  classifyProbeChannel,
  detectCapabilityAbsenceEscalation,
  distinctProbeChannels,
  extractCapabilityAbsenceClaims,
  isOperatorRoutedAskResult,
  secondChannelFor,
} from "./capability-absence-escalation";
import { NEGATIVE_EXISTENCE_PATTERNS } from "./negative-existence-claim";

/** The channel that lied in the anchor instance. */
const CREDENTIALS_LIST = "mcp__minsky__config_credentials_list";

/** The independent channel that would have falsified it. */
const AI_VALIDATE = "mcp__minsky__ai_validate";

/** ask#6754's claim (mt#3547) — the anchor instance. */
const ANCHOR = "I have no OpenAI key — the store has Anthropic and Google, not OpenAI.";

/** The 90-minutes-later instance, which occurred in chat rather than at an ask. */
const BUN_CLAIM = "Bun doesn't give us this. I checked rather than assumed.";

describe("extractCapabilityAbsenceClaims", () => {
  test("matches the anchor instance and names its subject", () => {
    const claims = extractCapabilityAbsenceClaims(ANCHOR);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.subject).toBe("OpenAI");
    expect(claims[0]?.phrase).toContain("no OpenAI key");
  });

  test("matches the third-person-about-a-tool shape too", () => {
    const claims = extractCapabilityAbsenceClaims(BUN_CLAIM);
    expect(claims[0]?.subject).toBe("Bun");
  });

  test("does not match prose that asserts no absence", () => {
    expect(
      extractCapabilityAbsenceClaims("Which ordering do you want for the two migrations?")
    ).toEqual([]);
  });

  test("returns at most one match per pattern", () => {
    const repeated = `${ANCHOR} ${ANCHOR} ${ANCHOR}`;
    expect(extractCapabilityAbsenceClaims(repeated)).toHaveLength(1);
  });

  test("empty prose is not a claim", () => {
    expect(extractCapabilityAbsenceClaims("")).toEqual([]);
  });
});

describe("the corpus is genuinely distinct from its two neighbours", () => {
  // The measurement mt#3999's planning pass ran, pinned so a future widening of
  // any of the three families cannot silently start double-covering. If this
  // fails, two detectors are about to fire on one sentence.
  test("mt#3918's absence-of-CALLERS family does not reach these claims", () => {
    for (const claim of [ANCHOR, BUN_CLAIM]) {
      expect(NEGATIVE_EXISTENCE_PATTERNS.some((p) => p.test(claim))).toBe(false);
    }
  });

  test("this family does not reach mt#3918's claims", () => {
    const callerAbsence = "Zero production call sites; nothing calls onProgress anywhere.";
    expect(CAPABILITY_ABSENCE_PATTERNS.some((p) => p.test(callerAbsence))).toBe(false);
  });
});

describe("classifyProbeChannel", () => {
  test("the credential store and the provider surface are DIFFERENT channels", () => {
    // The distinction the detector rests on: in the anchor instance the store
    // was consulted and lied, and the provider surface would have falsified it.
    expect(classifyProbeChannel({ toolName: CREDENTIALS_LIST })).toBe("config-store");
    expect(classifyProbeChannel({ toolName: AI_VALIDATE })).toBe("provider-validate");
  });

  test("a hosted-infra skill load is a channel; an unrelated skill is not", () => {
    expect(classifyProbeChannel({ toolName: "Skill", skill: "railway:use-railway" })).toBe(
      "service-skill"
    );
    expect(classifyProbeChannel({ toolName: "Skill", skill: "Notion:search" })).toBeNull();
  });

  test("a shell capability check counts, an ordinary command does not", () => {
    expect(
      classifyProbeChannel({ toolName: "Bash", command: "which railway && railway whoami" })
    ).toBe("shell-capability");
    expect(classifyProbeChannel({ toolName: "Bash", command: "git log --oneline" })).toBeNull();
  });

  test("docs and search are the second channel for a third-party claim", () => {
    expect(classifyProbeChannel({ toolName: "WebSearch" })).toBe("docs-knowledge");
  });

  test("a non-probe tool is not a channel", () => {
    expect(classifyProbeChannel({ toolName: "mcp__minsky__session_pr_create" })).toBeNull();
  });
});

describe("distinctProbeChannels", () => {
  test("two calls on one channel count once", () => {
    expect(
      distinctProbeChannels([
        { toolName: CREDENTIALS_LIST },
        { toolName: "mcp__minsky__config_get" },
      ])
    ).toEqual(["config-store"]);
  });

  test("two channels count twice, in first-seen order", () => {
    expect(
      distinctProbeChannels([{ toolName: AI_VALIDATE }, { toolName: "mcp__minsky__config_get" }])
    ).toEqual(["provider-validate", "config-store"]);
  });
});

describe("isOperatorRoutedAskResult", () => {
  test("an operator-routed result passes", () => {
    expect(isOperatorRoutedAskResult('{"state":"routed","routingTarget": "operator"}')).toBe(true);
  });

  test("a policy-closed result does NOT — it reaches no human", () => {
    expect(isOperatorRoutedAskResult('{"state":"closed","routingTarget":"policy"}')).toBe(false);
  });

  test("the other router targets do not", () => {
    for (const target of ["subagent", "peer", "reviewer", "retriever"]) {
      expect(isOperatorRoutedAskResult(`{"routingTarget":"${target}"}`)).toBe(false);
    }
  });

  test("an empty or absent body is not a routed result", () => {
    expect(isOperatorRoutedAskResult("")).toBe(false);
    expect(isOperatorRoutedAskResult("{}")).toBe(false);
  });
});

describe("detectCapabilityAbsenceEscalation", () => {
  const oneChannel = [{ toolName: CREDENTIALS_LIST }];
  const twoChannels = [...oneChannel, { toolName: AI_VALIDATE }];

  test("fires on a claim backed by a single channel", () => {
    const result = detectCapabilityAbsenceEscalation({
      justification: ANCHOR,
      probes: oneChannel,
    });
    expect(result.matched).toBe(true);
    expect(result.channels).toEqual(["config-store"]);
  });

  test("a second independent channel suppresses it", () => {
    expect(
      detectCapabilityAbsenceEscalation({ justification: ANCHOR, probes: twoChannels }).matched
    ).toBe(false);
  });

  test("no claim means no fire, however few channels were consulted", () => {
    expect(
      detectCapabilityAbsenceEscalation({ justification: "Which name do you prefer?", probes: [] })
        .matched
    ).toBe(false);
  });

  test("the threshold is what the constant says it is", () => {
    expect(MIN_INDEPENDENT_CHANNELS).toBe(2);
  });
});

describe("secondChannelFor", () => {
  test("a credential claim names the two calls that falsify it", () => {
    const channel = secondChannelFor("OpenAI", "I have no OpenAI key");
    expect(channel).toContain("ai_providers_list");
    expect(channel).toContain("ai_validate --provider OpenAI");
  });

  test("a non-credential claim names the docs channel", () => {
    expect(secondChannelFor("Bun", "Bun doesn't give us this")).toContain("released docs");
  });

  test("an empty subject still yields usable guidance", () => {
    expect(secondChannelFor("", "no key")).toContain("the named capability");
  });

  test("the subject is capped, so the advisory has no unbounded axis", () => {
    const long = "s".repeat(500);
    expect(secondChannelFor(long, "no key")).not.toContain("s".repeat(MAX_SUBJECT_CHARS + 1));
  });
});
