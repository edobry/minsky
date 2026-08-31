import { describe, expect, test } from "bun:test";
import {
  detectCapabilityDeferral,
  detectPermissionDeferral,
  detectDenialAnchoredDeferral,
  detectAskJustificationAbsence,
  summarizeAskJustificationEvaluation,
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
  runArtifactSurface,
  detectArtifactBodyDeferral,
  readArtifactBodyForCall,
  ARTIFACT_TEXT_FIELD_BY_TOOL,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  detectActPathWorkaround,
  isDestructiveCommand,
  hasCapabilitySearch,
  findReportableKill,
  buildKillContext,
  REPORTABLE_KILL_MIN_TARGETS,
} from "./operator-deferral-detector";
import { findKillVerb } from "./block-bulk-process-kill";
import { findOfferShape } from "./ask-routing-deferral-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput, ToolHookInput } from "./types";
import type { DispatchContext } from "./registry";
import { extractDistinctPhrases } from "../../src/domain/calibration/calibration-sweep";

// ---------------------------------------------------------------------------
// Shared fixture literals
// ---------------------------------------------------------------------------

const FIXTURE_PATH = "/tmp/fixture.jsonl";
/** The capability-deferral phrase behind this detector's first live fire. */
const RAILWAY_ACCESS = "requires Railway access";
const DEFERRAL_PROSE = `Deferred to operator: ${RAILWAY_ACCESS}.`;
/** The generic directive's opening — asserted present on some surfaces, ABSENT on others. */
const PROBE_DIRECTIVE = "Run the capability probe";
const ASK_OPTION_LABEL = "ask-option-label";
const CAPABILITY_PROSE = "capability-deferral-prose";
const R5_LABEL = "You recover the reviewer service";
/** Shared `test.each` title for every suppression corpus below. */
const STAYS_SILENT = "stays silent: %s";

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

// ---------------------------------------------------------------------------
// mt#3801 — the structural offer shape reaches this surface too.
//
// `PERMISSION_DEFERRAL_PATTERNS` is entirely interrogative or imperative
// ("shall I", "want me to", "say the word"). A NEGATED DEFAULT — a declarative
// next step with a trailing `unless` — matched none of the eight and this
// surface stayed silent on it. The trigger is the shared `findOfferShape`
// conjunction, and the point of these cases is that it lands on the SAME
// suppression chain the literal corpus already passes through.
// ---------------------------------------------------------------------------

/** Verbatim from the 2026-08-05 incident turn (R9 of the family, mem#831). */
const OFFER_SHAPE_PROSE =
  "Next step is /plan-task mt#3799 unless you'd rather I go straight at it.";

describe("Surface C — the offer shape (mt#3801)", () => {
  test("AT3: the originating sentence now fires permission-deferral-prose", () => {
    const matches = detectPermissionDeferral([assistantText(OFFER_SHAPE_PROSE)]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe(PERMISSION_PROSE);
  });

  test("AT4: a factual `unless` with no actor stays quiet", () => {
    const prose = "The migration ran cleanly unless a row was locked, in which case it retried.";
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });

  // AT5. The exclusions are the load-bearing half of this surface: the shape of
  // a permission-ask is identical whether the action is in-authority or
  // genuinely reserved, and only the ACTION discriminates. A new way to MATCH
  // must not become a new way to bypass them — which is why both paths call one
  // suppression chain rather than each carrying a copy.
  test("AT5: a destructive offer is excluded, exactly as the literal corpus is", () => {
    const prose = "I can force-push it, unless you'd rather review first.";
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });

  test("a principal-reserved offer is excluded", () => {
    const prose =
      "That is a naming call for the product surface. I can pick one unless you'd rather decide.";
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });

  test("a standing-instruction offer is excluded (the mt#3865 Cause C conjunction)", () => {
    const prose = "You said file only. I can take it to READY unless you'd rather I hold.";
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });

  test("a settled-decision offer is excluded", () => {
    const prose =
      "I picked the second one, since this turn has run long — unless you'd rather I redo it.";
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });

  // The negative control for the exclusion tests above: without it they pass
  // whenever the trigger simply fails to match, which is how AT5 passed
  // VACUOUSLY before this change — no `unless`-shaped entry existed in the
  // corpus at all, so nothing reached the exclusions to be excluded by them.
  test("the exclusion cases DO carry an offer shape — they are excluded, not unmatched", () => {
    expect(findOfferShape("I can force-push it, unless you'd rather review first.")).not.toBeNull();
    expect(
      findOfferShape("You said file only. I can take it to READY unless you'd rather I hold.")
    ).not.toBeNull();
  });

  test("a quoted offer shape does not fire (elision parity with the literal corpus)", () => {
    const prose = 'The detector matches shapes like "X unless you\'d rather I do Y" in prose.';
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });

  test("probe evidence suppresses the offer shape too", () => {
    const lines = [
      assistantToolUse("Bash", { command: "which railway" }),
      toolResult("/opt/homebrew/bin/railway"),
      assistantText("Probed: railway CLI present. I'll redeploy unless you'd rather hold."),
    ];
    expect(detectPermissionDeferral(lines)).toEqual([]);
  });

  // Additive: a turn matching a literal pattern keeps that pattern's phrase, so
  // no pre-existing calibration record changes shape.
  test("a literal match still reports its literal phrase", () => {
    const prose =
      "The daemon needs a restart. Say the word and I'll do it unless you'd rather not.";
    const matches = detectPermissionDeferral([assistantText(prose)]);
    expect(matches[0]?.matchedPhrase).toBe("Say the word and I'll");
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
// Surface G — artifact-body deferral (mt#4769)
// ---------------------------------------------------------------------------

describe("mt#4769: a deferral authored into an artifact body is observable", () => {
  /** The shape of the originating incident: a deferral in a PR body. */
  const DEFERRING_BODY = `## Outcome\n\nThe remaining step ${RAILWAY_ACCESS}, so it is deferred to the operator.\n`;

  const prCreate = (body: unknown): ToolHookInput =>
    ({
      session_id: "s-artifact",
      tool_name: "mcp__minsky__session_pr_create",
      tool_input: { title: "Ship the thing", body },
      cwd: "/tmp",
    }) as unknown as ToolHookInput;

  // AT1 — the surface fires and the record carries the evidence a reviewer
  // needs to classify it.
  test("AT1: a capability-shaped deferral in a PR body produces an artifact-body calibration record", () => {
    const outcome = runArtifactSurface(prCreate(DEFERRING_BODY), ctxWith([]));
    expect(outcome).not.toBeNull();

    const calibration = outcome?.calibration as Record<string, unknown>;
    // The unit, so a false-positive review can separate this class from the
    // chat-prose one. Before mt#4769 the calibration log had no such field and
    // three units would have written one undifferentiated stream.
    expect(calibration.evaluated).toBe("artifact-body");
    expect(calibration.source).toBe("live");

    const matches = calibration.matches as Array<Record<string, unknown>>;
    expect(matches.length).toBeGreaterThan(0);
    // The body carries two capability-deferral shapes at once and WHICH pattern
    // wins is a precedence detail, not this test's subject — pinning it would
    // couple the artifact surface to the pattern list's ordering. Assert the
    // pair of properties that actually matter: `phrase` is the pattern hit (the
    // sweep's diversity axis) and `context` is the surrounding prose a human
    // reads to classify the fire. Both must be populated (mt#3781).
    expect(String(matches[0]?.phrase)).toContain("deferred to the operator");
    expect(String(matches[0]?.context)).toContain(RAILWAY_ACCESS);
  });

  // AT2 — the denominator. Without this the artifact class would have matches
  // and no population, and SC5's measured FP rate would have no divisor.
  test("AT2: a body with no deferral prose yields no outcome (its evaluation is still recorded)", () => {
    const benign = `## Summary\n\nRenames a constant and updates its two call sites.\n`;
    expect(runArtifactSurface(prCreate(benign), ctxWith([]))).toBeNull();
  });

  test("the spec-patch param is read too, not just the PR body", () => {
    const input = {
      session_id: "s-artifact-spec",
      tool_name: "mcp__minsky__tasks_spec_patch",
      tool_input: { taskId: "mt#1", content: DEFERRING_BODY },
      cwd: "/tmp",
    } as unknown as ToolHookInput;
    expect(runArtifactSurface(input, ctxWith([]))).not.toBeNull();
  });

  test("the field map names exactly the three writes the rule names", () => {
    expect(ARTIFACT_TEXT_FIELD_BY_TOOL).toEqual({
      session_pr_create: "body",
      session_pr_edit: "body",
      tasks_spec_patch: "content",
    });
  });

  test("a tool outside the map yields no text, so no empty-denominator row is written", () => {
    const input = {
      session_id: "s-other",
      tool_name: "mcp__minsky__session_commit",
      tool_input: { message: `This ${RAILWAY_ACCESS}.` },
      cwd: "/tmp",
    } as unknown as ToolHookInput;
    expect(readArtifactBodyForCall(input.tool_name, input.tool_input).text).toBeNull();
    expect(runArtifactSurface(input, ctxWith([]))).toBeNull();
  });

  test("a non-string body is not coerced into a match", () => {
    expect(runArtifactSurface(prCreate(undefined), ctxWith([]))).toBeNull();
    expect(runArtifactSurface(prCreate({ nested: "x" }), ctxWith([]))).toBeNull();
  });

  test("an empty body is not evaluated as a match", () => {
    expect(detectArtifactBodyDeferral([], "   \n  ")).toEqual([]);
  });

  // AT4 — negative control, in its mechanical form. The FULL-revert control is
  // in the PR body; this one pins the dispatch gate specifically.
  test("AT4: with the guard overridden, a firing body produces nothing", () => {
    const prior = process.env[OVERRIDE_ENV_VAR];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      expect(runArtifactSurface(prCreate(DEFERRING_BODY), ctxWith([]))).toBeNull();
    } finally {
      if (prior === undefined) delete process.env[OVERRIDE_ENV_VAR];
      else process.env[OVERRIDE_ENV_VAR] = prior;
    }
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
  test("a quoted CREDENTIAL label is no longer this detector's (carve to mt#2428)", () => {
    // Was: "ask-option-label surface still fires when the label contains
    // quotes". mt#3273's finding was that quote CHARACTERS silently broke
    // matching; that intent did not disappear, it MOVED — the equivalent
    // assertion now lives in
    // `packages/domain/src/detectors/secret-request-in-chat.test.ts`
    // ("a quote-decorated label still fires"), because a label offering to hand
    // over a secret VALUE is `secret-request-in-chat-detector`'s subject.
    //
    // Kept here as a carve-boundary regression test rather than deleted: if
    // someone re-adds the credential pattern to this surface, both detectors
    // fire on one label and the double-count returns.
    const quotedLabelAsk: Record<string, unknown> = {
      questions: [
        {
          question: "Retrigger needs credentials.",
          options: [{ label: 'Provide me the "MCP auth token"' }, { label: "Hold the PR" }],
        },
      ],
    };
    expect(detectAskDeferral(quotedLabelAsk, [])).toHaveLength(0);
  });

  test("but an INFRA-action label with quotes still fires here", () => {
    // The quote-tolerance itself is still this surface's property — only the
    // credential vocabulary left. Without this control the assertion above
    // would pass just as well if option-label matching were broken outright.
    const quotedLabelAsk: Record<string, unknown> = {
      questions: [
        {
          question: "The reviewer is down.",
          options: [{ label: 'You restart the "reviewer" service' }, { label: "Hold the PR" }],
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
        matchedPhrase: RAILWAY_ACCESS,
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
  assistantToolUse(ASKS_CREATE_TOOL, {
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
    expect(reminder).not.toContain(PROBE_DIRECTIVE);
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
        matchedPhrase: RAILWAY_ACCESS,
        context: DEFERRAL_PROSE,
      },
      { surface: DENIAL_ANCHORED, matchedPhrase: "railway", context: DENIED_COMPOUND_CURL },
    ]);
    expect(reminder).toContain("simpler shape");
    expect(reminder).toContain(PROBE_DIRECTIVE);
  });
});

// ---------------------------------------------------------------------------
// Surface E — ask-justification capability-absence (mt#3999)
// ---------------------------------------------------------------------------

const ASK_JUSTIFICATION = "ask-justification";

/** The channel that lied in the anchor instance — and that surface A counts as a probe. */
const CREDENTIALS_LIST_TOOL = "mcp__minsky__config_credentials_list";

/** The independent channel that would have falsified it. */
const AI_VALIDATE_TOOL = "mcp__minsky__ai_validate";

/** The tool whose payload carries an ask justification. */
const ASKS_CREATE_TOOL = "mcp__minsky__asks_create";

/**
 * ask#6754's claim, verbatim in substance (mt#3547, 2026-08-01): the agent read
 * ONE channel, the credential store, which returned exit-0 JSON that silently
 * omitted the provider — and then asked the operator to authorize pulling a
 * PRODUCTION credential off Railway on that premise.
 */
const ANCHOR_JUSTIFICATION =
  "I have no OpenAI key — the credential store has Anthropic and Google, not OpenAI. May I " +
  "pull the production key off Railway so the replay corpus can run?";

const OPERATOR_ROUTED_RESULT = JSON.stringify({
  id: "ask-1",
  state: "routed",
  routingTarget: "operator",
  transport: "inbox",
});

const POLICY_CLOSED_RESULT = JSON.stringify({
  id: "ask-1",
  state: "closed",
  routingTarget: "policy",
});

function correlatedToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>
): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  } as unknown as TranscriptLine;
}

function correlatedToolResult(id: string, content: string): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  } as unknown as TranscriptLine;
}

/** A turn that creates an ask, plus whatever channel calls preceded it. */
function askTurn(options: {
  justification?: string;
  result?: string;
  channels?: Array<{ name: string; input?: Record<string, unknown> }>;
}): TranscriptLine[] {
  const {
    justification = ANCHOR_JUSTIFICATION,
    result = OPERATOR_ROUTED_RESULT,
    channels = [{ name: CREDENTIALS_LIST_TOOL }],
  } = options;

  const lines: TranscriptLine[] = [];
  channels.forEach((channel, i) => {
    lines.push(correlatedToolUse(`toolu_ch${i}`, channel.name, channel.input ?? {}));
    lines.push(correlatedToolResult(`toolu_ch${i}`, "{}"));
  });
  lines.push(
    correlatedToolUse("toolu_ask", ASKS_CREATE_TOOL, {
      kind: "authorization.approve",
      title: "Authorize pulling the production OpenAI key",
      question: justification,
    })
  );
  lines.push(correlatedToolResult("toolu_ask", result));
  return lines;
}

describe("surface E — ask-justification capability-absence (mt#3999)", () => {
  test("AT1: the anchor instance fires, and the advisory names the second channel", () => {
    const matches = detectAskJustificationAbsence(askTurn({}));

    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe(ASK_JUSTIFICATION);
    expect(matches[0]?.matchedPhrase).toContain("no OpenAI key");

    const reminder = buildReminder(matches);
    // SC2: the guidance names the CONCRETE second channel for the named
    // subject, not "run a probe" — which is the failure, restated as advice.
    expect(reminder).toContain("ai_providers_list");
    expect(reminder).toContain("ai_validate --provider OpenAI");
  });

  test("AT1 crux: it fires even though the turn DID call a probe-listed tool", () => {
    const turn = askTurn({});

    // The distinction the whole surface rests on. `hasProbeEvidence` — what
    // surfaces A and C suppress on — says this turn probed, because
    // `config_credentials_list` is on its probe list. That call is exactly what
    // produced the false premise, so suppressing here would blind the detector
    // to its own anchor instance.
    expect(hasProbeEvidence(turn)).toBe(true);
    expect(detectAskJustificationAbsence(turn)).toHaveLength(1);
  });

  test("AT2: a genuine SECOND channel in the same turn suppresses it", () => {
    const matches = detectAskJustificationAbsence(
      askTurn({
        channels: [
          { name: CREDENTIALS_LIST_TOOL },
          { name: AI_VALIDATE_TOOL, input: { provider: "openai" } },
        ],
      })
    );
    expect(matches).toEqual([]);
  });

  test("AT2b: two calls on the SAME channel are still one channel", () => {
    const matches = detectAskJustificationAbsence(
      askTurn({
        channels: [
          { name: CREDENTIALS_LIST_TOOL },
          { name: "mcp__minsky__config_get", input: { key: "ai.providers" } },
        ],
      })
    );
    expect(matches).toHaveLength(1);
  });

  test("AT3: a justification asserting no non-existence does not fire", () => {
    const matches = detectAskJustificationAbsence(
      askTurn({
        justification:
          "Should the cockpit surface be called Attention or Inbox? Both read fine to me and " +
          "this sets a precedent, so it is your call.",
      })
    );
    expect(matches).toEqual([]);
  });

  test("AT4: an ask the router did NOT send to the operator does not fire", () => {
    const matches = detectAskJustificationAbsence(askTurn({ result: POLICY_CLOSED_RESULT }));
    // A policy-covered ask short-circuits to closed and reaches no human, so it
    // spends none of the attention this surface is about.
    expect(matches).toEqual([]);
  });

  test("AT4b: a quoted absence claim is not read as an asserted one", () => {
    const matches = detectAskJustificationAbsence(
      askTurn({
        justification:
          'The reviewer bot wrote "I have no OpenAI key" in its finding. Is that finding worth ' +
          "acting on, or should I dismiss it?",
      })
    );
    expect(matches).toEqual([]);
  });

  test("AT5: fired and non-fired turns both record the surface-E conjuncts", () => {
    const fired = summarizeAskJustificationEvaluation(askTurn({}));
    expect(fired).toEqual({
      operatorRoutedAsks: 1,
      absenceClaimPresent: true,
      distinctChannels: 1,
    });

    const suppressed = summarizeAskJustificationEvaluation(
      askTurn({
        channels: [
          { name: CREDENTIALS_LIST_TOOL },
          { name: AI_VALIDATE_TOOL, input: { provider: "openai" } },
        ],
      })
    );
    expect(suppressed.absenceClaimPresent).toBe(true);
    expect(suppressed.distinctChannels).toBe(2);

    // The record carries them, so a review can recover the population by
    // filtering rather than needing a separate denominator.
    const record = buildEvaluationRecord(undefined, [], "", "prose-turn", fired);
    expect(record["ask_justification"]).toEqual(fired);
    expect(record["evaluated"]).toBe("prose-turn");
  });

  test("AT5b: distinctChannels is turn-level across MULTIPLE routed asks (PR #2920 R1)", () => {
    const twoAsks: TranscriptLine[] = [
      correlatedToolUse("toolu_c0", CREDENTIALS_LIST_TOOL, {}),
      correlatedToolResult("toolu_c0", "{}"),
      correlatedToolUse("toolu_c1", AI_VALIDATE_TOOL, { provider: "openai" }),
      correlatedToolResult("toolu_c1", "{}"),
      correlatedToolUse("toolu_a1", ASKS_CREATE_TOOL, { question: ANCHOR_JUSTIFICATION }),
      correlatedToolResult("toolu_a1", OPERATOR_ROUTED_RESULT),
      // A second routed ask whose `question` is NOT a string. The earlier
      // implementation `continue`d before assigning the count, so this turn
      // reported 0 channels despite having consulted two.
      correlatedToolUse("toolu_a2", ASKS_CREATE_TOOL, { question: 42 }),
      correlatedToolResult("toolu_a2", OPERATOR_ROUTED_RESULT),
    ];

    const summary = summarizeAskJustificationEvaluation(twoAsks);
    expect(summary.operatorRoutedAsks).toBe(2);
    expect(summary.distinctChannels).toBe(2);
  });

  test("AT6: surface E gets its OWN directive, not the probe one", () => {
    const reminder = buildReminder([
      { surface: ASK_JUSTIFICATION, matchedPhrase: "no OpenAI key", context: ANCHOR_JUSTIFICATION },
    ]);
    expect(reminder).toContain("ONE channel supports");
    // The generic directive tells the agent to run a capability probe. On this
    // surface it HAD run one — handing it that line invites reading a true
    // positive as a false one (`guard-feedback-authoring.mdc §The directive has
    // to fit the shape of the fire`).
    expect(reminder).not.toContain(PROBE_DIRECTIVE);
    expect(reminder).not.toContain("simpler shape");
  });

  test("AT6b: the anchor turn does not double-report across surfaces", () => {
    const turn = askTurn({});
    // The claim lives in the ask INPUT, not the assistant prose, so the prose
    // surfaces see nothing — one incident, one record, which is the
    // non-duplication property the A-vs-mt#2303 boundary test pins for the
    // other direction.
    expect(detectCapabilityDeferral(turn)).toEqual([]);
    expect(detectPermissionDeferral(turn)).toEqual([]);
    expect(detectDenialAnchoredDeferral(turn)).toEqual([]);
    expect(detectAskJustificationAbsence(turn)).toHaveLength(1);
  });

  test("run() actually reports surface E — the wiring, not just the detector", () => {
    // Every other test in this block calls `detectAskJustificationAbsence`
    // directly, so deleting the surface from `run()`'s match list would leave
    // them ALL green — the mt#3270 R1 shape this file's own comment warns
    // about. This is the test that fails when the wiring goes.
    const outcome = run(
      { session_id: "s-e", transcript_path: FIXTURE_PATH } as ClaudeHookInput,
      ctxWith([userPrompt("run the replay corpus"), ...askTurn({}), userPrompt("next")])
    );
    const matches = outcome?.calibration?.["matches"] as Array<Record<string, unknown>> | undefined;
    expect(matches?.some((m) => m["category"] === ASK_JUSTIFICATION)).toBe(true);
  });

  test("the calibration record keeps the shared matches shape", () => {
    const matches = detectAskJustificationAbsence(askTurn({}));
    const record = buildCalibrationRecord("sess-1", matches);
    const entries = record["matches"] as Array<Record<string, unknown>>;

    expect(entries[0]).toEqual({
      category: ASK_JUSTIFICATION,
      phrase: matches[0]?.matchedPhrase,
      context: matches[0]?.context,
    });
    // `secondChannel` is advisory-only and must not leak into the record — the
    // sweep parser reads this family without a per-detector branch.
    expect(entries[0]).not.toHaveProperty("secondChannel");
    const parsed = [record].map(
      (r) => JSON.parse(JSON.stringify(r)) as Parameters<typeof extractDistinctPhrases>[0][number]
    );
    expect(extractDistinctPhrases(parsed).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mt#3865 — the tune. Every fixture below is the VERBATIM `context` string from
// `.minsky/operator-deferral-calibration.jsonl`, at the timestamp named in the
// case label, except where a case says otherwise and explains why.
// ---------------------------------------------------------------------------

/**
 * AT1 — must not fire. Each entry is a rated FALSE POSITIVE from one of the
 * three calibration windows, with the cause it belongs to.
 */
const TUNE_FALSE_POSITIVES: ReadonlyArray<readonly [string, string]> = [
  [
    "Cause A / 2026-08-10T10:32 — a prohibition, not a request",
    "Then — no needed. Don't paste the token into this chat; I don't need to see it.",
  ],
  ["Cause A / 2026-08-10T10:35 — the same, in a bulleted list", "- **Don't paste the token here."],
  [
    "Cause C / 2026-08-10T15:18 — names a standing instruction AND asks in the same message",
    "I'm not spawning it; your setup says not to call the Agent tool unless you ask. " +
      "Flagging it because there's no third auto-resume: say the word and I'll redispatch " +
      "the prepared continuation prompt.",
  ],
  [
    "SC7 / 2026-08-11T22:40 — declines to START new work, on the turn's own budget",
    "I'm stopping here for a plain reason rather than a scope one: this turn has run long " +
      "enough that I'd rather start that investigation with fresh context than tail-end it. " +
      "Say the word and I'll pick up either.",
  ],
  [
    "SC7 / 2026-08-12T03:18 — declines to START new work, to avoid derailing a live process",
    "Not planning mt#4025 further right now — the research planner is still running and I'd " +
      "rather not derail it. Say the word and I'll walk it after.",
  ],
  [
    "Class C / 2026-08-12T03:25 — reserved category named in the PRECEDING sentence",
    "Both are standing-default changes, so I'm not making them unilaterally. Want me to pick " +
      "mt#3711 back up, and file the channel-awareness gap separately?",
  ],
];

/**
 * AT2 — must still fire. Every rated REAL POSITIVE whose context survives in
 * the log, verbatim. This half is the load-bearing one: a suppression that
 * quietly takes a real positive with it is a worse outcome than the false
 * positives being tuned away, because the miss leaves no trace anywhere.
 */
const TUNE_REAL_POSITIVES: ReadonlyArray<readonly [string, string]> = [
  [
    "2026-08-05T23:22 — an in-authority refactor",
    "Worth noting the same argument applies to any other command whose body is pure side " +
      "effect. Want me to convert it?",
  ],
  [
    "2026-08-06T18:52 — a PR the agent could open",
    "It stopped without opening a PR, so the work is committed but parked on its branch. Say " +
      "the word and I'll open the PR for it, or leave it for whoever owns that thread.",
  ],
  [
    "2026-08-08T08:24 — carries a `since` REASON and is still a real deferral",
    "I'd fold this into one task — collapse per-message chrome into per-run, actor labels " +
      "instead of role labels, elapsed instead of absolute time, and read/write visual " +
      "weighting — since they're all the same underlying fix. Want me to file it?",
  ],
  [
    "2026-08-09T00:06 — file-it-yourself under decision-defaults",
    "It's documented in the workflow header, and mt#3616 just went DONE, so **nothing open " +
      "tracks it** — my search turned up no task. Say the word and I'll file one; I didn't " +
      "want to mint a task you may prefer to just do.",
  ],
  [
    "2026-08-09T00:07 — a verification the probe rule says to just run",
    "Both are quick to verify and both bear on the design. Say the word and I'll check them.",
  ],
  [
    "2026-08-10T15:36 — recovering the agent's own uncommitted work",
    "Flagging rather than filing an ask, since you're in this conversation: the risk is 10 " +
      "files of staged work in session that no commit covers. Say the word if you want me to " +
      "recover it.",
  ],
  [
    "2026-08-11T22:48 — messaging a peer agent, which the agent can do",
    "No recovery attempt was consumed and I've taken no action. Confirming that peer is " +
      "genuinely done is yours to make — I can message it if you'd like.",
  ],
  [
    "2026-08-11T23:37 — a check the agent can re-run",
    "Merged (verified-1a) — deployed: unverified. Say the word and I'll re-run that check.",
  ],
  [
    "2026-08-12T01:31 — both halves are file-it-yourself",
    "Want me to patch the memory and open that task?",
  ],
];

describe("mt#3865 — false positives the tune removes (AT1)", () => {
  test.each(TUNE_FALSE_POSITIVES)(STAYS_SILENT, (_label, prose) => {
    expect(detectCapabilityDeferral([assistantText(prose)])).toEqual([]);
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });

  test("Class B — a deferral ATTRIBUTED to a document is not one being made", () => {
    // RECONSTRUCTED, not verbatim, and the reason is the defect mt#3649 owns:
    // the stored context for 2026-08-08T21:40 is capped at 240 chars and ends
    // mid-word at "the ADR's auth section told rea", BEFORE the matched phrase
    // `paste a bearer token`. Nothing can be replayed from that. The clause is
    // reconstructed from the visible prefix; the reported-speech frame it turns
    // on is fully visible in the record.
    const prose =
      "I fixed a blocking security finding in it along the way: the ADR's auth section told " +
      "readers to paste a bearer token into the chat.";
    expect(detectCapabilityDeferral([assistantText(prose)])).toEqual([]);
  });

  test("Class B — an ENUMERATED open question describes an RFC's structure", () => {
    const prose =
      "The prefilter question is deferred to the principal as open question (b); the RFC " +
      "should provide the option set rather than pick one.";
    expect(detectCapabilityDeferral([assistantText(prose)])).toEqual([]);
  });
});

describe("mt#3865 — real positives the tune must preserve (AT2)", () => {
  test.each(TUNE_REAL_POSITIVES)("still fires: %s", (_label, prose) => {
    const matches = [
      ...detectCapabilityDeferral([assistantText(prose)]),
      ...detectPermissionDeferral([assistantText(prose)]),
    ];
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("mt#3865 — the negation guard is bounded (AT1 controls)", () => {
  test("an UNNEGATED DEFERRAL for the same secret still fires", () => {
    // Was posed on "Paste the token into this chat so I can use it." — a
    // DEPOSIT verb, which mt#2428 carved to `secret-request-in-chat-detector`
    // (the assertion moved there as AT1). Re-posed on the deferral shape this
    // surface still owns, so mt#3865's actual control — that the negation guard
    // does not swallow the unnegated case — keeps a subject here.
    const matches = detectCapabilityDeferral([
      assistantText("I cannot proceed until you provide the token."),
    ]);
    expect(matches).toHaveLength(1);
  });

  test("this surface covers exactly the cells mt#2428 left it (PR #3315 R1)", () => {
    // The other half of the no-hole property; its twin lives in
    // `packages/domain/src/detectors/secret-request-in-chat.test.ts` and pins
    // the same six cells as the ones IT does not claim. Both must hold, or the
    // carve has either a hole or an overlap — the two silent ways it can fail.
    //
    // R1 was exactly the hole: narrowing this pattern to `provide` alone left
    // "give the token" and "share the token" matched by nothing.
    const residual = [
      "give a auth token",
      "give the auth token",
      "provide a auth token",
      "provide the auth token",
      "share a auth token",
      "share the auth token",
    ];
    for (const phrase of residual) {
      const sentence = `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
      expect(
        detectCapabilityDeferral([assistantText(sentence)]).length,
        `no detector owns "${phrase}"`
      ).toBeGreaterThan(0);
    }
  });

  test("and does NOT also claim the cells that moved (no double-count)", () => {
    // The overlap direction. These are the sibling's; if this surface matched
    // them too, one sentence would fire twice and inflate both calibration logs.
    for (const phrase of [
      "Give me the auth token.",
      "Paste the auth token.",
      "Paste your auth token.",
      "Share your auth token.",
    ]) {
      expect(
        detectCapabilityDeferral([assistantText(phrase)]).length,
        `"${phrase}" double-fires`
      ).toBe(0);
    }
  });

  test("the deposit-verb form is no longer this detector's (carve to mt#2428)", () => {
    // The sentence the test above used to carry. Pinned so re-adding the
    // pattern here — which would double-count every fire across two
    // calibration logs — fails loudly.
    expect(
      detectCapabilityDeferral([assistantText("Paste the token into this chat so I can use it.")])
    ).toHaveLength(0);
  });

  test("a negated CAPABILITY claim is not a prohibition — 'will not be able to' still fires", () => {
    // `not` alone is deliberately absent from NEGATION_LEAD_PATTERN: this
    // sentence IS the deferral the surface exists to catch, and a bare-`not`
    // pattern would swallow it.
    const matches = detectCapabilityDeferral([
      assistantText("I will not be able to proceed until you provide the token."),
    ]);
    expect(matches).toHaveLength(1);
  });

  test("a prohibition does not hide a REAL deferral elsewhere in the turn", () => {
    // The suppressed match continues to the next pattern rather than returning.
    const matches = detectCapabilityDeferral([
      assistantText(`Don't paste the token here.\nSeparately, this ${RAILWAY_ACCESS}.`),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedPhrase).toContain(RAILWAY_ACCESS);
  });
});

describe("mt#3865 — the widened window does not widen the destructive half (AT5)", () => {
  test("a reserved category in the PRECEDING sentence now suppresses", () => {
    const prose = "That would set a durable default for every later turn. Want me to apply it?";
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });

  test("'production' in the PRECEDING sentence does NOT suppress an unrelated ask", () => {
    // The over-suppression the widening risks. The destructive half stays
    // sentence-scoped precisely so this keeps firing; widening it to the lead
    // sentence would make an incidental mention of prod mask a real ask.
    const prose = "The production logs were clean when I checked. Want me to commit the changelog?";
    expect(detectPermissionDeferral([assistantText(prose)])).toHaveLength(1);
  });

  test("'production' in the MATCH sentence still suppresses", () => {
    const prose = "The changelog is drafted. Want me to deploy it to production?";
    expect(detectPermissionDeferral([assistantText(prose)])).toEqual([]);
  });
});

describe("mt#3865 — rule-discussion suppression is a REGRESSION PIN, not new (AT3)", () => {
  // This behaviour shipped in mt#3273, two weeks before the spec section that
  // asked for it as a fix. Pinned here so a future elision change cannot
  // silently undo it — and labelled, because a test that passed before the
  // change is evidence of nothing unless it says so.
  const RULE_QUOTATION =
    'ty-deferral prose ("requires Railway access") when the turn shows no probe; ' +
    "Surface B catches the same";

  test("the quoted rule text does not fire", () => {
    expect(detectCapabilityDeferral([assistantText(RULE_QUOTATION)])).toEqual([]);
  });

  test("the same phrase UNQUOTED does fire — the control that makes the pin meaningful", () => {
    expect(
      detectCapabilityDeferral([assistantText("This requires Railway access, so it's on you.")])
    ).toHaveLength(1);
  });

  test("a suppressed turn still produces an evaluation record", () => {
    const record = buildEvaluationRecord("s-3865", [], RULE_QUOTATION);
    expect(record["fired"]).toBe(false);
    expect(record["session_id"]).toBe("s-3865");
    // The half a fire-only log cannot give: the scanned text is retained, so a
    // suppression can be re-rated later as a miss if it turns out to be one.
    expect(record["text_tail"]).toContain(RAILWAY_ACCESS);
  });
});

// ---------------------------------------------------------------------------
// Surface F — act-path improvised workaround (mt#4081)
// ---------------------------------------------------------------------------

/**
 * The 2026-08-13 turn, reduced to its shape: one channel probed, a no-op read as
 * a capability absence, then a mass kill — and no capability search anywhere in
 * the turn. Surface E evaluated this turn and scored `fired: false`
 * (`absenceClaimPresent: false`), which is what this surface exists to catch.
 */
function actPathTurn(
  options: { search?: { name: string }; command?: string } = {}
): TranscriptLine[] {
  const { search, command = "kill 544 654 818 88112 966 1106" } = options;
  const lines: TranscriptLine[] = [
    correlatedToolUse("toolu_probe", "Bash", {
      command: "osascript -e 'tell application \"iTerm2\" to move tab 1 of window 1'",
    }),
    correlatedToolResult("toolu_probe", "MOVE OK"),
  ];
  if (search) {
    lines.push(correlatedToolUse("toolu_search", search.name, { query: "iterm2 move tab" }));
    lines.push(correlatedToolResult("toolu_search", "async_set_tabs"));
  }
  lines.push(correlatedToolUse("toolu_kill", "Bash", { command }));
  lines.push(correlatedToolResult("toolu_kill", ""));
  return lines;
}

describe("surface F — act-path improvised workaround (mt#4081)", () => {
  test("AT3: the 2026-08-13 turn fires, without needing an absence-claim phrase", () => {
    const matches = detectActPathWorkaround(actPathTurn());

    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe("act-path-workaround");
    // The trigger is tool-call state — nothing in this turn's prose was read.
    expect(matches[0]?.matchedPhrase).toBe("kill");
  });

  test("AT4: the same turn with a WebSearch in it does not fire", () => {
    expect(detectActPathWorkaround(actPathTurn({ search: { name: "WebSearch" } }))).toHaveLength(0);
  });

  test("a Skill load counts as a capability search", () => {
    expect(detectActPathWorkaround(actPathTurn({ search: { name: "Skill" } }))).toHaveLength(0);
  });

  test("a turn with no destructive action does not fire", () => {
    const lines = [
      correlatedToolUse("toolu_ls", "Bash", { command: "ls -la" }),
      correlatedToolResult("toolu_ls", ""),
    ];
    expect(detectActPathWorkaround(lines)).toHaveLength(0);
  });

  test("the diversity axis is the verb, not the PID list", () => {
    const a = detectActPathWorkaround(actPathTurn({ command: "kill 1 2 3" }));
    const b = detectActPathWorkaround(actPathTurn({ command: "kill 9 8 7" }));
    expect(a[0]?.matchedPhrase).toBe("kill");
    expect(b[0]?.matchedPhrase).toBe("kill");
  });

  test("hasCapabilitySearch is true for WebFetch", () => {
    expect(
      hasCapabilitySearch([correlatedToolUse("toolu_wf", "WebFetch", { url: "https://x" })])
    ).toBe(true);
  });
});

describe("surface F — parse robustness (PR #2954 R1)", () => {
  test("a kill verb quoted inside a commit message is not a destructive action", () => {
    const lines = [
      correlatedToolUse("toolu_c", "Bash", {
        command: "git commit -m 'fix: kill the retry loop'",
      }),
      correlatedToolResult("toolu_c", ""),
    ];
    expect(detectActPathWorkaround(lines)).toHaveLength(0);
    expect(isDestructiveCommand("git commit -m 'fix: kill the retry loop'")).toBe(false);
  });

  test("a real kill still reads as destructive, path-qualified or not", () => {
    expect(isDestructiveCommand("kill 111 222 333")).toBe(true);
    expect(isDestructiveCommand("/bin/kill 111")).toBe(true);
    expect(isDestructiveCommand("echo done && killall node")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mt#4111 — surface F precision: the five live fires, and what the record says
// ---------------------------------------------------------------------------

/** A turn that runs `command` and nothing else — no capability search, no denial. */
const killTurn = (command: string): TranscriptLine[] => [
  bashCall("toolu_k", command),
  toolResult(""),
];

/**
 * The four NON-denied `act-path-workaround` fires in
 * `.minsky/operator-deferral-calibration.jsonl` between 2026-08-14 and
 * 2026-08-17, verbatim where the record preserved the command and completed
 * (`kill $SRV`) where the 240-char context truncated it. Every one is a
 * single-target kill of a process the same session was managing.
 */
const RECORDED_SINGLE_TARGET_CLEANUPS: ReadonlyArray<readonly [string, string]> = [
  [
    "2026-08-14T02:21 — a port allocator, then the server it started",
    `PORT=$(bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port)'); echo "port=$PORT"; kill $SRV`,
  ],
  [
    "2026-08-14T03:36 — a scratch MCP server the same session spawned",
    `kill 56286 && echo "scratch MCP server stopped"; sleep 1; lsof -ti :3798 2>/dev/null | head -1`,
  ],
  [
    "2026-08-16T21:05 — a backgrounded dev server, killed by job variable",
    `nohup bun run src/cli.ts mcp start --http --port=39322 > /tmp/boot2.log 2>&1 & SRV=$!; sleep 2; kill $SRV`,
  ],
  [
    "2026-08-17T00:39 — a port-holder located by lsof in the same command",
    `PID=$(lsof -nP -iTCP:3737 -sTCP:LISTEN -t 2>/dev/null | head -1); echo "killing $PID"; kill "$PID" 2>&1; sleep 12`,
  ],
];

describe("mt#4111 — a denied invocation is the guard working, not a workaround (SC1)", () => {
  const BULK = "kill 999991 999992 999993";

  test("AT1: the 2026-08-13 guard-verification exercise no longer records", () => {
    expect(
      detectActPathWorkaround([bashCall("toolu_bulk", BULK), denialResult("toolu_bulk")])
    ).toHaveLength(0);
  });

  test("AT2: the SAME command, not denied, still records", () => {
    const matches = detectActPathWorkaround(killTurn(BULK));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedPhrase).toBe("kill");
  });

  test("PR #3051 R1: a denial followed by an identical PERMITTED retry still records", () => {
    // The ordinary override shape. A text-keyed filter drops the retry too,
    // which suppresses the one execution this surface exists to see.
    const matches = detectActPathWorkaround([
      bashCall("toolu_denied", BULK),
      denialResult("toolu_denied"),
      bashCall("toolu_retry", BULK),
      toolResult(""),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedPhrase).toBe("kill");
  });

  test("PR #3051 R1: a LATER denial does not retire an EARLIER identical execution", () => {
    const matches = detectActPathWorkaround([
      bashCall("toolu_ran", BULK),
      toolResult(""),
      bashCall("toolu_denied", BULK),
      denialResult("toolu_denied"),
    ]);
    expect(matches).toHaveLength(1);
  });
});

describe("mt#4111 — single-target cleanup is not a workaround (SC9)", () => {
  test.each(RECORDED_SINGLE_TARGET_CLEANUPS)(STAYS_SILENT, (_label, command) => {
    expect(detectActPathWorkaround(killTurn(command))).toHaveLength(0);
    expect(findReportableKill(command)).toBeNull();
  });

  test("the residue the bulk guard lets through still fires", () => {
    // Two PIDs sit below `block-bulk-process-kill`'s BULK_PID_THRESHOLD of 3,
    // so nothing denies this — which is exactly the population this surface
    // owns after the tune.
    expect(detectActPathWorkaround(killTurn("kill 4821 4822"))).toHaveLength(1);
    // `pkill`/`killall` are mass by construction; `minsky-mcp` is not on the
    // guard's interactive-class list, so it is not denied either.
    expect(detectActPathWorkaround(killTurn("pkill -f minsky-mcp"))).toHaveLength(1);
    expect(REPORTABLE_KILL_MIN_TARGETS).toBe(2);
  });

  test("a liveness probe is not a kill", () => {
    expect(detectActPathWorkaround(killTurn("kill -0 4821 4822"))).toHaveLength(0);
  });

  test.each([
    ["separated, stdout", "kill 4821 > /dev/null"],
    ["separated, stderr", "kill 4821 2> /dev/null"],
    ["attached", "kill 4821 >/dev/null 2>&1"],
  ])("mt#4193: a redirect does not make a one-PID cleanup reportable: %s", (_label, command) => {
    // The over-count half of mt#4193's tokenization defect: the redirect PATH was read as a
    // second target, so the cardinality leg saw a multi-target kill.
    expect(detectActPathWorkaround(killTurn(command))).toHaveLength(0);
  });
});

describe("mt#4111 — the record names its own cause (SC6, SC7)", () => {
  /** Compound commands whose FIRST token is not the verb — the three misrecorded fires. */
  const COMPOUND_FIRES: ReadonlyArray<readonly [string, string]> = [
    ["leading token `-nP`", `PID=$(lsof -nP -iTCP:3737 -t | head -1); kill "$PID" "$OTHER"`],
    ["leading token `-e`", `PORT=$(bun -e 'x'); kill 4821 4822`],
    ["leading token `nohup`", `nohup bun run serve & SRV=$!; kill 4821 4822`],
  ];

  test.each(COMPOUND_FIRES)("SC6: the phrase is the verb, not the command's %s", (_l, command) => {
    const matches = detectActPathWorkaround(killTurn(command));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedPhrase).toBe("kill");
  });

  test.each(COMPOUND_FIRES)("SC7: the context replays to the same verb (%s)", (_l, command) => {
    const match = detectActPathWorkaround(killTurn(command))[0];
    expect(match).toBeDefined();
    expect(findKillVerb(match?.context ?? "")).toBe(match?.matchedPhrase ?? null);
  });

  test("the diversity axis counts one pattern once across all three", () => {
    const phrases = COMPOUND_FIRES.map(
      ([, command]) => detectActPathWorkaround(killTurn(command))[0]?.matchedPhrase
    );
    expect(new Set(phrases).size).toBe(1);
  });

  test("the context leads with the matching segment, then the command it sat in", () => {
    const context = buildKillContext(`echo hi; kill 1 2`, `kill 1 2`);
    expect(context.startsWith("kill 1 2")).toBe(true);
    expect(context).toContain("echo hi");
  });

  test("a single-segment command is not annotated with itself", () => {
    expect(buildKillContext("kill 1 2", "kill 1 2")).toBe("kill 1 2");
  });
});

// ---------------------------------------------------------------------------
// mt#4111 — prose suppressions (SC2, SC3, SC8) and the new peer-collision class
// ---------------------------------------------------------------------------

/** Each entry is a rated FALSE POSITIVE from mt#4111's three review windows. */
const WINDOW_FALSE_POSITIVES: ReadonlyArray<readonly [string, string]> = [
  [
    "shape 1 / SC3 — the principal already instructed the stop, and the ask accompanies it",
    "Filed only, not planned — you said file. mt#4028 is small enough to plan in one pass; " +
      "say the word and I'll take it to READY.",
  ],
  [
    "shape 2 / SC2 — the deferred item is a durable default, stated as a consequence",
    "Say the word and I'll write the setting so it's ready for your next restart.",
  ],
  [
    "window 3 — surfacing an actor collision, which the corpus requires",
    "There's a second agent on this task. Answer that ask rather than a new one from me; " +
      "want me to reconcile the two threads first?",
  ],
];

describe("mt#4111 — prose false positives the tune removes", () => {
  test.each(WINDOW_FALSE_POSITIVES)(STAYS_SILENT, (_label, prose) => {
    expect(detectPermissionDeferral([assistantText(prose)])).toHaveLength(0);
  });

  test("SC8: a copular denial of a deferral does not read as one", () => {
    const prose =
      "mt#4124 isn't deferred to you; I just can't walk two at once — I'll take it after.";
    expect(detectCapabilityDeferral([assistantText(prose)])).toHaveLength(0);
  });
});

describe("mt#4111 — the negative control: neighbouring real positives still fire", () => {
  test("SC8: a bare `not` still does not swallow a capability deferral", () => {
    const matches = detectCapabilityDeferral([
      assistantText("I will not be able to provide the token myself."),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.surface).toBe(CAPABILITY_PROSE);
  });

  test("a deferral whose `not available` is the match itself still fires", () => {
    expect(
      detectCapabilityDeferral([assistantText("That is not available from agent context.")])
    ).toHaveLength(1);
  });

  test("SC2: a one-off setting change is the agent's, and still fires", () => {
    expect(
      detectPermissionDeferral([
        assistantText("Say the word and I'll flip the flag for this run only."),
      ])
    ).toHaveLength(1);
  });

  test("SC4: reporting what the principal asked ABOUT is not a standing instruction", () => {
    // Caught by the replay over the live log during implementation: the first
    // draft of the direct-reference pattern matched `you asked` bare and
    // suppressed this rated REAL positive from window 3.
    expect(
      detectPermissionDeferral([
        assistantText(
          "That's the spot where a second opinion would actually bite. Say the word and I'll " +
            "dispatch one against the draft; I haven't, since you asked whether it was " +
            "worthwhile rather than for it."
        ),
      ])
    ).toHaveLength(1);
  });

  test("SC3: citing the principal does NOT suppress without an instruction reference", () => {
    expect(
      detectPermissionDeferral([
        assistantText("The spec is thin on the migration path. Want me to fill it in?"),
      ])
    ).toHaveLength(1);
  });
});
