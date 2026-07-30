import { describe, expect, test } from "bun:test";
import {
  detectCapabilityDeferral,
  detectAskDeferral,
  extractAskTexts,
  hasProbeEvidence,
  isProbeSkill,
  stripQuoteChars,
  buildCalibrationRecord,
  buildReminder,
  run,
  runAskSurface,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
} from "./operator-deferral-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput, ToolHookInput } from "./types";
import type { DispatchContext } from "./registry";

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

describe("AskUserQuestion option-label surface", () => {
  test("R5 replay: fires on the option labels that hand back a fixable infra action", () => {
    const matches = detectAskDeferral(R5_ASK, []);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe(ASK_OPTION_LABEL);
    expect(matches[0]?.matchedPhrase).toContain("recover the reviewer service");
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
      { surface: ASK_OPTION_LABEL, matchedPhrase: R5_LABEL },
    ]);
    expect(record["source"]).toBe("live");
    expect(record["injection_enabled"]).toBe(false);
    const matches = record["matches"] as Array<Record<string, unknown>>;
    expect(matches[0]).toEqual({
      category: ASK_OPTION_LABEL,
      phrase: R5_LABEL,
    });
  });

  test("the reminder names the probe sequence and the override var", () => {
    const reminder = buildReminder([
      { surface: CAPABILITY_PROSE, matchedPhrase: "requires Railway access" },
    ]);
    expect(reminder).toContain("whoami");
    expect(reminder).toContain(OVERRIDE_ENV_VAR);
  });

  test("a clean turn produces no outcome", () => {
    const outcome = run(
      { session_id: "s5", transcript_path: FIXTURE_PATH } as ClaudeHookInput,
      ctxWith([userPrompt("go"), assistantText("Merged and verified."), userPrompt("next")])
    );
    expect(outcome).toBeNull();
  });
});
