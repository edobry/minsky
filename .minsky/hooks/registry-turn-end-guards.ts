// Registry entries for the turn-end (`Stop`) guard family (mt#2357 onward).
//
// ## The family boundary
//
// Every guard here registers on the `Stop` event and runs via the
// `dispatch-stop.ts` entrypoint. The seam is the TURN'S CLOSING MESSAGE: the
// last point at which the turn's shape — what it said, what it minted, what it
// left undone — is still inspectable. That is a different question from the
// `UserPromptSubmit` scanners, which see a turn only once the NEXT prompt
// arrives, and it is why the silent stop is visible here and nowhere else:
// `record-turn-anchor` and `turn-end-unwalked-task-scan` key on tool-call
// state, so a turn that ends having said nothing still has something to read.
//
// `record-turn-anchor` is the family's recorder and runs first; the rest are
// scans. None is `denyCapable` — a Stop guard cannot deny a turn that has
// already happened, so every member is advisory or log-only.
//
// ## Order
//
// The array order is the original `registry.ts` order, unchanged. Cross-event
// array position is inert (`getGuardsForEvent` filters by event first), so this
// family's placement among the others carries no behavior; within-family order
// is preserved so the pre/post dispatch snapshot comes out byte-identical.
//
// ## Why a family module
//
// See `registry-task-create-guards.ts`'s header for the `max-lines` history
// this split resolves (mt#4115).

import { advisoryEffect, recorderEffect } from "./registry-effects";
import type { GuardRegistration } from "./registry";

export const TURN_END_GUARDS: readonly GuardRegistration[] = [
  {
    // mt#3490 / ADR-031 — a RECORDER, not a detector. Placed first among the
    // Stop guards so the anchor is durable before any later Stop guard can
    // error; nothing else reads it within this dispatch.
    //
    // No `canary`: `GuardCanary.expects` is `"deny" | "warn" | "calibration" |
    // "sessionTitle"`, and this guard produces NONE of those — it always
    // returns null and its only observable effect is a file write. There is no
    // honest value to declare, so it is omitted deliberately rather than
    // mis-declared to satisfy the shape test (which measures emitted feedback,
    // and so has nothing to measure here). Its behaviour is covered by
    // `record-turn-anchor.test.ts` against an injected store dir instead.
    //
    // `attentionCost` is zero because it emits nothing —
    // `MERGED_CONTEXT_BUDGET_CHARS` is DERIVED from these annotations, so a
    // padded number here would widen the injection budget for every turn in
    // the repo (mem#865).
    name: "record-turn-anchor",
    effects: [
      recorderEffect(
        "turnAnchorWrite",
        "writes the turn-anchor store (ADR-031), not a calibration log — same recorder shape: a local write with no in-turn consumer, read later by the Stop-side resolver via ctx.recordedAnchor."
      ),
    ],
    tuningOwnership: "invariant",
    event: "Stop",
    module: () => import("./record-turn-anchor").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 0, optionCount: 0 },
  },
  {
    // mt#3286 — R3-R6 of the linked-reference-actionability family (mem#623):
    // a turn's closing message hands the operator entities they cannot click.
    // Advisory-only and calibration-first per ADR-024: this is a Rung-1
    // deterministic matcher over SYNTAX (a deeplink has one correct written
    // form), not over prose, so the ladder's paraphrase-driven escalation to
    // Rung 2 does not apply — there is no paraphrase axis for a URL.
    //
    // `attentionCost` mirrors ADVISORY_BUDGET_CHARS in the guard, which bounds
    // the render in code; `guard-feedback-shape.test.ts` asserts the two agree.
    name: "turn-end-bare-ref-scan",
    effects: [
      advisoryEffect(
        "additionalContext",
        "LIVE for the bare-short-id/malformed-target/raw-uuid-label classes; the bare-mt#/PR# class is record-only (mt#3897) — one additionalContext effect covers both since the split is per finding class, not per guard output shape."
      ),
      recorderEffect(),
    ],
    tuningOwnership: "advisory",
    event: "Stop",
    module: () => import("./turn-end-bare-ref-scan").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "bare-entity-ref",
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 700, optionCount: 0 },
    canary: {
      // A bare short id with no link anywhere in the message — the enforced
      // class as of mt#3897. It used to be a bare `mt#`/`PR #` pair; those are
      // record-only now (the display linkifier repairs them), so that input
      // stopped firing and left this guard invisible to the shape test.
      // `transcript_path` is deliberately nonexistent: this guard prefers
      // `last_assistant_message` and must work when the transcript has not yet
      // flushed the final message.
      input: {
        session_id: "mt3286-bare-ref-canary",
        transcript_path: "/nonexistent/mt3286-canary.jsonl",
        last_assistant_message: "Pending your call on ask#1234 and mem#5678.",
      },
      transcriptLines: [],
      expects: "warn",
    },
    // GROWTH-SHAPED (mt#3705): the render emits one line per finding, so the
    // canary above establishes the FLOOR, not the ceiling. This poses the
    // largest input the guard can actually face — a long closing status report
    // enumerating many entities, none linked — so the declared
    // denialMessageSizeChars is measured against a real worst case rather than
    // a comfortable one. The in-code budget fit is what actually bounds it.
    worstCaseCanary: {
      // Re-posed at the mt#3897 flag set. The previous worst case saturated on
      // bare `mt#`/`PR #`, which are record-only now — it would still have
      // returned "warn" (the two malformed links below flag regardless) while
      // measuring only 2 rendered lines instead of 18, quietly understating the
      // budget it exists to bound. Saturates every FLAGGED axis at once: many
      // bare short ids across all three families, plus both malformed classes.
      input: {
        session_id: "mt3286-bare-ref-worst-case",
        transcript_path: "/nonexistent/mt3286-worst.jsonl",
        last_assistant_message:
          "Status: ask#10001 ask#10002 ask#10003 ask#10004 ask#10005 ask#10006 " +
          "mem#10007 mem#10008 mem#10009 mem#10010 mem#10011 mem#10012 " +
          "ws#10013 ws#10014 ws#10015 ws#10016 ws#10017 ws#10018 are pending; " +
          "see [ask#…deadbeef](minsky://ask/1e2d3c4b-5a69-4788-9910-aabbccddeeff) " +
          "and [mem#…cafebabe](minsky://memory/2f3e4d5c-6b7a-4899-8a0b-bbccddeeff00) " +
          "and [ws#42](minsky://session/short).",
      },
      transcriptLines: [],
      expects: "warn",
    },
  },
  {
    name: "turn-end-retro-scan",
    effects: [advisoryEffect(), recorderEffect()],
    tuningOwnership: "preference",
    event: "Stop",
    module: () => import("./turn-end-retro-scan").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "retrospective-trigger",
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 600, optionCount: 2 },
    canary: {
      // The guard reads ctx.transcriptLines (needsTranscript) plus the
      // Stop-specific last_assistant_message; session_id keys the dedup
      // store, which setup clears so the canary is repeatable (an
      // un-cleared store would dedup the SECOND canary run into silence
      // and misreport the guard as broken).
      input: {
        session_id: "mt2357-turn-end-canary",
        transcript_path: "/nonexistent/mt2357-canary.jsonl",
        last_assistant_message: "I made a mistake in the deploy step.",
      },
      transcriptLines: [
        {
          type: "user",
          message: { role: "user", content: "please deploy the service" },
          uuid: "mt2357-canary-prompt",
          timestamp: "2026-07-21T00:00:00.000Z",
        },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Deploying now." }] },
        },
      ],
      expects: "warn",
      setup: async () => {
        const store = await import("./turn-end-scan-store");
        store.clearFlagged("mt2357-turn-end-canary");
      },
    },
  },
  {
    // mt#3179 — turn-end sibling of the guard above: scans for a turn that ends
    // by NAMING a next action without taking it. Keyed on POSITION (the text is
    // in `last_assistant_message`, so nothing followed it), not on the agent's
    // stated reason. Full rationale: the guard module's header.
    name: "turn-end-untaken-action-scan",
    effects: [advisoryEffect(), recorderEffect()],
    tuningOwnership: "preference",
    event: "Stop",
    module: () => import("./turn-end-untaken-action-scan").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    calibrationLog: "untaken-action",
    denyCapable: false,
    // True since mt#4063, for the SUPPRESSION signal only. PR #2293 R1's
    // reasoning for setting this false still holds and is unchanged: detection
    // reads `last_assistant_message`, and the dedup key is derived from that
    // message — NOT from the transcript, whose absent-case default would
    // suppress the phrase session-wide. Both remain message-derived.
    //
    // What the transcript is read for is the armed-watcher suppression, whose
    // absent-case default runs the OTHER way: no transcript means no
    // tool-call evidence, which means no suppression, which means the guard
    // fires exactly as it did before. That asymmetry is what makes the read
    // safe here and is pinned by a test ("with no transcript in context the
    // guard behaves exactly as before"), so the canary below — which carries
    // no `transcriptLines` and expects `warn` — stays valid unchanged.
    //
    // Marginal cost is ~zero: `resolveDispatchContext` resolves the transcript
    // once per dispatch, and the sibling `turn-end-unwalked-task-scan` already
    // requests it on this same Stop event.
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 450, optionCount: 2 },
    canary: {
      input: {
        session_id: "mt3179-untaken-action-canary",
        transcript_path: "/nonexistent/mt3179-canary.jsonl",
        // Verbatim tail of the R3 incident this guard exists to catch.
        last_assistant_message:
          "mt#3179 is incident-response, so I'm taking it forward rather than leaving it filed — that's the next step, not a question.",
      },
      // No transcriptLines: detection reads last_assistant_message only; the
      // dedup turn-key degrades to a stable default without a transcript.
      expects: "warn",
      setup: async () => {
        const store = await import("./turn-end-scan-store");
        store.clearFlagged("mt3179-untaken-action-canary");
      },
    },
    // mt#3767 — the SATURATING input for this guard, on BOTH axes at once:
    // enough commitment families to drive the evidence list to its cap of 3 plus
    // the "…and N more" line, AND a deferral phrase, which selects the longer of
    // the two directive branches. Posing it at only one axis is what hid the
    // overflow: the originating single-match sentence renders 339, this renders
    // 430, and the ceiling is 450. (mem#865 predicted this blind spot for guards
    // whose output varies by input, after mt#3699 hit it on the sibling — and the
    // commitment branch turned out to be over the ceiling at cap ALREADY, which
    // the previous "capped" classification meant nothing ever rendered.)
    worstCaseCanary: {
      input: {
        session_id: "mt3767-untaken-action-worstcase-canary",
        transcript_path: "/nonexistent/mt3767-worstcase-canary.jsonl",
        // mt#3853 re-posed. The previous canary fired MANY families, which
        // reads like saturation and is not: matches emit in PATTERN order, the
        // evidence list caps at 3, and the first three patterns
        // (taking-forward / next-step / next-up) all have SHORT fixed phrases.
        // So a message matching everything spends its three slots on the
        // cheapest lines and measures 430 — while a message matching ONLY the
        // long-phrase families puts them in all three slots and measures 443,
        // on the longer of the two directives. That second shape is the real
        // worst case; posing the first is how mt#3767 measured 383 for a branch
        // whose true worst case was 474.
        //
        // Deliberately excludes "say the word": that routes to the overlap
        // directive, which is SHORTER, so including it would understate again.
        last_assistant_message:
          "I'll proceed ahead with the migration. I'll implement the remaining detector " +
          "work, and I'm going to write and PR the reviewer replacement work.",
      },
      expects: "warn",
      setup: async () => {
        const store = await import("./turn-end-scan-store");
        store.clearFlagged("mt3767-untaken-action-worstcase-canary");
      },
    },
  },
  {
    // mt#3536 — state-keyed sibling of the guard above. That one keys on the
    // final message's PHRASING; this one keys on what the turn DID: minted a
    // task id, made no call that moves it forward. The R4 incident ended
    // naming no next action at all, so the phrase-keyed guard correctly stayed
    // silent — the silent stop is the gap this closes. Full rationale: the
    // guard module's header.
    name: "turn-end-unwalked-task-scan",
    effects: [advisoryEffect(), recorderEffect()],
    tuningOwnership: "preference",
    event: "Stop",
    module: () => import("./turn-end-unwalked-task-scan").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    calibrationLog: "unwalked-task",
    denyCapable: false,
    // TRUE, unlike the phrase-keyed sibling: the whole signal is the turn's
    // tool calls, which live only in the transcript.
    needsTranscript: true,
    // Measured, not estimated — and re-measured at mt#3784's restructure, which
    // is when the old number here turned out to have drifted: it read "470 chars
    // for the one-task canary" against an actual 519, because the canary below
    // poses ONE task and no primary thread, so it never renders the id-list cap
    // or the longer branch. That is the under-posing `guard-feedback-authoring`
    // §"When you add a branch" warns about, and it is why `worstCaseCanary`
    // below now exists: without it this ceiling was enforced against the SHORT
    // pose and bounded nothing.
    //
    // Current renders, saturated on every axis at once:
    //   - open branch (no primary thread detected), 4+ ids: 604  ← the worst case
    //   - primary-thread branch, 4+ ids:                   466
    //   - one-task open branch (the ordinary canary):      563
    // The restructure ADDED a branch and still came in under the existing 620,
    // so the ceiling is unchanged. The 76% branch got shorter (466 vs the old
    // text's 560), so expected per-fire cost fell to ~499.
    attentionCost: { denialMessageSizeChars: 620, optionCount: 2 },
    canary: {
      input: {
        session_id: "mt3536-unwalked-task-canary",
        transcript_path: "/nonexistent/mt3536-canary.jsonl",
        // Deliberately names NO next action — the R4 shape, and the case the
        // phrase-keyed sibling cannot see.
        last_assistant_message: "Filed as mt#9999. The daemon is crash-looping.",
      },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "the cockpit isn't loading" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_mt3536_canary",
                name: "mcp__minsky__tasks_create",
                input: { title: "Cockpit daemon crash-loops" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_mt3536_canary",
                content: JSON.stringify({ success: true, taskId: "mt#9999" }),
              },
            ],
          },
        },
      ],
      expects: "warn",
      setup: async () => {
        const store = await import("./turn-end-scan-store");
        store.clearFlagged("mt3536-unwalked-task-canary");
      },
    },
    // mt#3784 — the SATURATING input, posed on EVERY axis at once rather than
    // the one that changed. Two axes now exist and they interact: FOUR mints so
    // the id list hits `MAX_LISTED_IDS` AND renders the "…and N more" line, and
    // NO primary-thread call anywhere in the transcript, which selects the
    // LONGER of the two directive branches. Posing only the branch would render
    // 466 and posing only the id cap would still render the short branch —
    // either alone measures a bound that does not exist.
    //
    // The absence is the load-bearing part of this fixture, so do not "fix" it
    // by adding a session_start for realism: that flips it to the primary-thread
    // branch and silently converts the worst-case canary into a second ordinary
    // one, which is the exact failure `worstCaseCanary` was added to prevent.
    worstCaseCanary: {
      input: {
        session_id: "mt3784-unwalked-task-worst-case",
        transcript_path: "/nonexistent/mt3784-worst-case.jsonl",
        last_assistant_message: "Filed four follow-ups from the audit.",
      },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "audit the ingest path" } },
        ...[0, 1, 2, 3].flatMap((i) => [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: `toolu_mt3784_worst_${i}`,
                  name: "mcp__minsky__tasks_create",
                  input: { title: `Audit follow-up ${i}` },
                },
              ],
            },
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: `toolu_mt3784_worst_${i}`,
                  content: JSON.stringify({ success: true, taskId: `mt#99${90 + i}` }),
                },
              ],
            },
          },
        ]),
      ],
      expects: "warn",
      setup: async () => {
        const store = await import("./turn-end-scan-store");
        store.clearFlagged("mt3784-unwalked-task-worst-case");
      },
    },
  },
  {
    // mt#3593 — third Stop-event sibling. `untaken-action` keys on a sign-off
    // phrase; `unwalked-task` keys purely on tool-call state. This one is a
    // hybrid because its trigger has no tool-call signature: nothing the agent
    // CALLS means "an incident happened", so the trigger must be read from the
    // final message while the absence check stays structural (an `asks_create`
    // carrying severity: "incident"). Full rationale: the guard module's header.
    name: "turn-end-unescalated-incident-scan",
    effects: [advisoryEffect(), recorderEffect()],
    tuningOwnership: "preference",
    event: "Stop",
    module: () => import("./turn-end-unescalated-incident-scan").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    calibrationLog: "unescalated-incident",
    denyCapable: false,
    // TRUE: the absence half is a tool-call check, which lives only in the
    // transcript. The trigger half comes from last_assistant_message.
    needsTranscript: true,
    // Measured against the canary below, not estimated.
    attentionCost: { denialMessageSizeChars: 720, optionCount: 2 },
    canary: {
      input: {
        session_id: "mt3593-unescalated-incident-canary",
        transcript_path: "/nonexistent/mt3593-canary.jsonl",
        // Both halves present, no ask filed — the R2 shape.
        last_assistant_message:
          "Production is down — the health probe reports persistence unavailable. " +
          "I can't push the revert; the pre-push gate blocks it and you'll need to run it.",
      },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "did the merge land?" } },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Checking." }] },
        },
      ],
      expects: "warn",
      setup: async () => {
        const store = await import("./turn-end-scan-store");
        store.clearFlagged("mt3593-unescalated-incident-canary");
      },
    },
  },
  {
    // mt#3653 — LOG-ONLY fourth Stop-event sibling: R5 of
    // family:stop-at-handoff. `untaken-action` keys on a sign-off phrase,
    // `unwalked-task` on a tasks_create MINT; this one keys on an
    // evidence-WRITE — a `tasks_spec_patch` into a non-bound open task — with
    // no discharge call in the same turn: the silent stop at a ripe decision,
    // which mints nothing and says nothing, so both siblings are blind to it.
    //
    // Calibration-first: never emits `additionalContext`, so no attentionCost
    // and no canary (the retrospective-completeness-detector precedent — a
    // nominal attentionCost would distort the merged-context budget, which is
    // derived by summing these annotations). Returns only a calibration
    // record, plus a separate evaluation stream
    // (.minsky/stop-at-decision-evaluations.jsonl, mt#3583 pattern). Full
    // rationale, including the recorded ADR-031 deviation for the Stop-side
    // tool-call read: the guard module's header.
    name: "stop-at-decision-scan",
    effects: [recorderEffect()],
    tuningOwnership: "advisory",
    event: "Stop",
    module: () => import("./stop-at-decision-scan").then((m) => ({ run: m.run })),
    // 8s, not the sibling 5s: this guard makes up to MAX_STATUS_READS (2)
    // `minsky` CLI status reads at 2.5s timeout each (measured 1.64s live),
    // and the reads must fit inside the guard budget with the transcript
    // scan's share left over.
    timeoutMs: 8000,
    calibrationLog: "stop-at-decision",
    denyCapable: false,
    // TRUE: both the trigger (spec-patch tool calls) and the discharge check
    // (asks_create/status-set/dispatch/Skill absence) live only in the
    // transcript; only the recommendation-marker leg reads
    // last_assistant_message.
    needsTranscript: true,
  },
  // -------------------------------------------------------------------------
  // mt#2708 — knowledge-acquisition detector (mt#2707 RFC's B proactive-
  // trigger half of the learn-capture primitive). Fires on in-task research
  // relevant to a loaded skill with no propagation (memory_create / /learn /
  // tasks_create) anywhere in the session. Needs transcriptLines (D6) to scan
  // the WHOLE session (loaded skills + research occurrences), not just the
  // last turn — mirrors build-claim-injection-detector.ts's widening.
  //
  // mt#3720 moved it from UserPromptSubmit to Stop and re-grained it from
  // per-research-call to per-session. Stop rather than SessionEnd because
  // SessionEnd has no guards wired through this registry — the repo's one
  // SessionEnd hook is wired directly in settings.json, outside the
  // calibration/canary/override plumbing this detector depends on — and per
  // ADR-017 /exit and /clear do not fire SessionEnd at all. Full reasoning and
  // the accepted residual (mt#3740): the guard module's header.
  // -------------------------------------------------------------------------
  {
    name: "knowledge-acquisition-detector",
    effects: [recorderEffect()],
    tuningOwnership: "advisory",
    event: "Stop",
    module: () => import("./knowledge-acquisition-detector").then((m) => ({ run: m.run })),
    renderProbe: () => import("./knowledge-acquisition-detector").then((m) => m.renderWorstCase()),
    timeoutMs: 10000,
    calibrationLog: "knowledge-acquisition",
    denyCapable: false,
    needsTranscript: true,
    // mt#2708: INJECTION_ENABLED=false — calibration-first, same rationale as
    // causal-premise-detector/build-claim-injection-detector; canary asserts
    // calibration, not warn.
    // MEASURED via `renderProbe` (mt#4002): 627 at 6 research tools. Was 400.
    // The template is fixed; only the joined tool list grows.
    attentionCost: { denialMessageSizeChars: 650, optionCount: 1 },
    canary: {
      // input.cwd defaults to the canary runner's real process.cwd() (a real
      // repo checkout, per baseCanaryInput) — readSkillDescription resolves
      // the REAL `.claude/skills/engineering-writing/SKILL.md` frontmatter,
      // so the canary exercises the rung-2-lite keyword-overlap gate against
      // real skill data, not a synthetic stand-in. `session_id` is a
      // canary-only literal, distinct from any real conversation id, so the
      // dedupe read in `loadAlreadyLoggedDedupeKeys` can never match a
      // genuine prior record and silently suppress this canary forever.
      input: { session_id: "mt2708-canary-session", transcript_path: "mt2708-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Skill", input: { skill: "engineering-writing" } }],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "WebSearch",
                input: { query: "argumentative prose AI writing tells overused phrases" },
              },
            ],
          },
        },
        // TRAILING_WINDOW_TURNS (5) filler turns so the grace period has
        // elapsed. Single-occurrence fixture, so the session-grain verdict and
        // the old per-occurrence one coincide — the canary's expected outcome
        // is unchanged by mt#3720.
        ...Array.from({ length: 5 }, (_, i) => [
          { type: "user", message: { role: "user", content: `filler turn ${i}` } },
          {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "continuing" }] },
          },
        ]).flat(),
        { type: "user", message: { role: "user", content: "current turn" } },
      ],
      expects: "calibration",
    },
  },
  // -------------------------------------------------------------------------
  // mt#4199 — LOG-ONLY sixth Stop-event sibling. The trigger shape closest to
  // `unescalated-incident`: a phrase-gated claim in the closing message, with a
  // structural check on the ABSENCE half. What differs is where the check
  // looks — not at this turn's tool calls, but at the SUBSTRATE, because the
  // question is whether what the message says about an entity is still true.
  //
  // Why a guard and not a cue: `/check-premise` cue (i) already names this
  // exact assertion, shipped as mt#3216, and the assertion recurred twice
  // (mem#669 R17/R18). mt#4191 then measured why — the skill has never been
  // invoked, across 558 conversations. The cue tier is inert here; Stop is the
  // only interception point that runs while the closing message is composed.
  //
  // Calibration-first: never emits `additionalContext`, so no attentionCost
  // (the stop-at-decision / knowledge-acquisition precedent — a nominal value
  // would distort the merged-context budget, which sums these annotations).
  // -------------------------------------------------------------------------
  {
    name: "turn-end-stale-state-assertion-scan",
    effects: [recorderEffect()],
    tuningOwnership: "advisory",
    event: "Stop",
    module: () => import("./turn-end-stale-state-assertion-scan").then((m) => ({ run: m.run })),
    // 8s rather than the phrase-only siblings' 5s: on a gate HIT this guard
    // resolves entity state against Postgres, and a cold hook bootstrap +
    // connect measures 3.3–5.5s (mt#2430). Its own LOOKUP_TIMEOUT_MS (6s)
    // bounds that read — sized to fit a cold bootstrap rather than to look
    // tight — and this 8s leaves margin above it so a slow read is attributed
    // to the guard's own bound rather than killed by the dispatcher's. The gate
    // is regex-only, so the common turn approaches neither.
    timeoutMs: 8000,
    calibrationLog: "stale-state-assertion",
    denyCapable: false,
    // FALSE: both halves come from `last_assistant_message` and the substrate.
    // Unlike every other member of this family, nothing here reads the turn's
    // tool calls — the claim being checked is about the WORLD, not about what
    // this turn did.
    needsTranscript: false,
    canary: {
      // The mem#669 R17 shape verbatim: an ask asserted as still pending in a
      // closing message. Asserts `calibration` rather than `warn` — this guard
      // is record-only, so a record IS its whole observable output. The canary
      // holds whether or not the substrate is reachable: a failed lookup is
      // recorded as a suppression reason, not swallowed.
      input: {
        session_id: "mt4199-stale-state-assertion-canary",
        transcript_path: "/nonexistent/mt4199-canary.jsonl",
        last_assistant_message:
          "mt#3711 is merged and live. Nothing else outstanding.\n\n" +
          "Still with you: ask#8467 — what mt#2430 should deliver now that the RFC option was declined.",
      },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "anything left for me?" } },
      ],
      expects: "calibration",
      setup: async () => {
        const store = await import("./turn-end-scan-store");
        store.clearFlagged("mt4199-stale-state-assertion-canary");
      },
    },
  },
];
