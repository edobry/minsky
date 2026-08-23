// The settings-registered interceptor descriptions — mt#4198.
//
// The 28 hooks mt#4129 admitted to the catalog: registered in
// `.claude/settings.json`, absent from the fire log, and therefore invisible to
// the pre-mt#4129 oracle that defined the population by fire-logging. They are a
// SEPARATE MODULE rather than another block in `interceptor-descriptions.ts`
// because authoring them pushed that file to 1505 `max-lines`-counted lines
// against a 1500 ERROR ceiling — measured, not predicted. Same reason
// `interceptor-coordinates.ts` became a second leaf in mt#4038.
//
// The seam is the stratum, not an arbitrary cut: every entry here is
// `stratum: "standalone"` with a settings-derived interception point.
//
// PROVENANCE IS THE SOURCE MODULE ALONE for all but three of these. The two
// index rules describe most of this cohort under prose labels
// ("Parallel-work", "Session-end ingest") rather than by module name, so a
// grep for the guard name finds nothing and a rule pointer would assert a
// cross-reference that is not there. `linkify-message-display`,
// `session-start` and `parallel-work-guard` are the three that are named.
//
// @see .minsky/hooks/interceptor-descriptions.ts — the store this feeds
// @see mt#4129 — the population change that admitted these names
// @see mt#4198 — this authoring pass

import type { InterceptorDescription } from "./interceptor-descriptions";
import {
  HOOK_FILES_RULE,
  HOOK_OBSERVERS_RULE,
  REGISTRY,
  hook,
} from "./interceptor-provenance-paths";

/**
 * Spread into `INTERCEPTOR_DESCRIPTIONS` by the main module, so there is still
 * exactly one map and one lookup for every consumer.
 */
export const SETTINGS_REGISTERED_DESCRIPTIONS: readonly (readonly [
  string,
  InterceptorDescription,
])[] = [
  [
    "ask-permission-bridge",
    {
      description:
        "Emits the harness `allow` decision for a command covered by a live grant whose `authorization.approve` ask verifies server-side as operator-approved, so an approval routed through Asks does not have to be given a second time at the permission prompt. DENIES the inverse — a grant whose ask is absent, unapproved, or not operator-attributed — because that pairing is a fabrication signal, not a miss.",
      failureClasses: ["unfounded-claim"],
      provenance: [hook("ask-permission-bridge")],
      stratum: "standalone",
    },
  ],
  [
    "block-github-mcp-pr-writes",
    {
      description:
        "Denies the GitHub MCP server's PR-write tools by name, pointing at the Minsky equivalent that routes through TokenProvider and records provenance. Without it a PR write lands under whatever identity the GitHub server holds.",
      failureClasses: ["corrupt-record"],
      provenance: [hook("block-github-mcp-pr-writes")],
      stratum: "standalone",
    },
  ],
  [
    "bridge-memory-retirement",
    {
      description:
        "When a task reaches DONE or its PR merges, names any bridge memory tagged with that task so the retirement decision is made at the moment it becomes answerable. A bridge memory whose structural fix has shipped is stale guidance that still reads as current.",
      failureClasses: ["stale-context"],
      provenance: [hook("bridge-memory-retirement")],
      stratum: "standalone",
    },
  ],
  [
    "check-prompt-watermark",
    {
      description:
        "Denies an Agent dispatch whose prompt directs session work — naming a session path or a session-write tool — without the `minsky:prompt:v1` watermark that `session_generate_prompt` stamps. Read-only subagent types are exempt; a malformed payload allows.",
      failureClasses: ["wrong-workspace"],
      provenance: [hook("check-prompt-watermark")],
      stratum: "standalone",
    },
  ],
  [
    "deploy-verification-after-merge",
    {
      description:
        "After a merge that touched a deploy surface, injects the reminder that the task is not done until the post-merge deploy is verified healthy. It injects rather than blocks because DONE is set atomically at merge and the deploy only exists afterwards.",
      failureClasses: ["unfounded-claim"],
      provenance: [hook("deploy-verification-after-merge")],
      stratum: "standalone",
    },
  ],
  [
    "dispatch-pretooluse",
    {
      description:
        "The single PreToolUse entry that runs every registry-migrated guard in one process — reading stdin once and resolving shared context once instead of paying a process spawn per guard. Not a check itself: a failure here silently removes every guard it dispatches.",
      failureClasses: ["blind-enforcement"],
      provenance: [hook("dispatch-pretooluse"), hook("dispatcher"), REGISTRY],
      stratum: "standalone",
      filenameNote:
        "Named for the event, not an intervention — it delegates, and the family filters must read its delegates rather than this entry.",
    },
  ],
  [
    "dispatch-stop",
    {
      description:
        "The Stop-event sibling of `dispatch-pretooluse`, running the turn-end scans registered on the dispatcher. `typecheck-on-stop` predates the framework and stays a separate Stop registration, so a fault here does not disable the typecheck gate.",
      failureClasses: ["blind-enforcement"],
      provenance: [hook("dispatch-stop"), hook("dispatcher"), REGISTRY],
      stratum: "standalone",
    },
  ],
  [
    "dispatch-userpromptsubmit",
    {
      description:
        "The UserPromptSubmit sibling, carrying the largest delegate set — the guidance detectors plus the per-turn injectors. All of their `additionalContext` is merged into ONE injected block here, under a shared character budget, which is why an over-budget turn drops the lowest-priority fragments rather than any one detector deciding to stay quiet.",
      failureClasses: ["blind-enforcement"],
      provenance: [hook("dispatch-userpromptsubmit"), hook("dispatcher"), REGISTRY],
      stratum: "standalone",
    },
  ],
  [
    "drive-pr-to-convergence",
    {
      description:
        "On a successful `session_pr_create`, injects the reminder that driving the PR to review and merge is the agent's job — not a hand-off point to close the turn on. Informational; it never blocks.",
      failureClasses: ["lost-signal"],
      provenance: [hook("drive-pr-to-convergence")],
      stratum: "standalone",
    },
  ],
  [
    "drive-ready-to-implementation",
    {
      description:
        "On a real transition INTO READY, injects the instruction to invoke `/implement-task` now rather than ending the turn asking whether to proceed. Skips `state-ops` tasks, which are walked without a session.",
      failureClasses: ["lost-signal"],
      provenance: [hook("drive-ready-to-implementation")],
      stratum: "standalone",
    },
  ],
  [
    "unowned-finding-scan",
    {
      description:
        "On a task's transition to DONE, records each item in the spec's findings section (`Noticed, not actioned` and variants) that declares neither an `[owner: mt#N]` nor a `[no-owner: reason]`. The section is a sanctioned place to write a finding down; without a declared owner it is also where the finding stops being read. Log-only.",
      failureClasses: ["lost-signal"],
      provenance: [hook("unowned-finding-scan")],
      stratum: "standalone",
    },
  ],
  [
    "guard-events-ingest-on-session-end",
    {
      description:
        "Runs one guard-events ingest tick at SessionEnd so the guard and calibration exhaust becomes queryable promptly. Latency only — SessionEnd does not fire on `/exit`, `/clear` or a kill, so the cockpit's periodic sweep is the layer that makes ingest complete.",
      failureClasses: ["lost-signal"],
      provenance: [hook("guard-events-ingest-on-session-end")],
      stratum: "standalone",
    },
  ],
  [
    "inject-success-criteria",
    {
      description:
        "Emits the bound task's success criteria verbatim as the PR is being created, so they are confronted at ship time rather than recalled from having written them. The create call is already in flight when it fires, so it prompts a follow-up edit rather than shaping the body.",
      failureClasses: ["unfounded-claim"],
      provenance: [hook("inject-success-criteria")],
      stratum: "standalone",
    },
  ],
  [
    "linkify-message-display",
    {
      description:
        "Rewrites bare task, PR and short-id refs into clickable deeplinks in the message the operator sees, leaving the stored transcript's bare refs untouched. Replaces an authoring ration that measured 31 linked against 232 bare refs in one session; an id its cache cannot resolve is left bare rather than linked wrongly.",
      failureClasses: ["lost-signal"],
      provenance: [hook("linkify-message-display"), HOOK_OBSERVERS_RULE],
      stratum: "standalone",
    },
  ],
  [
    "loop-preflight-pr-merge-check",
    {
      description:
        "Blocks `/loop` when a PR or task named in its arguments is already terminal, before the first iteration runs. The originating incident had an agent looping for six hours against a PR merged at the start, pushing an orphan commit to a closed branch.",
      failureClasses: ["duplicate-work"],
      provenance: [hook("loop-preflight-pr-merge-check")],
      stratum: "standalone",
    },
  ],
  [
    "parallel-work-guard",
    {
      description:
        "Blocks binding a session to a task when an unmerged open PR already touches the same files. Guards `tasks_dispatch` in existing-task mode too, because that path starts the session in process and would otherwise skip the sweep.",
      failureClasses: ["duplicate-work"],
      provenance: [hook("parallel-work-guard"), HOOK_FILES_RULE],
      stratum: "standalone",
    },
  ],
  [
    "post-merge-pull",
    {
      description:
        "Fast-forwards the main checkout after a merge, stashing and popping around local modifications, and warns when MCP server code changed. The only interceptor here whose effect lands on the repo working tree rather than on the conversation.",
      failureClasses: ["stale-context"],
      provenance: [hook("post-merge-pull")],
      stratum: "standalone",
    },
  ],
  [
    "post-merge-unasked-direction-scan",
    {
      description:
        "After a session PR merges, runs an AI analyzer over that session's transcript to surface preference-bound decisions the agent made without asking, and writes the findings for weekly operator triage. Observational — the merge has already happened, so it never blocks.",
      failureClasses: ["unrecorded-learning"],
      provenance: [hook("post-merge-unasked-direction-scan")],
      stratum: "standalone",
      note: "The corpus's only entity with an AI classifier — `mechanism: \"model\"`, ADR-024's rung 3. mt#4038 measured that rung as unexercised across the fire-log population, a population this hook is absent from because it never fire-logs.",
    },
  ],
  [
    "post-session-start",
    {
      description:
        "Labels and colors the iTerm tab for the task a new session is bound to, and writes the session-label state file. Its audience is the operator looking at a row of terminal tabs; it decides nothing about the trajectory.",
      failureClasses: ["lost-signal"],
      provenance: [hook("post-session-start")],
      stratum: "standalone",
    },
  ],
  [
    "record-conversation-run-state",
    {
      description:
        "Forwards one observed harness event to the cockpit daemon over HTTP, so the fleet view knows what each conversation is doing. One script registered under every observed event, branching on the event name; it POSTs rather than writing the DB directly because a cold hook process pays ~695ms for a domain bootstrap against ~20ms for the POST.",
      failureClasses: ["lost-signal"],
      provenance: [hook("record-conversation-run-state")],
      stratum: "standalone",
      note: "Fail-open is a hard contract: it is git-tracked and reaches every dispatched-subagent workspace, so a conversation whose events do not land degrades to UNKNOWN in the cockpit rather than failing a turn.",
    },
  ],
  [
    "record-subagent-invocation",
    {
      description:
        "On SubagentStop, classifies the subagent's workspace outcome and writes the Stop-time columns of its dispatch row, closing the record the PreToolUse stamp opened. Without it a dispatch is visible as started and never as finished.",
      failureClasses: ["lost-signal"],
      provenance: [hook("record-subagent-invocation")],
      stratum: "standalone",
    },
  ],
  [
    "session-start",
    {
      description:
        "Records this conversation's identity as a `<harness pid> -> conversation id` mapping the MCP proxy reads, and bootstraps the remote environment in web sessions. The proxy reads its conversation id once at spawn, so without this every `/clear`, resume and fork leaves it stamping the previous conversation onto tool calls — including presence claims, which then attribute an agent's work to a stranger.",
      failureClasses: ["corrupt-record"],
      provenance: [hook("session-start"), HOOK_OBSERVERS_RULE],
      stratum: "standalone",
    },
  ],
  [
    "stamp-ask-conversation",
    {
      description:
        "Records which CONVERSATION filed an ask — the one place that sees the harness conversation id and the newly-minted ask id together. Without it `inject-ask-responses` can never fire: `Ask.parentSessionId` holds a WORKSPACE session id, and a main-workspace conversation has no workspace session to record.",
      failureClasses: ["corrupt-record"],
      provenance: [hook("stamp-ask-conversation")],
      stratum: "standalone",
    },
  ],
  [
    "stamp-pr-author-link",
    {
      description:
        "Records which CONVERSATION authored a session PR — the one place that sees the harness conversation id and the workspace id together. It fires at PR-create, not merge, because for dispatched work a subagent writes the code and the main agent merges it.",
      failureClasses: ["corrupt-record"],
      provenance: [hook("stamp-pr-author-link")],
      stratum: "standalone",
    },
  ],
  [
    "stamp-session-creator-link",
    {
      description:
        "Records which conversation created a workspace at `session_start` — the dominant creation path, which had no link writer while the daemon-spawn and PR-author paths did. Measured before it shipped: 2 of 230 workspaces carried any link row.",
      failureClasses: ["corrupt-record"],
      provenance: [hook("stamp-session-creator-link")],
      stratum: "standalone",
    },
  ],
  [
    "transcript-ingest-on-session-end",
    {
      description:
        "Ingests the finished conversation's transcript at SessionEnd so it is searchable without waiting for the next server boot sweep. The only ingest caller with positive evidence the conversation ended, so it is the only one permitted to set `ended_at`.",
      failureClasses: ["lost-signal"],
      provenance: [hook("transcript-ingest-on-session-end")],
      stratum: "standalone",
    },
  ],
  [
    "two-strikes-record",
    {
      description:
        "Records every tool error and accumulates per-conversation error streaks, feeding the calibration data behind the 2-strikes rule. Runs in observation mode by default: it logs what would have fired without acting, so the discipline itself is still the agent's to keep.",
      failureClasses: ["blind-enforcement"],
      provenance: [hook("two-strikes-record")],
      stratum: "standalone",
    },
  ],
  [
    "typecheck-on-edit",
    {
      description:
        "Runs an incremental typecheck after a TypeScript edit and surfaces filtered errors as context, and records which project root was touched. It never blocks — the root it records is what its Stop-time sibling reads to know what to check.",
      failureClasses: ["broken-main"],
      provenance: [hook("typecheck-on-edit")],
      stratum: "standalone",
    },
  ],
  [
    "typecheck-on-stop",
    {
      description:
        "Blocks the end of a turn — main agent or subagent — while any project root edited during it still has type errors. The correctness gate the informational edit-time sibling deliberately is not.",
      failureClasses: ["broken-main"],
      provenance: [hook("typecheck-on-stop")],
      stratum: "standalone",
    },
  ],
  [
    "verify-subagent-model",
    {
      description:
        "Compares a dispatched subagent's actual resolved model against the tier that was requested and surfaces any mismatch. It exists because a silent config pin overrode every explicit request for three months, and an investigation reported to the operator as frontier-tier had run entirely on Sonnet — the request is not evidence of the outcome.",
      failureClasses: ["unfounded-claim"],
      provenance: [hook("verify-subagent-model")],
      stratum: "standalone",
      subject: "system",
    },
  ],
];
