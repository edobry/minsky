import { describe, expect, test } from "bun:test";
import {
  detectCapabilityDeferral,
  detectPermissionDeferral,
  detectDenialAnchoredDeferral,
  detectAskDeferral,
  extractAskTexts,
  hasProbeEvidence,
  isProbeSkill,
  stripQuoteChars,
  buildCalibrationRecord,
  buildEvaluationRecord,
  buildReminder,
  run,
  runAskSurface,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
} from "./operator-deferral-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput, ToolHookInput } from "./types";
import type { DispatchContext } from "./registry";
import { extractDistinctPhrases } from "../../src/domain/calibration/calibration-sweep";

// ---------------------------------------------------------------------------
// Shared fixture literals
// ---------------------------------------------------------------------------

const FIXTURE_PATH = "/tmp/fixture.jsonl";
const DEFERRAL_PROSE = "Deferred to operator: requires Railway access.";
const ASK_OPTION_LABEL = "ask-option-label";
const CAPABILITY_PROSE = "capability-deferral-prose";
const R5_LABEL = "You recover the reviewer service";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const userPrompt = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
});

const assistantText = (text: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const assistantToolUse = (name: string, input: Record<string, unknown>): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
});

/** A tool_result line — recorded by Claude Code with role "user" (mem#528). */
const toolResult = (text: string): TranscriptLine => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_x", content: [{ type: "text", text }] }],
  },
});

const ctxWith = (lines: TranscriptLine[]): DispatchContext =>
  ({
    event: "UserPromptSubmit",
    hostCapSec: 60,
    budgets: { overallMs: 60000, fetchMs: 20000, gitMs: 20000 },
    transcriptCandidates: [FIXTURE_PATH],
    transcriptLines: lines,
  }) as unknown as DispatchContext;

// ---------------------------------------------------------------------------
// Surface C — permission-deferral prose (mt#3463)
// ---------------------------------------------------------------------------

const PERMISSION_PROSE = "permission-deferral-prose";

/**
 * Seed corpus (spec criterion 5). Drawn from real turns, not invented shapes:
 * the first is the mt#3621 originating incident verbatim, and the R5 entry is
 * the fabricated-authority-boundary case mt#3463's own `## Recurrence` records.
 *
 * TRUE POSITIVES — an action the agent could simply have taken.
 */
const PERMISSION_TRUE_POSITIVES: ReadonlyArray<readonly [string, string]> = [
  ["mt#3621 origin", "The daemon needs a restart. Say the word and I'll do it."],
  ["want-me-to", "I can restart the daemon. Want me to?"],
  ["shall-I", "The task is planned and READY. Shall I implement it?"],
  ["should-I", "Everything is green. Should I merge it?"],
  ["do-you-want", "The fix is ready. Do you want me to push it?"],
  ["let-me-know", "It's a one-line change. Let me know if you want me to apply it."],
  ["if-you-like", "I can file that follow-up task if you'd like."],
  ["happy-to", "Happy to rerun the suite if you want."],
  ["just-say-so", "The branch is ready to go — just say the word."],
  ["would-you-like", "Would you like me to update the spec too?"],
];

/**
 * WOULD-BE FALSE POSITIVES — the same permission-ask SHAPE wrapped around an
 * action that SHOULD be escalated. These must stay silent; firing on them would
 * train the agent to act unilaterally on exactly the work it must not, which is
 * strictly worse than the round-trip this surface prevents.
 */
const PERMISSION_LEGITIMATE_ESCALATIONS: ReadonlyArray<readonly [string, string]> = [
  ["force-push", "The history diverged. Should I force-push over it?"],
  ["prod-deploy", "Want me to deploy this to production?"],
  ["delete", "Do you want me to delete the stale branch and its data?"],
  ["revert-prod", "Should I revert the production release?"],
  ["naming", "Should I call it Attention or Inbox?"],
  ["vendor", "Do you want me to sign up for the paid plan?"],
  ["scope-change", "Want me to expand the scope decision to cover the tray too?"],
  ["drop-table", "Shall I drop the table and re-migrate?"],
];

describe("Surface C — permission-deferral prose (mt#3463)", () => {
  test.each(PERMISSION_TRUE_POSITIVES)("fires on %s", (_label, prose) => {
    const matches = detectPermissionDeferral([assistantText(prose)]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe(PERMISSION_PROSE);
  });

  test.each(PERMISSION_LEGITIMATE_ESCALATIONS)(
    "stays silent on a legitimate escalation: %s",
    (_label, prose) => {
      expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
    }
  );

  test("the exclusion is SENTENCE-scoped, not turn-scoped", () => {
    // An unrelated mention of a reserved word elsewhere in the turn must not
    // mask a real permission-ask about something else.
    const prose =
      "I checked the production logs earlier and they were clean.\n" +
      "The changelog entry is drafted. Want me to commit it?";
    const matches = detectPermissionDeferral([assistantText(prose)]);
    expect(matches).toHaveLength(1);
  });

  test("probe evidence suppresses it, like Surface A", () => {
    const lines = [
      assistantToolUse("Bash", { command: "which railway" }),
      toolResult("/opt/homebrew/bin/railway"),
      assistantText("Probed: railway CLI present. Want me to redeploy?"),
    ];
    expect(detectPermissionDeferral(lines)).toEqual([]);
  });

  test("a quoted trigger phrase does not fire (mt#3273 elision parity)", () => {
    const prose = 'The detector matches phrases like "want me to" in agent prose.';
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });

  test("capability prose does NOT fire this surface (the two are disjoint)", () => {
    expect(detectPermissionDeferral([assistantText(DEFERRAL_PROSE)])).toEqual([]);
  });

  test("permission prose does NOT fire the capability surface (the gap this closes)", () => {
    const prose = "The daemon needs a restart. Say the word and I'll do it.";
    expect(detectCapabilityDeferral([assistantText(prose)])).toEqual([]);
    expect(detectPermissionDeferral([assistantText(prose)])).toHaveLength(1);
  });
});

describe("evaluation stream records misses, not just fires (mt#3463)", () => {
  test("a no-match turn still produces a record — the half a fire-only log cannot give", () => {
    const record = buildEvaluationRecord("s-1", [], "Nothing deferral-shaped here.");
    expect(record.fired).toBe(false);
    expect(record.surfaces).toEqual([]);
    // The tail is what makes a MISS classifiable later.
    expect(record.text_tail).toContain("Nothing deferral-shaped");
  });

  test("defaults to the prose-turn grain", () => {
    expect(buildEvaluationRecord("s-1", [], "text").evaluated).toBe("prose-turn");
  });

  // PR #2659 R1: the ask surface recorded nothing, so "every evaluated unit"
  // was false and the recall denominator was silently prose-only.
  test("the ask surface is a DIFFERENT denominator, and says so", () => {
    const record = buildEvaluationRecord("s-1", [], "Recover the service | Hold", "ask-tool-call");
    expect(record.evaluated).toBe("ask-tool-call");
    expect(record.fired).toBe(false);
  });

  test("runAskSurface records an evaluation even when nothing matches", () => {
    const benignAsk: Record<string, unknown> = {
      questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }],
    };
    const input = {
      session_id: "s-ask",
      tool_name: "AskUserQuestion",
      tool_input: benignAsk,
      cwd: "/tmp",
    } as unknown as ToolHookInput;
    // No match -> no GuardOutcome, but the evaluation must still have been
    // recorded. Asserting the no-match outcome pins the branch the R1 finding
    // was about: the early return path.
    expect(runAskSurface(input, ctxWith([]))).toBeNull();
  });

  test("a fired turn names its surfaces", () => {
    const record = buildEvaluationRecord(
      "s-1",
      [
        {
          surface: PERMISSION_PROSE,
          matchedPhrase: "Want me to?",
          context: "I can rerun the migration. Want me to?",
        },
      ],
      "Want me to?"
    );
    expect(record.fired).toBe(true);
    expect(record.surfaces).toEqual([PERMISSION_PROSE]);
  });
});

// ---------------------------------------------------------------------------
// Surface A — capability-deferral prose (the family's R1/R3/R5 prose shapes)
// ---------------------------------------------------------------------------

describe("capability-deferral prose fires without probe evidence", () => {
  const cases = [
    // R1 (mt#1811, 2026-05-13) — the originating PR-body phrasing.
    "Deferred to operator: this requires Railway access to complete.",
    "The remaining step requires GitHub org-admin access.",
    "Operator follow-up: the service has to come back up first.",
    "You'll need to provide the MCP auth token before I can retrigger.",
    "That's outside agent context, so the user must run it.",
    "I don't have access to the hosted service.",
  ];
  for (const phrase of cases) {
    test(`fires: "${phrase.slice(0, 48)}..."`, () => {
      const matches = detectCapabilityDeferral([assistantText(phrase)]);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.surface).toBe(CAPABILITY_PROSE);
    });
  }
});

describe("capability-deferral prose is suppressed by probe evidence", () => {
  test("inline probe report in the prose (the prescribed justified-deferral shape)", () => {
    const line = assistantText(
      "Probed: which gh -> not on PATH; no GitHub-org-admin skill; no memory matches. " +
        "Deferred to operator: requires GitHub org-admin access."
    );
    expect(detectCapabilityDeferral([line])).toHaveLength(0);
  });

  test("a shell capability probe in the same turn", () => {
    const turn = [
      assistantToolUse("Bash", { command: "which railway && railway whoami" }),
      assistantText(DEFERRAL_PROSE),
    ];
    expect(hasProbeEvidence(turn)).toBe(true);
    expect(detectCapabilityDeferral(turn)).toHaveLength(0);
  });

  test("a service-scoped skill load in the same turn", () => {
    const turn = [
      assistantToolUse("Skill", { skill: "railway:use-railway" }),
      assistantText(DEFERRAL_PROSE),
    ];
    expect(detectCapabilityDeferral(turn)).toHaveLength(0);
  });

  test("a config/credential MCP probe in the same turn", () => {
    const turn = [
      assistantToolUse("mcp__minsky__config_get", { key: "mcp.auth.token" }),
      assistantText("You'll need to provide the token."),
    ];
    expect(detectCapabilityDeferral(turn)).toHaveLength(0);
  });

  test("an unrelated skill load is NOT a probe", () => {
    const turn = [
      assistantToolUse("Skill", { skill: "implement-task" }),
      assistantText(DEFERRAL_PROSE),
    ];
    expect(hasProbeEvidence(turn)).toBe(false);
    expect(detectCapabilityDeferral(turn)).toHaveLength(1);
  });

  // PR #2263 R1 BLOCKING: the original `^[a-z0-9][a-z0-9-]*:/` shape treated
  // ANY namespaced skill as a service probe. Namespacing is a catalog-wide
  // convention, so that silently suppressed real deferrals. These pin the
  // allowlist behavior in BOTH directions.
  test.each([["analysis:lint"], ["Notion:search"], ["chrome-devtools-mcp:troubleshooting"]])(
    "a namespaced but non-infra skill (%s) is NOT a probe",
    (skill) => {
      const turn = [assistantToolUse("Skill", { skill }), assistantText(DEFERRAL_PROSE)];
      expect(hasProbeEvidence(turn)).toBe(false);
      expect(detectCapabilityDeferral(turn)).toHaveLength(1);
    }
  );

  test.each([["railway:use-railway"], ["cloudflare:wrangler"], ["supabase:agent"]])(
    "a hosted-infra skill (%s) IS a probe",
    (skill) => {
      const turn = [assistantToolUse("Skill", { skill }), assistantText(DEFERRAL_PROSE)];
      expect(isProbeSkill(skill)).toBe(true);
      expect(detectCapabilityDeferral(turn)).toHaveLength(0);
    }
  );

  test("isProbeSkill rejects a bare name and a leading-colon name", () => {
    expect(isProbeSkill("railway")).toBe(false);
    expect(isProbeSkill(":railway")).toBe(false);
  });

  // PR #2263 R1 NON-BLOCKING: `config_get` and a bare trailing `-v` were
  // removed from PROBE_COMMAND_PATTERN — a Bash command that merely mentions
  // them is not a capability probe.
  test.each([['echo "run config_get mcp.auth.token"'], ["git log -v"], ["grep -v skip file.txt"]])(
    "a Bash command that is not a probe (%s) does not suppress",
    (command) => {
      const turn = [assistantToolUse("Bash", { command }), assistantText(DEFERRAL_PROSE)];
      expect(hasProbeEvidence(turn)).toBe(false);
      expect(detectCapabilityDeferral(turn)).toHaveLength(1);
    }
  );
});

// ---------------------------------------------------------------------------
// SC#2 — fire-on-intended-surface: the tool-interleaved fixture
//
// The verification mt#2057 lacked. Claude Code records tool_result blocks with
// role "user" (mem#528), so a turn-boundary keyed on every user-role line
// collapses a multi-tool turn to only the text after the LAST tool_result —
// making a trigger phrase written BEFORE the tool calls invisible. This
// fixture puts the deferral phrase in the first assistant segment, then
// interleaves tool calls and tool_results after it.
// ---------------------------------------------------------------------------

describe("fires on a tool-interleaved turn (mt#2057 dead-surface regression)", () => {
  const interleaved: TranscriptLine[] = [
    userPrompt("drive the PR to convergence"),
    assistantText("The reviewer service is down. Deferred to operator: requires Railway access."),
    assistantToolUse("mcp__minsky__session_pr_get", { task: "mt#2515" }),
    toolResult('{"status":"open"}'),
    assistantText("Standing by."),
    userPrompt("why can't you fix this yourself?"),
  ];

  test("the phrase before the tool calls is still scanned", () => {
    const outcome = run(
      { session_id: "s1", transcript_path: FIXTURE_PATH } as ClaudeHookInput,
      ctxWith(interleaved)
    );
    expect(outcome).not.toBeNull();
    expect(outcome?.calibration?.["source"]).toBe("live");
  });

  test("scanning ONLY the post-final-tool_result segment would have missed it", () => {
    // Negative control: the trailing segment alone carries no trigger phrase,
    // so a fire can only come from the pre-tool segment.
    expect(detectCapabilityDeferral([assistantText("Standing by.")])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Surface B — AskUserQuestion option labels (R5, mem#582, verbatim)
// ---------------------------------------------------------------------------

const R5_ASK: Record<string, unknown> = {
  questions: [
    {
      question: "The reviewer service is CRASHED and retrigger needs a token. How to proceed?",
      header: "Reviewer down",
      options: [
        { label: R5_LABEL, description: "Restart it on Railway" },
        { label: "Provide me the MCP auth token", description: "So I can call retrigger" },
        { label: "Hold the PR", description: "Wait for the bot to come back" },
      ],
    },
  ],
};

describe("diversity axis (mt#3781)", () => {
  const assistant = (text: string): TranscriptLine[] => [
    userPrompt("go"),
    { type: "assistant", message: { role: "assistant", content: text } },
  ];

  // The SAME trigger phrase in two different preceding clauses — the whole
  // point of the fixtures is that the trigger is identical and the surrounding
  // prose is not.
  const TRIGGER_AFTER_MIGRATION = `The migration is written. ${DEFERRAL_PROSE}`;
  const TRIGGER_AFTER_REVIEW = `Reviewed the diff and it looks fine. ${DEFERRAL_PROSE}`;

  // AT1 — two fires on the SAME trigger phrase in different surrounding prose
  // yield ONE distinct phrase and TWO distinct contexts. This is the property
  // the diversity gate depends on and that a snippet-valued `phrase` destroys.
  test("AT1: same trigger in different prose collapses to one distinct phrase", () => {
    const first = detectCapabilityDeferral(assistant(TRIGGER_AFTER_MIGRATION));
    const second = detectCapabilityDeferral(assistant(TRIGGER_AFTER_REVIEW));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    const distinctPhrases = new Set([first[0]?.matchedPhrase, second[0]?.matchedPhrase]);
    const distinctContexts = new Set([first[0]?.context, second[0]?.context]);

    expect(distinctPhrases.size).toBe(1);
    expect(distinctContexts.size).toBe(2);
  });

  // AT1, through the real consumer rather than a stand-in for it: the same two
  // fires, as calibration records, must produce ONE entry from the function the
  // sweep actually calls.
  test("AT1: extractDistinctPhrases sees one phrase across the two fires", () => {
    const records = [
      buildCalibrationRecord("s1", detectCapabilityDeferral(assistant(TRIGGER_AFTER_MIGRATION))),
      buildCalibrationRecord("s2", detectCapabilityDeferral(assistant(TRIGGER_AFTER_REVIEW))),
    ];

    const parsed = records.map(
      (r) => JSON.parse(JSON.stringify(r)) as Parameters<typeof extractDistinctPhrases>[0][number]
    );
    expect(extractDistinctPhrases(parsed).size).toBe(1);
  });

  // AT2 — the surrounding text is still recoverable from the record, so the
  // classifiability the snippet provided is not lost by the fix.
  test("AT2: the record still carries the surrounding prose", () => {
    const record = buildCalibrationRecord(
      "s1",
      detectCapabilityDeferral(assistant(TRIGGER_AFTER_MIGRATION))
    ) as { matches: Array<{ phrase: string; context: string }> };

    // `leadSentences: 1` pulls in the sentence before the trigger, which is the
    // only thing that distinguishes these two fires — the trigger itself is a
    // whole sentence and identical in both.
    expect(record.matches[0]?.context).toContain("The migration is written");
    expect(record.matches[0]?.phrase).not.toContain("The migration is written");
  });
});

describe("AskUserQuestion option-label surface", () => {
  test("R5 replay: fires on the option labels that hand back a fixable infra action", () => {
    const matches = detectAskDeferral(R5_ASK, []);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe(ASK_OPTION_LABEL);
    // mt#3781 split these. `matchedPhrase` is the PATTERN hit — the sweep's
    // diversity axis, which must be equal across two fires on the same trigger.
    // `context` keeps the original option label, which is what the assertion
    // below originally pinned and what a human reviewer classifies from.
    expect(matches[0]?.context).toContain("recover the reviewer service");
    expect(matches[0]?.matchedPhrase).toBe("You recover");
  });

  test("suppressed when the turn already probed", () => {
    const turn = [assistantToolUse("Bash", { command: "railway whoami" })];
    expect(detectAskDeferral(R5_ASK, turn)).toHaveLength(0);
  });

  test("suppressed for a genuine principal-reserved decision", () => {
    const namingAsk: Record<string, unknown> = {
      questions: [
        {
          question: "What should we call the new surface?",
          header: "Naming",
          options: [
            { label: "You pick the name", description: "Naming is principal-reserved" },
            { label: "Cockpit Vitals", description: "Descriptive" },
          ],
        },
      ],
    };
    expect(detectAskDeferral(namingAsk, [])).toHaveLength(0);
  });

  test("an ordinary approach-choice ask does not fire", () => {
    const ordinary: Record<string, unknown> = {
      questions: [
        {
          question: "Ship the tactical fix now or wait for the refactor?",
          header: "Sequencing",
          options: [
            { label: "Ship now", description: "Unblocks the PR" },
            { label: "Wait", description: "Cleaner" },
          ],
        },
      ],
    };
    expect(detectAskDeferral(ordinary, [])).toHaveLength(0);
  });

  test("malformed tool_input is tolerated, never thrown on", () => {
    expect(() => detectAskDeferral(undefined, [])).not.toThrow();
    expect(detectAskDeferral({ questions: "not-an-array" }, [])).toHaveLength(0);
    expect(detectAskDeferral({ questions: [{ options: [null, 7] }] }, [])).toHaveLength(0);
    expect(extractAskTexts(undefined).optionTexts).toHaveLength(0);
  });

  test("runAskSurface returns a calibration outcome through the dispatcher contract", () => {
    const outcome = runAskSurface(
      {
        session_id: "s2",
        transcript_path: FIXTURE_PATH,
        tool_name: "AskUserQuestion",
        tool_input: R5_ASK,
      } as unknown as ToolHookInput,
      ctxWith([userPrompt("drive the PR")])
    );
    expect(outcome).not.toBeNull();
    const matches = outcome?.calibration?.["matches"] as Array<Record<string, unknown>>;
    expect(matches[0]?.["category"]).toBe(ASK_OPTION_LABEL);
  });
});

// ---------------------------------------------------------------------------
// mt#3273 — self-referential quoting must not fire.
//
// The detector's FIRST live calibration record (2026-07-28T17:03:56Z) was a
// false positive: a turn DESCRIBING this detector quoted "requires Railway
// access" as an example, and the prose surface matched the quoted example.
// `elideQuotedContexts` covers backticks/fences/blockquotes but deliberately
// not double-quoted prose; `elideDoubleQuotedSpans` covers exactly that class
// and existed already. Both are now applied.
// ---------------------------------------------------------------------------

describe("does not fire on trigger phrases quoted in prose (mt#3273)", () => {
  // Verbatim reconstruction of the text behind the first live record. The
  // logged matchedPhrase was:
  //   'ty-deferral prose ("requires Railway access") when the turn shows no
  //    probe; Surface B catches the same'
  const FIRST_LIVE_FIRE_TEXT =
    'Surface A catches capability-deferral prose ("requires Railway access") when the turn ' +
    "shows no probe; Surface B catches the same deferral hiding in AskUserQuestion option labels.";

  test("the exact turn behind the first live fire no longer fires", () => {
    expect(detectCapabilityDeferral([assistantText(FIRST_LIVE_FIRE_TEXT)])).toHaveLength(0);
  });

  test.each([
    ['He said the deploy "requires Railway access" in the postmortem.'],
    ['The detector matches "deferred to operator" and similar phrasings.'],
    ["A curly-quoted “operator follow-up” mention is also elided."],
  ])("quoted mention does not fire: %s", (text) => {
    expect(detectCapabilityDeferral([assistantText(text)])).toHaveLength(0);
  });

  test("an UNQUOTED deferral still fires — elision must not swallow real positives", () => {
    const matches = detectCapabilityDeferral([assistantText(DEFERRAL_PROSE)]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe(CAPABILITY_PROSE);
  });

  test("a quoted mention alongside a real unquoted deferral still fires", () => {
    const text =
      'The rule names "requires Railway access" as the example. ' +
      "Separately: I don't have access to the hosted service.";
    expect(detectCapabilityDeferral([assistantText(text)])).toHaveLength(1);
  });

  test("backtick and blockquote elision still works (no regression)", () => {
    expect(
      detectCapabilityDeferral([assistantText("The pattern `deferred to operator` is matched.")])
    ).toHaveLength(0);
    expect(
      detectCapabilityDeferral([assistantText("> Deferred to operator: requires Railway access.")])
    ).toHaveLength(0);
  });

  // PR #2355 R1: stripQuoteChars must not touch apostrophes. Removing them
  // rewrites word content (`you'll` -> `youll`) and shifts the \b boundaries
  // every pattern here depends on — a side effect beyond unwrapping a
  // decoration, and one that would make matching depend on contraction
  // spelling. Same line elideDoubleQuotedSpans already draws for prose.
  test("stripQuoteChars removes double quotes only, preserving apostrophes", () => {
    expect(stripQuoteChars('the "MCP auth token"')).toBe("the MCP auth token");
    expect(stripQuoteChars("the “MCP auth token”")).toBe("the MCP auth token");
    expect(stripQuoteChars("you'll restart it; don't wait — the operator's call")).toBe(
      "you'll restart it; don't wait — the operator's call"
    );
    expect(stripQuoteChars("it’s the agent’s job")).toBe("it’s the agent’s job");
  });

  test("an apostrophe-bearing label is matched on its real words, not a rewrite", () => {
    const ask: Record<string, unknown> = {
      questions: [
        {
          question: "The service is down.",
          options: [{ label: "You restart the reviewer service" }, { label: "Hold the PR" }],
        },
      ],
    };
    expect(detectAskDeferral(ask, [])).toHaveLength(1);
  });

  // The ask surface deliberately does NOT elide — a label does not quote a
  // deferral, it IS one, so quotes there name the thing being handed over.
  test("ask-option-label surface still fires when the label contains quotes", () => {
    const quotedLabelAsk: Record<string, unknown> = {
      questions: [
        {
          question: "Retrigger needs credentials.",
          options: [{ label: 'Provide me the "MCP auth token"' }, { label: "Hold the PR" }],
        },
      ],
    };
    expect(detectAskDeferral(quotedLabelAsk, [])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scope boundary — mt#2303 owns the activation-instruction family.
//
// Pins the reconciliation recorded in mt#2459's spec: these phrasings must
// fire substrate-bypass-detector's OPERATOR_INSTRUCTION_PATTERNS, NOT this
// detector. A fire here would double-count the same incident in two
// calibration logs and corrupt both FP rates.
// ---------------------------------------------------------------------------

describe("does NOT duplicate mt#2303's activation-instruction surface", () => {
  const mt2303Cases = [
    "After your next `bun run cockpit:build` + hard-refresh, the card will read Embeddings.",
    "Hard-refresh your browser to see the change.",
    "Rebuild to pick up the fix.",
  ];
  for (const phrase of mt2303Cases) {
    test(`ignores (mt#2303 owns it): "${phrase.slice(0, 44)}..."`, () => {
      expect(detectCapabilityDeferral([assistantText(phrase)])).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Calibration-first posture + record shape
// ---------------------------------------------------------------------------

describe("calibration-first posture", () => {
  test("v1 is log-only", () => {
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("no injection is emitted while the gate is closed", () => {
    const outcome = run(
      { session_id: "s3", transcript_path: FIXTURE_PATH } as ClaudeHookInput,
      ctxWith([userPrompt("go"), assistantText(DEFERRAL_PROSE), userPrompt("next")])
    );
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("record carries the mt#2554 coverage-receipt source field and matches shape", () => {
    const record = buildCalibrationRecord("s4", [
      { surface: ASK_OPTION_LABEL, matchedPhrase: R5_LABEL, context: R5_LABEL },
    ]);
    expect(record["source"]).toBe("live");
    expect(record["injection_enabled"]).toBe(false);
    const matches = record["matches"] as Array<Record<string, unknown>>;
    expect(matches[0]).toEqual({
      category: ASK_OPTION_LABEL,
      phrase: R5_LABEL,
      // `context` is required on DeferralMatch and IS written to the record;
      // the previous expectation only omitted it because the fixture above
      // omitted it, which nothing typechecked until mt#2900.
      context: R5_LABEL,
    });
  });

  test("the reminder names the probe sequence and the override var", () => {
    const reminder = buildReminder([
      {
        surface: CAPABILITY_PROSE,
        matchedPhrase: "requires Railway access",
        context: "Deferred — this requires Railway access.",
      },
    ]);
    expect(reminder).toContain("whoami");
    // Inverted (mt#4002): the advisory must NOT advertise its override.
    // `guard-feedback-authoring.mdc` bans it — the agent is the wrong reader for
    // an exit, and `CLAUDE.md §Hook Files` is where the operator finds it. The
    // old assertion required the violation, and nothing caught the conflict
    // because this guard renders no live text for the authoring check to read.
    expect(reminder).not.toContain(OVERRIDE_ENV_VAR);
  });

  test("a clean turn produces no outcome", () => {
    const outcome = run(
      { session_id: "s5", transcript_path: FIXTURE_PATH } as ClaudeHookInput,
      ctxWith([userPrompt("go"), assistantText("Merged and verified."), userPrompt("next")])
    );
    expect(outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Surface D — denial-anchored deferral (mt#3533)
// ---------------------------------------------------------------------------

const DENIAL_ANCHORED = "denial-anchored";

/**
 * The two canned denial bodies Claude Code actually emits. Established by
 * measurement over this project's 460 local transcripts on 2026-08-11 (73 denial
 * results, no other continuation observed), NOT from vendor documentation, which
 * does not specify the shape.
 */
const DENIAL_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected " +
  "(eg. if it was a file edit, the new_string was NOT written to the file). ";
const DENIAL_NO_REASON = `${DENIAL_PREFIX}STOP what you are doing and wait for the user to tell you how to proceed.`;
const DENIAL_WITH_ECHOED_REASON =
  `${DENIAL_PREFIX}To tell you how to proceed, the user said:\n` +
  "The user doesn't want to proceed with this tool use.";

/**
 * SYNTHETIC — deliberately not drawn from the corpus, because the corpus has no
 * such record: zero of the 73 observed denials carried a security framing. The
 * reason string is mem#276's verbatim 2026-04-23 denial, which is the only
 * recorded instance of this shape anywhere. Labeled synthetic per mt#3533 SC#4
 * so a reader does not mistake it for a replay.
 */
const DENIAL_SECURITY_FRAMED_SYNTHETIC =
  `${DENIAL_PREFIX}To tell you how to proceed, the user said:\n` +
  "credential/permission exploration to work around a merge block — not a user-authorized action.";

/** The 2026-08-08 Railway incident's two command shapes, verbatim in structure. */
const DENIED_COMPOUND_CURL =
  "railway whoami >/dev/null; TOKEN=$(jq -r .token ~/.railway/config.json); " +
  'curl -s -X POST https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer $TOKEN" -d @p.json';
const RESHAPED_CURL =
  'curl -s -X POST https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer $(jq -r .token ~/.railway/config.json)" -d @p.json';

const bashCall = (id: string, command: string): TranscriptLine => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
  },
});

/** A denial result correlated to `id` — role "user", per mem#528. */
const denialResult = (id: string, text: string = DENIAL_NO_REASON): TranscriptLine => ({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text }] },
    ],
  },
});

const asksCreate = (): TranscriptLine =>
  assistantToolUse("mcp__minsky__asks_create", {
    title: "The harness blocks the Railway write; please add a Bash permission rule.",
  });

describe("Surface D — denial-anchored deferral (mt#3533)", () => {
  test("AT1: fires on the 2026-08-08 Railway shape — denial, then an ask, no reshaped retry", () => {
    const matches = detectDenialAnchoredDeferral([
      bashCall("toolu_1", DENIED_COMPOUND_CURL),
      denialResult("toolu_1"),
      assistantText("The harness blocks the mutating call, so this needs an operator decision."),
      asksCreate(),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe(DENIAL_ANCHORED);
    // The phrase is the denied CHANNEL, recovered from the tool_use — which is
    // also the assertion that the tool_use_id join worked, since the denial
    // result itself carries no command.
    expect(matches[0]?.matchedPhrase).toBe("railway");
    expect(matches[0]?.context).toContain("backboard.railway.com");
  });

  test("AT2: a same-turn retry in a different command shape suppresses the fire", () => {
    const matches = detectDenialAnchoredDeferral([
      bashCall("toolu_1", DENIED_COMPOUND_CURL),
      denialResult("toolu_1"),
      bashCall("toolu_2", RESHAPED_CURL),
      asksCreate(),
    ]);
    expect(matches).toEqual([]);
  });

  test("AT2b: compound-to-simple counts as reshaped even with the same leading token", () => {
    const matches = detectDenialAnchoredDeferral([
      bashCall("toolu_1", "curl https://a.example; curl https://b.example"),
      denialResult("toolu_1"),
      bashCall("toolu_2", "curl https://b.example"),
      asksCreate(),
    ]);
    expect(matches).toEqual([]);
  });

  test("AT2c: re-running the SAME command is not a reshape, so the fire stands", () => {
    const matches = detectDenialAnchoredDeferral([
      bashCall("toolu_1", DENIED_COMPOUND_CURL),
      denialResult("toolu_1"),
      bashCall("toolu_2", DENIED_COMPOUND_CURL),
      asksCreate(),
    ]);
    expect(matches).toHaveLength(1);
  });

  test("AT3 (SYNTHETIC fixture): a security-framed denial never fires — mem#276's carve-out", () => {
    const matches = detectDenialAnchoredDeferral([
      bashCall("toolu_1", "gh api /repos/o/r/installation/tokens"),
      denialResult("toolu_1", DENIAL_SECURITY_FRAMED_SYNTHETIC),
      assistantText("This is deferred to the operator: it requires admin credentials."),
      asksCreate(),
    ]);
    expect(matches).toEqual([]);
  });

  test("AT4: a denial with no escalation and no deferral prose does not fire", () => {
    const matches = detectDenialAnchoredDeferral([
      bashCall("toolu_1", DENIED_COMPOUND_CURL),
      denialResult("toolu_1"),
      assistantText("Understood — moving on to the next item."),
    ]);
    expect(matches).toEqual([]);
  });

  test("deferral PROSE alone escalates the denial, with no ask tool call", () => {
    const matches = detectDenialAnchoredDeferral([
      bashCall("toolu_1", DENIED_COMPOUND_CURL),
      denialResult("toolu_1", DENIAL_WITH_ECHOED_REASON),
      assistantText("Deferred to operator: requires Railway access."),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe(DENIAL_ANCHORED);
  });

  test("an ask raised BEFORE the denial does not count — ordering is checked", () => {
    const matches = detectDenialAnchoredDeferral([
      asksCreate(),
      bashCall("toolu_1", DENIED_COMPOUND_CURL),
      denialResult("toolu_1"),
      assistantText("Moving on."),
    ]);
    expect(matches).toEqual([]);
  });

  test("an ordinary tool ERROR is not a denial", () => {
    const matches = detectDenialAnchoredDeferral([
      bashCall("toolu_1", DENIED_COMPOUND_CURL),
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              is_error: true,
              content: [{ type: "text", text: "curl: (6) Could not resolve host" }],
            },
          ],
        },
      },
      asksCreate(),
    ]);
    expect(matches).toEqual([]);
  });

  test("the rejection string in a SUCCESSFUL result is not a denial", () => {
    // The false-positive vector `is_error` closes: a tool that echoes prior
    // conversation back — reading a transcript, grepping a calibration log —
    // returns the canonical rejection text in a result that did not fail.
    const matches = detectDenialAnchoredDeferral([
      bashCall("toolu_1", "grep -r 'proceed with this tool use' ~/.claude/projects"),
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: DENIAL_NO_REASON }],
            },
          ],
        },
      },
      asksCreate(),
    ]);
    expect(matches).toEqual([]);
  });

  test("a turn with no denial at all is untouched", () => {
    expect(detectDenialAnchoredDeferral([assistantText("All green."), asksCreate()])).toEqual([]);
  });

  test("run() reports the surface through the calibration record", () => {
    const outcome = run(
      { session_id: "s-d", transcript_path: FIXTURE_PATH } as ClaudeHookInput,
      ctxWith([
        userPrompt("apply the setting"),
        bashCall("toolu_1", DENIED_COMPOUND_CURL),
        denialResult("toolu_1"),
        asksCreate(),
        userPrompt("next"),
      ])
    );
    const matches = outcome?.calibration?.["matches"] as Array<Record<string, unknown>> | undefined;
    expect(matches?.some((m) => m["category"] === DENIAL_ANCHORED)).toBe(true);
  });

  test("the advisory carries the reshape directive, not the probe directive", () => {
    const reminder = buildReminder([
      { surface: DENIAL_ANCHORED, matchedPhrase: "railway", context: DENIED_COMPOUND_CURL },
    ]);
    expect(reminder).toContain("simpler shape");
    expect(reminder).toContain("security concern");
    // The probe sentence belongs to the other three surfaces; handing it to this
    // one would name the wrong next action (`guard-feedback-authoring.mdc`).
    // Asserted on the directive's own wording, NOT on a token like "whoami":
    // that string also appears inside the quoted denied command, so it would
    // pass or fail for a reason unrelated to the directive.
    expect(reminder).not.toContain("Run the capability probe");
  });

  // mt#3533's per-guard size test is GONE (mt#4002). `guard-feedback-shape.test.ts`
  // now measures this guard's render through the registry's `renderProbe`, along
  // with every other calibration-first guard, so keeping a hand-written size
  // check in one guard's own file would be a second copy of a shared check —
  // free to drift, and exactly what mt#4002's SC#2 asked to be removed. The
  // renderer it posed is now `renderWorstCase()` in the module, which the probe
  // calls.

  test("a turn tripping both shapes gets both directives — the guard's worst case", () => {
    const reminder = buildReminder([
      {
        surface: CAPABILITY_PROSE,
        matchedPhrase: "requires Railway access",
        context: DEFERRAL_PROSE,
      },
      { surface: DENIAL_ANCHORED, matchedPhrase: "railway", context: DENIED_COMPOUND_CURL },
    ]);
    expect(reminder).toContain("simpler shape");
    expect(reminder).toContain("Run the capability probe");
  });
});
