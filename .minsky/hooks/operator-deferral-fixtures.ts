/**
 * Shared fixtures for the operator-deferral detector's test files.
 *
 * Extracted when `operator-deferral-detector.test.ts` crossed the 1500-line
 * `max-lines` ERROR ceiling: merging mt#4702 with main's mt#4769 artifact-body
 * surface put two wanted test sets in one file, and neither should be trimmed
 * to fit.
 *
 * A PLAIN module rather than re-exports from the parent test file. Importing a
 * `.test.ts` re-registers every test it declares into the importing file's run,
 * so the parent's ~194 tests would execute a second time — measured at 201 tests
 * in a file that declares 7. The repo has two files that import a single helper
 * that way (`code-mechanism-assertion-identity.test.ts`,
 * `hook-module-inventory.test.ts`); it is tolerable for one function and not for
 * a fixture set.
 *
 * `askTurn` especially must have exactly ONE definition: it encodes ask#6754
 * verbatim, and a divergent copy would silently weaken whichever file held it.
 *
 * The `as unknown as TranscriptLine` casts below moved here UNCHANGED from the
 * test file. `custom/no-excessive-as-unknown` sets `allowInTests: true`, but its
 * file test is `/\.(test|spec)\.ts$/` — a test-SUPPORT module is not matched,
 * so casts that were exempt in their old home become warnings in their new one
 * against a zero-warning gate. Disabled file-wide rather than per-site: the
 * exemption is a property of the whole file, and seven inline directives would
 * read as seven separate judgments. Widening the rule's own detection to cover
 * test-support modules is mt#4850 — the durable fix, not this one.
 */
/* eslint-disable custom/no-excessive-as-unknown */
import type { TranscriptLine } from "./transcript";
import type { DispatchContext } from "./registry";

export const FIXTURE_PATH = "/tmp/fixture.jsonl";

/** The capability-deferral phrase behind this detector's first live fire. */
export const RAILWAY_ACCESS = "requires Railway access";
export const DEFERRAL_PROSE = `Deferred to operator: ${RAILWAY_ACCESS}.`;

export const ASK_OPTION_LABEL = "ask-option-label";

export const R5_LABEL = "You recover the reviewer service";

export const userPrompt = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
});

export const assistantText = (text: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

export const ctxWith = (lines: TranscriptLine[]): DispatchContext =>
  ({
    event: "UserPromptSubmit",
    hostCapSec: 60,
    budgets: { overallMs: 60000, fetchMs: 20000, gitMs: 20000 },
    transcriptCandidates: [FIXTURE_PATH],
    transcriptLines: lines,
  }) as unknown as DispatchContext;

export const CREDENTIALS_LIST_TOOL = "mcp__minsky__config_credentials_list";

/** The tool whose payload carries an ask justification. */
export const ASKS_CREATE_TOOL = "mcp__minsky__asks_create";

/**
 * ask#6754's claim, verbatim in substance (mt#3547, 2026-08-01): the agent read
 * ONE channel, the credential store, which returned exit-0 JSON that silently
 * omitted the provider — and then asked the operator to authorize pulling a
 * PRODUCTION credential off Railway on that premise.
 */
export const ANCHOR_JUSTIFICATION =
  "I have no OpenAI key — the credential store has Anthropic and Google, not OpenAI. May I " +
  "pull the production key off Railway so the replay corpus can run?";

export const OPERATOR_ROUTED_RESULT = JSON.stringify({
  id: "ask-1",
  state: "routed",
  routingTarget: "operator",
  transport: "inbox",
});

export function correlatedToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>
): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  } as unknown as TranscriptLine;
}

export function correlatedToolResult(id: string, content: string): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  } as unknown as TranscriptLine;
}

/** A turn that creates an ask, plus whatever channel calls preceded it. */
export function askTurn(options: {
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

// ---------------------------------------------------------------------------
// mt#5056 — the quoted-as-data window of 2026-09-09
// ---------------------------------------------------------------------------

/**
 * The two false positives a wrapped quotation produced, VERBATIM from the
 * transcripts that produced them (records `2026-09-04T17:48:40.712Z` and
 * `2026-09-04T17:48:56.124Z`).
 *
 * Located by searching the transcripts for the recorded phrase, NOT rebuilt
 * from the calibration log's stored `context` — that field is a 240-character,
 * already-elided window, and it shows both of these quotations as though they
 * were UNTERMINATED. Reading the derived view instead of the source would have
 * produced a fixture for the wrong defect and a fix aimed at end-of-paragraph
 * blanking (mem#1020 on sampling verbatim, mem#1125 §3 on the stored context).
 *
 * Both are ordinary calibration-report bullets: an agent quoting the phrases it
 * is reporting on, wrapped by the repo's ~100-column prose width.
 */
export const WRAPPED_QUOTE_UNLESS = [
  '- `offer-shape:unless` — 4 of 4 false: "I\'ll start there unless you redirect."; "Proceeding with',
  '  that unless you redirect."; "**Defaults I\'ll assume unless you say otherwise:** a 4-week alias',
  '  window …"; "I\'d start with (1) unless you\'d rather go straight at the reviewer alerting."',
].join("\n");

export const WRAPPED_QUOTE_SAY_THE_WORD = [
  '- Gated on an operator token — "Say go and I\'ll plan it" (`ill-action/I\'ll plan it`); "Say the word',
  "  and I'll write it up as a task\"; \"say the word and I'll take it\" (×2); \"Then say 'go' and I'll",
  "  take it through PR and merge\"; \"say 'continue' and I'll take mt#4842\"; \"Say the word and I'll",
  '  draft it".',
].join("\n");

/**
 * Branch B — prose ABOUT a deferral, carrying no quotation at all. Also verbatim
 * from source. These are EXPECTED to keep firing: no quotation discriminator can
 * reach them at any bound, and mt#3987 (DONE) decided against building the
 * discussion-framing mechanism that could, on measured evidence. Pinned so the
 * carve-out is a tested decision rather than an untested gap.
 */
export const UNQUOTED_DEFERRAL_PROSE: Array<[string, string]> = [
  [
    "a disjunction whose second branch requires a token",
    "This is a sub-shape the list above does not contain,\nand it is the one most likely to be " +
      "read as ungated: a DISJUNCTION whose second branch also requires\nan operator token.",
  ],
  [
    "reporting that a TASK deferred something",
    "**That string is mine, from mt#5027, and this is the acceptance judgment that task deferred " +
      "to the\nprincipal.**",
  ],
];

/**
 * The real positives from the same window (mt#5056 SC2's fire direction). A
 * change that only silences is a regression toward ADR-032's "tuned into
 * permanent silence", so these run on the same pass as the suppressions.
 */
export const OPERATOR_DEFERRAL_TRUE_POSITIVES: Array<[string, string]> = [
  ["a bare build offer", "**Want me to build step 1 now?**"],
  [
    "offering to file a task the agent may file itself",
    "**Actionable:** the inline-lifecycle habit that caused this has no detector. Want me to file it?",
  ],
  [
    "an operator-token gate on the natural continuation",
    "**Next:** mt#5018, the sibling harness fix from the same retrospective, is still TODO — " +
      "that's the natural continuation. Say the word and I'll take it.",
  ],
  [
    "a conditional continuation",
    "If you want me to keep going, the next item is mt#5036 — the two turn-end guards that fire " +
      "on a task being referenced rather than acted on.",
  ],
];
