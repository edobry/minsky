/**
 * Tests for the Ask form-lint checks (mt#2798).
 *
 * Covers each of the three v1 mechanical checks in isolation, a well-formed
 * ask producing zero warnings, and the paired zero-warnings/all-three-warnings
 * regression fixtures derived from ask 6807fb14 (R5 of the
 * escalation-packaging family — see the task spec's Context section).
 *
 * The REWRITTEN fixture below is the verbatim current content of ask
 * 6807fb14 (fetched via `asks_list` at implementation time — the rewrite
 * landed via `asks.edit` on 2026-07-15T16:53:17.141Z per its
 * `metadata.editHistory`).
 *
 * The ORIGINAL fixture is a reconstruction from the task spec's Context
 * section description (title, opening justification shape, the `mcp__`
 * tool-call quote, "the implementer App" click-path with no URL, ~200
 * words) — at the time this ask was edited, `asks.edit`'s editHistory recorded
 * only the touched field names, so the literal pre-edit text was not retrievable
 * from the Ask record itself. (mt#4329 now preserves it in
 * `metadata.originalContent`, but only for asks edited AFTER it shipped;
 * this fixture predates it and stays a reconstruction.)
 * The reconstruction satisfies every property named in the
 * spec's Context section and the Acceptance Tests' synthetic-bad-ask
 * description (contains `mcp__`, > 150 words, authorization.approve with a
 * portal keyword, no URL).
 */

import { describe, expect, test } from "bun:test";
import {
  computeFormLintMatches,
  computeFormWarnings,
  countWords,
  FORM_LINT_WORD_BUDGET,
  type FormLintInput,
  OPTIONS_REQUIRED_CHECK_KINDS,
} from "./form-lint";
import type { AskKind } from "./types";

const AUTHORIZATION_APPROVE: AskKind = "authorization.approve";
const DIRECTION_DECIDE: AskKind = "direction.decide";

// Centralized FormLintCheck literal references (defangs
// custom/no-magic-string-duplication across the assertions below).
const CHECK_INTERNAL_TOOL_ID = "internal-tool-id" as const;
const CHECK_OVER_WORD_BUDGET = "over-word-budget" as const;
const CHECK_PORTAL_NO_LINK = "portal-no-link" as const;

// ---------------------------------------------------------------------------
// countWords
// ---------------------------------------------------------------------------

describe("countWords", () => {
  test("counts whitespace-delimited words", () => {
    expect(countWords("one two three")).toBe(3);
  });

  test("collapses multiple whitespace runs", () => {
    expect(countWords("one   two\nthree")).toBe(3);
  });

  test("returns 0 for empty string", () => {
    expect(countWords("")).toBe(0);
  });

  test("returns 0 for whitespace-only string", () => {
    expect(countWords("   \n\t  ")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

describe("computeFormLintMatches — internal-tool-id check", () => {
  test("fires when question contains an mcp__ tool id", () => {
    const input: FormLintInput = {
      kind: DIRECTION_DECIDE,
      question: "I'll run mcp__minsky__setup_github-app to fix this.",
    };
    const matches = computeFormLintMatches(input);
    expect(matches.some((m) => m.check === CHECK_INTERNAL_TOOL_ID)).toBe(true);
    expect(matches.find((m) => m.check === CHECK_INTERNAL_TOOL_ID)?.message).toBe(
      "internal tool id in principal-facing text"
    );
  });

  test("does not fire when question has no mcp__ reference", () => {
    const input: FormLintInput = {
      kind: DIRECTION_DECIDE,
      question: "Please pick option A or B.",
    };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_INTERNAL_TOOL_ID)).toBe(
      false
    );
  });
});

describe("computeFormLintMatches — over-word-budget check", () => {
  test(`fires when question exceeds ${FORM_LINT_WORD_BUDGET} words`, () => {
    const longQuestion = Array.from({ length: FORM_LINT_WORD_BUDGET + 1 }, () => "word").join(" ");
    const input: FormLintInput = { kind: DIRECTION_DECIDE, question: longQuestion };
    const matches = computeFormLintMatches(input);
    expect(matches.some((m) => m.check === CHECK_OVER_WORD_BUDGET)).toBe(true);
    expect(matches.find((m) => m.check === CHECK_OVER_WORD_BUDGET)?.message).toBe(
      "over form budget; move justification to contextRefs"
    );
  });

  test("does not fire at exactly the budget boundary (strictly greater-than)", () => {
    const boundaryQuestion = Array.from({ length: FORM_LINT_WORD_BUDGET }, () => "word").join(" ");
    const input: FormLintInput = { kind: DIRECTION_DECIDE, question: boundaryQuestion };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_OVER_WORD_BUDGET)).toBe(
      false
    );
  });

  test("does not fire for a short question", () => {
    const input: FormLintInput = { kind: DIRECTION_DECIDE, question: "Short question." };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_OVER_WORD_BUDGET)).toBe(
      false
    );
  });
});

describe("computeFormLintMatches — portal-no-link check", () => {
  test("fires for authorization.approve with a portal keyword and no URL", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question: "Please update the settings to grant this permission.",
    };
    const matches = computeFormLintMatches(input);
    expect(matches.some((m) => m.check === CHECK_PORTAL_NO_LINK)).toBe(true);
    expect(matches.find((m) => m.check === CHECK_PORTAL_NO_LINK)?.message).toBe(
      "portal action with no direct link"
    );
  });

  test("does not fire when a URL is present", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question: "Open https://github.com/settings/apps/foo/permissions and grant this.",
    };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_PORTAL_NO_LINK)).toBe(false);
  });

  test("does not fire for a non-authorization.approve kind, even with portal keywords and no URL", () => {
    const input: FormLintInput = {
      kind: DIRECTION_DECIDE,
      question: "Please update the settings to grant this permission.",
    };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_PORTAL_NO_LINK)).toBe(false);
  });

  test("does not fire when no portal keyword is present", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question: "Please confirm you want to proceed with the deploy.",
    };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_PORTAL_NO_LINK)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// missing-force-immediate check (mt#3436)
// ---------------------------------------------------------------------------

const CHECK_MISSING_FORCE_IMMEDIATE = "missing-force-immediate" as const;
const STUCK_UNBLOCK: AskKind = "stuck.unblock";

/** Shared incident-shaped question fixture, reused across the checks below. */
const INCIDENT_SHAPED_QUESTION = "The service is down and returning 429 errors in production.";

describe("computeFormLintMatches — missing-force-immediate check", () => {
  test("fires for authorization.approve with incident vocabulary and no forceImmediate", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question: INCIDENT_SHAPED_QUESTION,
    };
    const matches = computeFormLintMatches(input);
    expect(matches.some((m) => m.check === CHECK_MISSING_FORCE_IMMEDIATE)).toBe(true);
  });

  test("fires for stuck.unblock with incident vocabulary and no forceImmediate", () => {
    const input: FormLintInput = {
      kind: STUCK_UNBLOCK,
      question: "Multiple attempts failed; the outage is still ongoing.",
    };
    expect(
      computeFormLintMatches(input).some((m) => m.check === CHECK_MISSING_FORCE_IMMEDIATE)
    ).toBe(true);
  });

  test("does not fire when forceImmediate is true", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question: INCIDENT_SHAPED_QUESTION,
      forceImmediate: true,
    };
    expect(
      computeFormLintMatches(input).some((m) => m.check === CHECK_MISSING_FORCE_IMMEDIATE)
    ).toBe(false);
  });

  test("does not fire for a non-severity-transport kind, even with incident vocabulary", () => {
    const input: FormLintInput = {
      kind: DIRECTION_DECIDE,
      question: INCIDENT_SHAPED_QUESTION,
    };
    expect(
      computeFormLintMatches(input).some((m) => m.check === CHECK_MISSING_FORCE_IMMEDIATE)
    ).toBe(false);
  });

  test("does not fire when no incident vocabulary is present", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question: "Please confirm you want to proceed with the deploy.",
    };
    expect(
      computeFormLintMatches(input).some((m) => m.check === CHECK_MISSING_FORCE_IMMEDIATE)
    ).toBe(false);
  });

  test("omitting forceImmediate entirely behaves the same as explicit false", () => {
    const withoutField = computeFormLintMatches({
      kind: AUTHORIZATION_APPROVE,
      question: "The reviewer is down; investigate the incident.",
    });
    const withFalse = computeFormLintMatches({
      kind: AUTHORIZATION_APPROVE,
      question: "The reviewer is down; investigate the incident.",
      forceImmediate: false,
    });
    expect(withoutField.map((m) => m.check)).toEqual(withFalse.map((m) => m.check));
  });

  test("this check composes with the v1 question checks rather than replacing them", () => {
    const checks = computeFormLintMatches({
      kind: AUTHORIZATION_APPROVE,
      question: "Run mcp__minsky__setup_github-app — production is down.",
    })
      .map((m) => m.check)
      .sort();
    expect(checks).toEqual([CHECK_INTERNAL_TOOL_ID, CHECK_MISSING_FORCE_IMMEDIATE].sort());
  });
});

// ---------------------------------------------------------------------------
// Well-formed ask -> zero warnings
// ---------------------------------------------------------------------------

describe("computeFormWarnings — well-formed ask", () => {
  test("produces zero warnings", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question:
        "Open https://github.com/settings/apps/minsky-ai/permissions and set Actions to Read and write, then save.",
    };
    expect(computeFormWarnings(input)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression fixtures: ask 6807fb14 (escalation-packaging family R5)
// ---------------------------------------------------------------------------

describe("ask 6807fb14 regression fixtures", () => {
  // Verbatim current content of ask 6807fb14, fetched via asks_list at
  // implementation time (the rewrite that resolved the R5 incident).
  const REWRITTEN_QUESTION = [
    "**What you're being asked:** approve one permission on the **minsky-ai** GitHub App so the new CI-rerun tool can work.",
    "",
    "**Fastest path (~30 seconds):**",
    "1. Open https://github.com/settings/apps/minsky-ai/permissions",
    "2. Under **Repository permissions**, set **Actions** to **Read and write**, then **Save changes**",
    "3. GitHub will show an approval prompt for the installation — accept it",
    "",
    "**Or** pick \"File the request for me\" below and I'll submit the permission change on the app for you — GitHub will still send you a one-click approval (owner approval is required either way; that part can't be automated).",
    "",
    '**Why (one line):** the new flaky-CI-retry tool shipped yesterday ([PR #1920](https://github.com/edobry/minsky/pull/1920)) needs it; until then it returns a clear "missing permission" error and nothing else is blocked.',
  ].join("\n");

  // Reconstruction of the ORIGINAL failing ask 6807fb14 text per the task
  // spec's Context section: title/body opens with task/PR justification,
  // offers "[a] I run mcp__minsky__setup_github-app with update + the
  // widened permission set..." and a click-path naming only "the
  // implementer App", no URL, > 150 words.
  const ORIGINAL_QUESTION = [
    'This request is unblocking mt#2775 and the forge_ci_run_rerun tool that shipped in PR #1920. The tool needs the "Actions: read & write" permission on the implementer GitHub App to rerun failed CI checks on demand instead of requiring a fresh commit to retrigger the workflow. Right now the tool returns a clear "missing permission" error when it\'s called, and nothing else in the task graph is blocked by this — but until the permission is granted, the CI-rerun capability stays inert for every task that hits a flaky check, which has been happening several times a week across active sessions.',
    "",
    "There are two ways to get this done, and either one ends at the same GitHub-side owner-approval prompt:",
    "",
    "[a] I run mcp__minsky__setup_github-app with update mode and the widened permission set (Actions: read & write added on top of the app's current scope list). This calls the GitHub Apps manifest API to request the permission change, which still requires the app owner to approve the resulting installation-permission-update prompt before it actually takes effect for any installation — that final approval step cannot be automated away no matter which path we take here.",
    "",
    "[b] You update the implementer App's permissions yourself: open GitHub's Settings, find the implementer App under your installed/owned GitHub Apps, open its permissions page, locate the Actions permission under Repository permissions, change it from read-only to \"Read and write\", and save.",
    "",
    "Let me know which you'd prefer, or whether you'd rather leave it for now.",
  ].join("\n");

  test("REWRITTEN (current) content produces zero warnings", () => {
    expect(
      computeFormWarnings({ kind: AUTHORIZATION_APPROVE, question: REWRITTEN_QUESTION })
    ).toEqual([]);
  });

  test("ORIGINAL text produces all three warnings", () => {
    const matches = computeFormLintMatches({
      kind: AUTHORIZATION_APPROVE,
      question: ORIGINAL_QUESTION,
    });
    const checks = matches.map((m) => m.check).sort();
    expect(checks).toEqual(
      [CHECK_INTERNAL_TOOL_ID, CHECK_OVER_WORD_BUDGET, CHECK_PORTAL_NO_LINK].sort()
    );
  });

  test("ORIGINAL text is indeed over the word budget (sanity check on the fixture)", () => {
    expect(countWords(ORIGINAL_QUESTION)).toBeGreaterThan(FORM_LINT_WORD_BUDGET);
  });
});

// ---------------------------------------------------------------------------
// Replay: ask cb89ecf1 / ask#6575 (mt#3433 originating incident — mt#3436
// spec Acceptance Tests AT1 and AT3)
// ---------------------------------------------------------------------------

describe("ask cb89ecf1 / ask#6575 replay (mt#3436 AT1, AT3)", () => {
  // Verbatim question text from the originating ask, fetched via asks_get at
  // implementation time. The ask's actual kind was authorization.approve and
  // it was actually created with forceImmediate: false — the exact shape
  // the 2026-07-31 incident (mt#3433 / mem#779) describes.
  const INCIDENT_QUESTION =
    'The reviewer bot has been failing every review since ~02:30Z tonight with "429 You have no ' +
    "credits remaining\" from OpenAI — the account balance is empty (likely drained by today's " +
    "7-PR day: multi-round GPT-5 reviews plus three toil-miner LLM runs). Add credits here: " +
    "https://platform.openai.com/settings/organization/billing (Billing → Add to credit " +
    "balance). Until then, no PR can get a bot review; PR #2456 (the miner perf fix, all 15 " +
    "checks green) is waiting, and I can't bypass-merge from my side. Alternatives if you'd " +
    "rather not top up now: I can switch the reviewer service to the Anthropic or Gemini " +
    "provider (config change; review quality/format differs), or everything simply waits. " +
    "Investigation record: mt#3433.";

  test("AT1: replaying the ORIGINAL (forceImmediate: false) ask warns on missing-force-immediate", () => {
    const matches = computeFormLintMatches({
      kind: AUTHORIZATION_APPROVE,
      question: INCIDENT_QUESTION,
      forceImmediate: false,
    });
    expect(matches.some((m) => m.check === CHECK_MISSING_FORCE_IMMEDIATE)).toBe(true);
  });

  test("AT3: the same ask with forceImmediate: true passes lint clean on this check", () => {
    const matches = computeFormLintMatches({
      kind: AUTHORIZATION_APPROVE,
      question: INCIDENT_QUESTION,
      forceImmediate: true,
    });
    expect(matches.some((m) => m.check === CHECK_MISSING_FORCE_IMMEDIATE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Option-label checks (mt#3253)
//
// Fixtures are verbatim labels from the live ask corpus (measured 2026-07-26):
// 200 options across 67 asks, label length p50 36 / p90 62 / max 167, with 23
// labels over 60 chars (14 of them leaving `description` empty) and 35 carrying
// a redundant letter marker. The label-shape rules themselves are unit-tested in
// `packages/shared/src/ask-option-label.test.ts`; these tests cover the LINT
// wiring — that the right check fires, once, with a message naming the fix.
// ---------------------------------------------------------------------------

const CHECK_LONG_OPTION_LABEL = "long-option-label" as const;
const CHECK_LETTER_PREFIXED = "letter-prefixed-option-label" as const;

/** The corpus worst case: 167 chars, and letter-prefixed as well. */
const CORPUS_WORST_LABEL =
  "B — boundary fix + Stop-event ADVISORY guard (recommended): agent self-addresses admissions at turn end; dedup vs prompt-time scanner; first Stop dispatcher entrypoint";

const DECIDE: AskKind = "direction.decide";
const CLEAN_QUESTION = "Pick the replacement mechanism for boot-time auto-migrate.";

describe("form-lint option-label checks (mt#3253)", () => {
  test("a long label fires long-option-label with a message naming description", () => {
    const matches = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: [{ label: "x".repeat(61) }],
    });
    const match = matches.find((m) => m.check === CHECK_LONG_OPTION_LABEL);
    expect(match).toBeDefined();
    expect(match?.message).toContain("description");
  });

  test("a label at the corpus p50 length fires nothing", () => {
    expect(
      computeFormWarnings({
        kind: DECIDE,
        question: CLEAN_QUESTION,
        options: [{ label: "x".repeat(36) }],
      })
    ).toEqual([]);
  });

  test("the boundary is exclusive: 60 chars passes, 61 fires", () => {
    const at = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: [{ label: "x".repeat(60) }],
    });
    const over = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: [{ label: "x".repeat(61) }],
    });
    expect(at.map((m) => m.check)).not.toContain(CHECK_LONG_OPTION_LABEL);
    expect(over.map((m) => m.check)).toContain(CHECK_LONG_OPTION_LABEL);
  });

  test("a letter-prefixed label fires letter-prefixed-option-label", () => {
    const matches = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: [{ label: "[b] Railway pre-deploy" }],
    });
    expect(matches.map((m) => m.check)).toContain(CHECK_LETTER_PREFIXED);
  });

  test("an em-dash label with no letter marker fires NEITHER option check", () => {
    // The negative control that matters: this is a real corpus label, and a
    // naive prefix pattern would eat its leading word.
    expect(
      computeFormWarnings({
        kind: DECIDE,
        question: CLEAN_QUESTION,
        options: [{ label: "Adopt fully — vocabulary + one-pager" }],
      })
    ).toEqual([]);
  });

  test("the corpus worst label fires BOTH option checks and nothing else", () => {
    const checks = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: [{ label: CORPUS_WORST_LABEL }],
    })
      .map((m) => m.check)
      .sort();
    expect(checks).toEqual([CHECK_LETTER_PREFIXED, CHECK_LONG_OPTION_LABEL].sort());
  });

  test("each check fires ONCE for the ask, not once per offending option", () => {
    const matches = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: [
        { label: `[a] ${"x".repeat(70)}` },
        { label: `[b] ${"y".repeat(70)}` },
        { label: `[c] ${"z".repeat(70)}` },
      ],
    });
    expect(matches.filter((m) => m.check === CHECK_LONG_OPTION_LABEL)).toHaveLength(1);
    expect(matches.filter((m) => m.check === CHECK_LETTER_PREFIXED)).toHaveLength(1);
  });

  test("the message carries the offending count so the producer knows the scope", () => {
    const matches = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: [{ label: "x".repeat(70) }, { label: "y".repeat(70) }, { label: "fine" }],
    });
    expect(matches.find((m) => m.check === CHECK_LONG_OPTION_LABEL)?.message).toContain("2 option");
  });

  test("only the offending option in a mixed set drives the warning", () => {
    const checks = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: [{ label: "Approve" }, { label: "[b] Deny" }],
    }).map((m) => m.check);
    expect(checks).toContain(CHECK_LETTER_PREFIXED);
    expect(checks).not.toContain(CHECK_LONG_OPTION_LABEL);
  });

  // These two tests assert the LABEL checks' omission convention, which
  // mt#3477 explicitly preserves. They assert the absence of the two label
  // checks rather than an empty warning set, because mt#3477's
  // missing-decision-options DOES fire on this input — a different check
  // asking a different question (see FormLintInput.options' doc comment).
  test("an empty options array fires neither LABEL check", () => {
    const checks = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: [],
    }).map((m) => m.check);
    expect(checks).not.toContain(CHECK_LONG_OPTION_LABEL);
    expect(checks).not.toContain(CHECK_LETTER_PREFIXED);
  });

  test("omitting options entirely leaves the LABEL checks silent, as in v1", () => {
    const withoutField = computeFormLintMatches({ kind: DECIDE, question: CLEAN_QUESTION });
    const withUndefined = computeFormLintMatches({
      kind: DECIDE,
      question: CLEAN_QUESTION,
      options: undefined,
    });
    // Omission and an explicit undefined stay indistinguishable.
    expect(withoutField.map((m) => m.check)).toEqual(withUndefined.map((m) => m.check));
    for (const check of withoutField.map((m) => m.check)) {
      expect([CHECK_LONG_OPTION_LABEL, CHECK_LETTER_PREFIXED]).not.toContain(check);
    }
  });

  test("option checks compose with the v1 question checks rather than replacing them", () => {
    const checks = computeFormLintMatches({
      kind: DECIDE,
      question: "Run mcp__minsky__setup_github-app to proceed.",
      options: [{ label: CORPUS_WORST_LABEL }],
    })
      .map((m) => m.check)
      .sort();
    expect(checks).toEqual(
      [CHECK_INTERNAL_TOOL_ID, CHECK_LETTER_PREFIXED, CHECK_LONG_OPTION_LABEL].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// missing-decision-options check (mt#3477)
//
// The gap this closes: the two checks above read option LABELS and are
// deliberately silent when `options` is absent, so nothing asserted option
// PRESENCE. A `direction.decide` with its choices written as prose and no
// options array passed all six prior checks and rendered in the cockpit with
// no response buttons at all.
// ---------------------------------------------------------------------------

const CHECK_MISSING_DECISION_OPTIONS = "missing-decision-options" as const;

/**
 * Every AskKind that must NOT fire this check — i.e. the full seven minus the
 * contents of `OPTIONS_REQUIRED_CHECK_KINDS`.
 *
 * Deliberately carries no per-kind rationale. WHY each kind is excluded is
 * recorded once, on `OPTIONS_REQUIRED_CHECK_KINDS` in `./form-lint`; copying
 * it here would give that reasoning a second home that can silently drift
 * from the first (PR #2491 R1). These tests assert behavior only.
 */
const NON_FIRING_KINDS: readonly AskKind[] = [
  AUTHORIZATION_APPROVE,
  "quality.review",
  "capability.escalate",
  "information.retrieve",
  STUCK_UNBLOCK,
  "coordination.notify",
];

describe("computeFormLintMatches — missing-decision-options check (mt#3477)", () => {
  test("fires for direction.decide when options is absent", () => {
    const matches = computeFormLintMatches({ kind: DIRECTION_DECIDE, question: CLEAN_QUESTION });
    expect(matches.some((m) => m.check === CHECK_MISSING_DECISION_OPTIONS)).toBe(true);
  });

  test("fires for direction.decide when options is an empty array", () => {
    const matches = computeFormLintMatches({
      kind: DIRECTION_DECIDE,
      question: CLEAN_QUESTION,
      options: [],
    });
    expect(matches.some((m) => m.check === CHECK_MISSING_DECISION_OPTIONS)).toBe(true);
  });

  test("absent and empty produce the identical match set — neither renders a button", () => {
    const absent = computeFormLintMatches({ kind: DIRECTION_DECIDE, question: CLEAN_QUESTION });
    const empty = computeFormLintMatches({
      kind: DIRECTION_DECIDE,
      question: CLEAN_QUESTION,
      options: [],
    });
    expect(absent.map((m) => m.check)).toEqual(empty.map((m) => m.check));
  });

  test("does not fire for direction.decide with one option", () => {
    const matches = computeFormLintMatches({
      kind: DIRECTION_DECIDE,
      question: CLEAN_QUESTION,
      options: [{ label: "Keep the current mechanism" }],
    });
    expect(matches.some((m) => m.check === CHECK_MISSING_DECISION_OPTIONS)).toBe(false);
  });

  test("a well-formed direction.decide with options produces zero warnings", () => {
    expect(
      computeFormWarnings({
        kind: DIRECTION_DECIDE,
        question: CLEAN_QUESTION,
        options: [
          { label: "GitHub Actions migrate-on-merge" },
          { label: "Railway pre-deploy command" },
        ],
      })
    ).toEqual([]);
  });

  for (const kind of NON_FIRING_KINDS) {
    test(`does not fire for ${kind} with no options`, () => {
      const matches = computeFormLintMatches({ kind, question: CLEAN_QUESTION });
      expect(matches.some((m) => m.check === CHECK_MISSING_DECISION_OPTIONS)).toBe(false);
    });
  }

  test("the non-firing set covers every kind this check does not list", () => {
    // Behavioral completeness: the six kinds above plus whatever
    // OPTIONS_REQUIRED_CHECK_KINDS contains must be the whole taxonomy, so a
    // kind can never be silently unclassified by this suite.
    expect(NON_FIRING_KINDS.length + OPTIONS_REQUIRED_CHECK_KINDS.length).toBe(7);
    for (const kind of NON_FIRING_KINDS) {
      expect(OPTIONS_REQUIRED_CHECK_KINDS).not.toContain(kind);
    }
  });

  test("the two LABEL checks stay silent on an options-absent input (unchanged by mt#3477)", () => {
    const checks = computeFormLintMatches({
      kind: DIRECTION_DECIDE,
      question: CLEAN_QUESTION,
    }).map((m) => m.check);
    expect(checks).not.toContain(CHECK_LONG_OPTION_LABEL);
    expect(checks).not.toContain(CHECK_LETTER_PREFIXED);
    expect(checks).toEqual([CHECK_MISSING_DECISION_OPTIONS]);
  });

  test("the message names the fix (an options array), not just the defect", () => {
    const match = computeFormLintMatches({
      kind: DIRECTION_DECIDE,
      question: CLEAN_QUESTION,
    }).find((m) => m.check === CHECK_MISSING_DECISION_OPTIONS);
    expect(match?.message).toContain("options array");
  });

  test("composes with the v1 question checks rather than replacing them", () => {
    const checks = computeFormLintMatches({
      kind: DIRECTION_DECIDE,
      question: "Run mcp__minsky__setup_github-app to proceed.",
    })
      .map((m) => m.check)
      .sort();
    expect(checks).toEqual([CHECK_INTERNAL_TOOL_ID, CHECK_MISSING_DECISION_OPTIONS].sort());
  });
});

// ---------------------------------------------------------------------------
// Replay: ask#6589 (mt#3477 originating incident)
//
// The REPAIRED question is verbatim from `asks_get ask#6589` at
// implementation time (the in-place `asks_edit` on 2026-07-31T19:23:38Z per
// its metadata.editHistory). The PRE-REPAIR body is a reconstruction — as
// with the 6807fb14 fixtures above, editHistory recorded only touched field
// names when this ask was edited, so the literal prior text is not retrievable
// from the Ask record. (mt#4329 fixes that going forward via
// `metadata.originalContent`; it cannot recover an edit that already happened.)
// The reconstruction satisfies the property the incident turns on: the three
// choices written as [a]/[b]/[c] prose inside the question, with no options
// array.
// ---------------------------------------------------------------------------

describe("ask#6589 replay (mt#3477 originating incident)", () => {
  const PRE_REPAIR_QUESTION = [
    "Pick how mt#3132 sequences against driven sessions.",
    "",
    "[a] Alias now, read-only until mt#3325.",
    "[b] Unify the read side, keep /driven live (recommended).",
    "[c] Do mt#3095 + mt#3325 first, then unify once.",
  ].join("\n");

  const REPAIRED_OPTIONS = [
    { label: "Alias now, read-only until mt#3325" },
    { label: "Unify the read side, keep /driven live" },
    { label: "Do mt#3095 + mt#3325 first, then unify once" },
  ];

  test("the PRE-REPAIR shape fires missing-decision-options", () => {
    const matches = computeFormLintMatches({
      kind: DIRECTION_DECIDE,
      question: PRE_REPAIR_QUESTION,
    });
    expect(matches.map((m) => m.check)).toEqual([CHECK_MISSING_DECISION_OPTIONS]);
  });

  test("the REPAIRED shape — same choices, moved into options — passes clean", () => {
    expect(
      computeFormWarnings({
        kind: DIRECTION_DECIDE,
        question: "Pick how mt#3132 sequences against driven sessions.",
        options: REPAIRED_OPTIONS,
      })
    ).toEqual([]);
  });
});

/**
 * mt#4901 — `domain-jargon` must not fire on a term the author GLOSSED inline
 * at its first use.
 *
 * Fixtures are verbatim clauses from the asks that produced the false positive
 * and the true positives it must not disturb, read from the ask store during
 * the 2026-09-02 calibration pass over `ask-form-lint-calibration.jsonl`.
 */
describe("domain-jargon — inline gloss at first use (mt#4901)", () => {
  const CHECK_DOMAIN_JARGON = "domain-jargon" as const;

  const jargonMatches = (question: string) =>
    computeFormLintMatches({
      kind: DIRECTION_DECIDE,
      question,
      options: [{ label: "Yes" }],
    }).filter((m) => m.check === CHECK_DOMAIN_JARGON);

  // AT1 — ask#10650's opening sentence. Its author's rebuttal is recorded in
  // the ask's own metadata.formWarningDisposition.
  test("AT1: a dash-pair gloss at first use suppresses the ADR/RFC class", () => {
    expect(
      jargonMatches(
        "Decide whether ADR-042 — the record of which planning gates get a mechanical " +
          "backstop — should be marked Accepted, or stay Proposed."
      )
    ).toEqual([]);
  });

  test("a parenthetical gloss suppresses it the same way", () => {
    expect(
      jargonMatches("Decide whether ADR-042 (the gate-battery enforcement record) should ship.")
    ).toEqual([]);
  });

  // AT3 — recall floor, ask#10662.
  test("AT3: a bare ADR reference with no gloss still fires", () => {
    expect(
      jargonMatches(
        "**mt#4172 should not be built as specced.** ADR-042 required measuring its " +
          "trigger first; I did."
      )
    ).toHaveLength(1);
  });

  // AT3 — recall floor, ask#11095.
  test("AT3: a bare ADR reference mid-body still fires", () => {
    expect(
      jargonMatches(
        "Yours: a scope change to filed work and to a row an accepted ADR assigns. " +
          "Third ADR-042 row whose assigned mechanism did not survive measurement."
      )
    ).toHaveLength(1);
  });

  // AT4 — the load-bearing negative control: ask#10657's ORIGINAL body, whose
  // author responded to this warning by removing the ADR number entirely. A
  // gloss rule loose enough to suppress this would retire a real catch.
  test("AT4: a possessive use is not a gloss", () => {
    expect(
      jargonMatches(
        "Two review windows measured it at 73% and 77% false positives against a " +
          "written 10% bar, which fired ADR-034's reopen condition. That record assumed " +
          "the culprit was the word-admission step."
      )
    ).toHaveLength(1);
  });

  test("an UNCLOSED dash opener is not a gloss — closure is what bounds the rule", () => {
    expect(
      jargonMatches("ADR-042 — required measuring the trigger before building it.")
    ).toHaveLength(1);
  });

  test("the gloss must sit at the FIRST use, not a later one", () => {
    expect(
      jargonMatches(
        "ADR-042 assigns the row. ADR-042 — the gate-battery record — is where it lives."
      )
    ).toHaveLength(1);
  });

  test("a later bare use is ordinary prose once the term is glossed on introduction", () => {
    expect(
      jargonMatches(
        "ADR-042 — the gate-battery enforcement record — assigns the row. ADR-042 also " +
          "required the measurement."
      )
    ).toEqual([]);
  });
});
