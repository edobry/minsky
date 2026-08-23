// Registry entries for the delegation guard family (mt#2292, mt#2459).
//
// ## The family boundary
//
// Both guards fire at the moment the agent hands work OUTWARD rather than doing
// it — to a subagent (`Agent`) or to the principal (`AskUserQuestion`). That
// shared seam is the family: a delegation is being recorded or inspected as it
// happens, which is the only point at which the handoff's shape is still
// visible.
//
//   - `record-agent-dispatch` — writes the pending `subagent_invocations` row
//     on the RAW spawn path and stamps the parent key into the prompt. Never
//     denies; it is a recorder.
//   - `operator-deferral-ask-surface` — the `AskUserQuestion` surface of the
//     operator-deferral detector: an ACTION deferred to the principal in an
//     option label, with no same-turn capability probe.
//
// The two register on DIFFERENT matchers and so can never co-fire on one tool
// call; their order relative to each other is inert. They are filed together
// because the seam is one seam, not because the matcher is one matcher — the
// same widening `registry-pr-create-guards.ts` recorded for itself in mt#4044.
//
// ## Why a family module
//
// See `registry-task-create-guards.ts`'s header for the `max-lines` history
// this split resolves (mt#4115).

import { ADVISORY_POSTURE, recorderEffect, mutatorEffect } from "./registry-effects";
import type { GuardRegistration } from "./registry";

export const DELEGATION_GUARDS: readonly GuardRegistration[] = [
  {
    name: "record-agent-dispatch",
    effects: [
      mutatorEffect(
        "updatedInput",
        ADVISORY_POSTURE,
        'computed purely from the payload with no DB dependency; must never be lost since the prompt is already sent — see this guard\'s own header comment ("the cheap, irreversible half must not be gated on the expensive, recoverable one").'
      ),
      recorderEffect(
        "calibration",
        "the dispatch-row write; recoverable via the Stop-side reconciliation if lost, so it can spool independently of the updatedInput stamp above."
      ),
    ],
    // `invariant`: this guard has no threshold to tune. It writes an
    // observability row and stamps a correlation key — behavior an operator
    // turns off (the override env var) rather than adjusts.
    tuningOwnership: "invariant",
    event: "PreToolUse",
    matcher: "Agent",
    module: () => import("./record-agent-dispatch").then((m) => ({ run: m.run })),
    // MUST stay above the module's DISPATCH_RECORD_TIMEOUT_MS (10s) so the
    // guard's OWN deadline fires first: that path returns the stamp plus a
    // recorded `write-failed` outcome, whereas a dispatcher kill loses the STAMP
    // as well as the row — and the stamp is the unrecoverable half, since the
    // prompt is sent either way. 13s keeps margin under the dispatcher's
    // DERIVED (mt#3981, absorbing mt#3675) settings.json entry cap for this
    // matcher — see `.minsky/hooks/dispatch-timeout-budget.ts`.
    timeoutMs: 13000,
    calibrationLog: "agent-dispatch-record",
    // NEVER denies. An observability writer must not be able to block a
    // dispatch — that would trade the failure this task fixes for a worse one.
    denyCapable: false,
    // This guard emits no agent-facing `additionalContext` at all: its outputs
    // are `updatedInput` (consumed by the harness) and `auditLines` (stderr, for
    // an operator reading a failure). So the attention cost is the audit line's
    // size, not a denial message's — measured against the longest of the three,
    // the write-failure line carrying an interpolated error message.
    attentionCost: { denialMessageSizeChars: 300, optionCount: 0 },
    // Canaried on `updatedInput`, not `calibration`: the stamp is this guard's
    // load-bearing output and the one whose loss is unrecoverable. `CANARY_MODE`
    // short-circuits the DB write in the module, so this exercises the pure
    // stamp path without reaching a live corpus (the mt#3824 lesson).
    canary: {
      input: {
        tool_name: "Agent",
        tool_use_id: "toolu_01CanaryAgentDispatch",
        tool_input: {
          description: "canary dispatch",
          prompt: "Do the thing.",
          subagent_type: "general-purpose",
        },
      },
      expects: "updatedInput",
    },
    // No `worstCaseCanary`, and the reason is a constraint rather than a
    // deferral: the only growth-shaped output is the write-failure audit line,
    // which interpolates a caught driver error — and canary mode short-circuits
    // BEFORE the write, so no canary can reach that branch to pose it. The
    // registry's stated preference applies instead: the guard CAPS the
    // interpolated message itself (`safeTruncate`, see AUDIT_ERROR_MAX_CHARS),
    // so the line is bounded by construction and the annotation above is a true
    // ceiling rather than a sample.
  },
  {
    name: "operator-deferral-ask-surface",
    effects: [recorderEffect()],
    tuningOwnership: "advisory",
    event: "PreToolUse",
    matcher: "AskUserQuestion",
    module: () => import("./operator-deferral-detector").then((m) => ({ run: m.runAskSurface })),
    // Same module, same renderer, same injection gate — so the same probe. It
    // OVER-poses this surface (three matches where the ask surface returns one),
    // which is the safe direction for a ceiling.
    renderProbe: () => import("./operator-deferral-detector").then((m) => m.renderWorstCase()),
    timeoutMs: 10000,
    calibrationLog: "operator-deferral",
    denyCapable: false,
    needsTranscript: true,
    // Matches its sibling registration: same module, same renderer, so the same
    // measured 2068 (mt#4002, re-measured mt#3999). It was left at 600 when
    // mt#3533 corrected the sibling — the two registrations render identical text
    // and only one was fixed, which the sweep caught. Kept in step deliberately:
    // this surface never returns an `ask-justification` match, so the shared
    // probe OVER-poses it, which is the safe direction for a ceiling.
    attentionCost: { denialMessageSizeChars: 2100, optionCount: 1 },
    canary: {
      input: {
        transcript_path: "mt2889-canary-transcript",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "The reviewer service is CRASHED. How should we proceed?",
              options: [{ label: "You recover the reviewer service" }],
            },
          ],
        },
      },
      transcriptLines: [{ type: "user", message: { role: "user", content: "first turn" } }],
      expects: "calibration",
    },
  },
];
