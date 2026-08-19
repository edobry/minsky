// Registry entries for the command-string guard family (mt#2889, mt#3282,
// mt#3910, mt#4055, mt#4081, mt#4096, mt#4144).
//
// ## The family boundary
//
// Every guard here registers on `Bash|mcp__minsky__session_exec` and decides
// from a STRUCTURED COMMAND STRING — the shell command itself, parsed, with no
// paraphrase axis. That last property is why ADR-024's calibration ladder does
// not govern any of them: its rungs scope to `UserPromptSubmit` guidance hooks
// matching behavioral trigger phrases in the agent's own prose, and there is no
// paraphrase to widen in a shell command. Postures here are therefore decided
// per guard on the ordinary evidence, not by climbing that ladder.
//
// The family splits cleanly in two, and the split is the posture:
//
//   - DENY on the command as written — `check-guessed-session-path` (a session
//     path that does not exist on disk), `block-secret-file-read` (a reader
//     aimed at a secret-bearing file, a secret-emitting script, or an argv
//     column), `block-concurrent-bulk-mutation` (a second copy of a script
//     already running with an execute flag), `block-bulk-process-kill`.
//   - RECORD only — `chained-verification-commands` (a non-zero exit made
//     unattributable), `truncated-outcome-read` (an outcome field discarded by
//     position before anyone read it), `cli-mcp-substitution` (the MCP surface
//     rebuilt out of CLI calls without telling the operator). The commands
//     these match are ordinary; only a conjunction makes them reportable, which
//     is why they never deny.
//
// ## Order
//
// The array order below is the dispatch order, and it is load-bearing: every
// guard here matches the same tool names, so the dispatcher's first-deny-wins
// walk runs them in exactly this sequence. It reproduces the pre-mt#4115
// `GUARD_REGISTRY` order byte-for-byte — do not reorder to tidy.
//
// ## Why a family module
//
// `registry.ts` was AT the 1500-line `max-lines` ERROR ceiling, and the rule
// sets `skipComments`/`skipBlankLines`, so comments cannot buy room. This module
// was created by mt#4144, whose guard put the file at 1519 inline and broke the
// build — the recurrence `registry-pr-create-guards.ts` had predicted in its own
// header. It then held two entries and said "mt#4115 still owns the general
// case." mt#4115 has since landed: every family now has a module, this one
// absorbed the five `Bash` guards that were still inline in `registry.ts`, and
// that file is far below the ceiling again. Deliberately no figure here —
// `bunx eslint .minsky/hooks/registry.ts` is the check, and a quoted count went
// stale twice inside mt#4115 itself, once between two commits of the same
// change. See `docs/architecture/hooks/guard-dispatcher-framework.md §Where
// registry entries live`.
//
// `CANARY_NONEXISTENT_SESSION_PATH` below moved here with mt#4115 for the same
// reason: a fixture belongs beside the canary it feeds, and its only consumer is
// `check-guessed-session-path`.

import { tmpdir } from "node:os";
import { posix } from "node:path";
import type { GuardRegistration } from "./registry";
import { enforcementEffect, recorderEffect } from "./registry-effects";

/**
 * Machine-independent absolute path matching `check-guessed-session-path.ts`'s
 * `SESSION_DIR_RE` (`[^\s'"]*\/state\/minsky\/sessions\/([^/\s'"]+)`) — that
 * regex only requires the literal substring `/state/minsky/sessions/<id>`
 * ANYWHERE in the string, so prefixing it with `os.tmpdir()` (instead of a
 * hardcoded developer home directory) satisfies the guard's detection while
 * working identically on any machine/user. The id itself is a fixed sentinel
 * UUID-shaped string that will never exist as a real session — `exists()`
 * (real `fs.existsSync`) always returns false for it, so the canary
 * deterministically triggers the guard's deny path.
 *
 * `posix.join`, not `join`: the regex above requires FORWARD slashes, and
 * platform `join` emits `\` on Windows — which would silently stop the canary
 * matching, i.e. a fixture that no longer exercises the deny path it exists to
 * prove. Identical output to `join` on macOS and Linux, the only platforms this
 * repo's CI runs (`macos-latest`, `ubuntu-latest`), so this is a no-op today and
 * correct if that ever changes. Raised as PRE-EXISTING on PR #3027 R1: the shape
 * predates mt#4115 — it was inline in `registry.ts` — and moving it here is what
 * made it visible.
 */
const CANARY_NONEXISTENT_SESSION_PATH = posix.join(
  tmpdir(),
  "state",
  "minsky",
  "sessions",
  "00000000-canary-nonexistent-0000"
);

export const COMMAND_STRING_GUARDS: readonly GuardRegistration[] = [
  {
    name: "check-guessed-session-path",
    effects: [enforcementEffect()],
    tuningOwnership: "invariant",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./check-guessed-session-path").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: true,
    // mt#2597: measured against buildDenialReason()'s fixed message body
    // (excluding the dynamic per-missing-path list) — ~398 chars; one
    // remediation option (the MINSKY_SKIP_SESSION_PATH_CHECK override).
    attentionCost: { denialMessageSizeChars: 650, optionCount: 1 },
    // mt#2889: a Bash command referencing an absolute sessions/<id>/ path
    // that has never existed on disk — findMissingInToolInput's exists()
    // check (real fs.existsSync, no synthetic override needed) always
    // returns false for this fixed sentinel path.
    canary: {
      input: {
        tool_name: "Bash",
        tool_input: {
          command: `cd ${CANARY_NONEXISTENT_SESSION_PATH}/ && ls`,
        },
      },
      expects: "deny",
    },
  },
  // -------------------------------------------------------------------------
  // mt#3910 — chained verification commands, detected at the tool boundary.
  //
  // `terminal-command-best-practices.mdc §Verification Commands` bans this and
  // has shipped TWICE at prose tier (mt#2371, widened by mt#2571). The class
  // recurred anyway on 2026-08-10 with the rule in always-on context and read —
  // the signature of a control that depends on recall at the moment attention is
  // on the outcome. See mem#553's R2 section for the containment argument.
  //
  // NOT an ADR-024 rung: that ladder scopes itself to UserPromptSubmit guidance
  // hooks matching trigger phrases in agent PROSE, and neither of its axes
  // (quotation-elision, embedding recall) applies to parsing a command string.
  // Calibration-first here follows the observer convention, not that ADR.
  // -------------------------------------------------------------------------
  {
    name: "chained-verification-commands",
    effects: [recorderEffect()],
    // `advisory`: which binaries count as "verification" is a heuristic with a
    // real false-positive surface, and the calibration log exists to size it
    // before any enforcement posture is considered.
    tuningOwnership: "advisory",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./chained-verification-commands-detector").then((m) => ({ run: m.run })),
    // The scan is a pure string parse with no IO — it cannot approach this.
    timeoutMs: 5000,
    calibrationLog: "chained-verification-commands",
    // NEVER denies. A false fire here would block a legitimate command, and the
    // trigger's narrowness is unproven until the calibration data says otherwise.
    denyCapable: false,
    // MEASURED, not estimated: `buildWarning()` renders 501 chars for the
    // two-command case (the dominant shape). Each additional chained command
    // adds ~30 chars for its backticked name, so 700 covers a 6-command chain
    // without widening the merged-context budget beyond what the shape needs.
    attentionCost: { denialMessageSizeChars: 700, optionCount: 1 },
    // The scan is pure over its input, so the canary exercises the real decision
    // path — no DB, no environment dependency. It asserts a genuine MATCH rather
    // than a skip: this guard's healthy behavior is observable in a canary
    // process, unlike its DB-dependent siblings above.
    canary: {
      input: {
        tool_name: "Bash",
        tool_input: {
          command: "bun run format:all; bun test packages/",
        },
      },
      expects: "calibration",
    },
  },
  // mt#4096. Never denies; `attentionCost` MEASURED via `renderProbe` (mt#4002):
  // 508 chars for a long `session pr create` invocation, bounded on the axis
  // that grows (the echoed command string) with headroom.
  // Detail: `docs/architecture/hooks/truncated-outcome-read-detector.md`.
  {
    name: "truncated-outcome-read",
    effects: [recorderEffect()],
    tuningOwnership: "advisory",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./truncated-outcome-read-detector").then((m) => ({ run: m.run })),
    renderProbe: () => import("./truncated-outcome-read-detector").then((m) => m.renderWorstCase()),
    timeoutMs: 5000,
    calibrationLog: "truncated-outcome-read",
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 700, optionCount: 1 },
    // The originating incident's own command shape (mt#4096).
    canary: {
      input: {
        tool_name: "Bash",
        tool_input: { command: "minsky session commit --task 'mt#1' 'msg' 2>&1 | tail -6" },
      },
      expects: "calibration",
    },
  },
  // -------------------------------------------------------------------------
  // mt#4215 — a search whose TARGET PATH does not exist. Prints nothing, and
  // `2>/dev/null` deletes the one signal that tells that apart from "searched,
  // found nothing", so the empty result reads as an answer.
  //
  // The exit code DOES distinguish the two (2 vs 1, measured across ugrep,
  // BSD grep and ripgrep) — but Claude Code's `Bash` tool response carries only
  // `stdout`, `stderr`, `interrupted`, `isImage`, so no hook can read it. That
  // rules out the cheaper PostToolUse design and leaves the pre-run stat.
  // -------------------------------------------------------------------------
  {
    name: "nonexistent-search-path",
    effects: [recorderEffect()],
    // `advisory`: the zero-false-positive bar in mt#4215 §SC4 is a claim about
    // an argument-grammar parser, and the calibration log exists to size it
    // before any enforcement posture is considered.
    tuningOwnership: "advisory",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./nonexistent-search-path-detector").then((m) => ({ run: m.run })),
    renderProbe: () =>
      import("./nonexistent-search-path-detector").then((m) => m.renderWorstCase()),
    // Stats a handful of path prefixes plus at most one readdir per missing
    // path — bounded filesystem work on a local tree.
    timeoutMs: 5000,
    calibrationLog: "nonexistent-search-path",
    // NEVER denies. A false fire would block a legitimate search, and the
    // parser's precision is unproven until the calibration data says otherwise.
    denyCapable: false,
    // MEASURED via `renderProbe`: 992 chars saturated on every axis at once
    // (MAX_RENDERED_PATHS entries plus the overflow line, each with a long
    // path, a long ancestor and a full suggestion list). The path strings are
    // the one unbounded axis, so this is a saturated SAMPLE, not a proved
    // ceiling — pinned against 1050 by the detector's own test.
    attentionCost: { denialMessageSizeChars: 1050, optionCount: 1 },
    // The originating incident's own command (mt#4215). Its three path
    // arguments are the whole point: two do not exist, and `cockpit-tray/src`
    // does — so a canary that fired on all three would be hiding the
    // discrimination this guard is for.
    canary: {
      input: {
        tool_name: "Bash",
        tool_input: {
          command:
            "grep -rniE 'memory|ceiling' --include='*.ts' " +
            "src/cockpit/tray src/tray cockpit-tray/src 2>/dev/null",
        },
      },
      expects: "calibration",
    },
  },
  // mt#4144. Never denies; `attentionCost` MEASURED via `renderProbe` (mt#4002).
  // Detail: `docs/architecture/hooks/cli-mcp-substitution-detector.md`.
  {
    name: "cli-mcp-substitution",
    effects: [recorderEffect()],
    tuningOwnership: "advisory",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./detect-cli-mcp-substitution").then((m) => ({ run: m.run })),
    renderProbe: () => import("./detect-cli-mcp-substitution").then((m) => m.renderWorstCase()),
    timeoutMs: 5000,
    calibrationLog: "cli-mcp-substitution",
    // Load-bearing: the suppression leg reads `ctx.transcriptLines` to ask
    // whether any `mcp__minsky__*` call has succeeded. Without this the
    // dispatcher hands the guard nothing, `hasUsedMcpSurface` is always false,
    // and the guard fires on every legitimate CLI call — present, green and
    // wrong, in the shape `work-completion.mdc §Invocation path` describes.
    needsTranscript: true,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 900, optionCount: 1 },
    // The originating incident's own command (mem#707 R10).
    canary: {
      input: {
        tool_name: "Bash",
        tool_input: { command: "bun run src/cli.ts tasks get mt#0000 --json" },
      },
      expects: "calibration",
    },
  },
  {
    name: "block-secret-file-read",
    effects: [enforcementEffect()],
    // `invariant`: the set of files whose content is credential material is not
    // an operator preference to tune. Widening the path list is a code change
    // with its own review, not a threshold knob.
    tuningOwnership: "invariant",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./block-secret-file-read").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: true,
    // mt#3282: measured against buildDenialReason()'s fixed body (excluding the
    // dynamic per-hit list) — ~1080 chars. Larger than its siblings on purpose:
    // the message has to teach the safe presence-check forms AND warn off the
    // redaction workaround, because the originating incident happened to an
    // agent who did redact and whose filter silently matched nothing. One
    // remediation option (the MINSKY_ALLOW_SECRET_FILE_READ override).
    attentionCost: { denialMessageSizeChars: 1200, optionCount: 1 },
    // mt#2889: the simplest denying shape — an emitting reader on the config
    // file that mt#2864 found had leaked all four live API keys. Purely
    // string-driven (no filesystem or env dependency), so the canary is stable.
    // The verbatim R3 pipeline, with its quote-nested `\|`, is asserted in
    // block-secret-file-read.test.ts instead, where escaping is readable.
    canary: {
      input: {
        tool_name: "Bash",
        tool_input: {
          command: "cat ~/.config/minsky/config.yaml",
        },
      },
      expects: "deny",
    },
  },
  // -------------------------------------------------------------------------
  // mt#4055: the duplication-gate family's first EXECUTION-surface member.
  // Every sibling gate binds to a task-graph surface (`tasks_create`,
  // `session_start`, `tasks_dispatch`), so `bun scripts/<x>.ts --execute`
  // reached production through no check at all — which is how two concurrent
  // full-keyset backfills ran against one production table for ~50 minutes on
  // 2026-08-12. See mem#999.
  // -------------------------------------------------------------------------
  {
    name: "block-concurrent-bulk-mutation",
    // BOTH effects, and the recorder is load-bearing (PR #2937 R3): this guard denies AND writes
    // a calibration record on every governed command — including the `overridden` outcome, which
    // is the whole point of recording the override rather than returning null. Declaring only the
    // enforcement effect left the records with nowhere to land: emitted by `run`, dropped by the
    // dispatcher for want of a `calibrationLog`. Silent, and exactly the shape of defect this
    // guard's own docblock warns about elsewhere.
    effects: [enforcementEffect(), recorderEffect()],
    // `invariant`: "do not start a second copy of a script that is already
    // running" is not a threshold an operator tunes. The escape is the
    // documented override on the individual call, not a knob.
    tuningOwnership: "invariant",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./block-concurrent-bulk-mutation").then((m) => ({ run: m.run })),
    // Two short-lived subprocess calls (`pgrep`, then `ps` on the matched pids),
    // and only on a command that already matched the pure trigger.
    timeoutMs: 5000,
    calibrationLog: "block-concurrent-bulk-mutation",
    denyCapable: true,
    // MEASURED against buildDenialReason()'s fixed body plus one process entry
    // — ~780 chars. The per-process line adds ~140 chars, and a collision with
    // more than two other runs is not a shape worth budgeting for. One
    // remediation option (the MINSKY_ALLOW_CONCURRENT_BULK_MUTATION override).
    attentionCost: { denialMessageSizeChars: 1000, optionCount: 1 },
    // Expects `calibration`, NOT `deny`, and that is deliberate: the deny
    // depends on the HOST's process table, which a canary cannot arrange
    // without actually starting a second process. So the canary exercises the
    // real trigger (pure, string-driven) and stops there — `run` short-circuits
    // in canary mode before the probe, so no canary shells out. The deny path's
    // own coverage lives in block-concurrent-bulk-mutation.test.ts, where the
    // probe is injected.
    canary: {
      input: {
        tool_name: "Bash",
        tool_input: {
          command: "bun scripts/backfill-agent-tool-call-projection.ts --execute",
        },
      },
      expects: "calibration",
    },
  },
  // -------------------------------------------------------------------------
  // mt#4081: the ACT-path half of the operator-deferral family. Its sibling
  // detector catches the DEFER path (prose handing a fixable thing to the
  // operator); the act path emits no prose at all — the agent concludes a
  // capability is unavailable and quietly builds a destructive workaround. On
  // 2026-08-13 that workaround was `kill` on 26 live sessions, and the operator
  // denied it by hand. See mem#707 R8.
  // -------------------------------------------------------------------------
  {
    name: "block-bulk-process-kill",
    // BOTH effects, for the same reason the sibling above declares both: the
    // `overridden` outcome is the record most worth keeping, and a guard that
    // declares only the enforcement effect has nowhere to land it.
    effects: [enforcementEffect(), recorderEffect()],
    // `invariant`: "do not mass-kill the operator's working set" is not a
    // threshold anyone tunes. The escape is the documented per-call override.
    tuningOwnership: "invariant",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./block-bulk-process-kill").then((m) => ({ run: m.run })),
    // Pure string decision — no subprocess, no process table.
    timeoutMs: 2000,
    calibrationLog: "block-bulk-process-kill",
    denyCapable: true,
    // MEASURED against buildDenialReason(): 708 chars for the PID form (8 pids,
    // the originating incident's shape), 699 for the process-name form. One
    // remediation option (the MINSKY_ALLOW_BULK_PROCESS_KILL override).
    attentionCost: { denialMessageSizeChars: 800, optionCount: 1 },
    canary: {
      input: {
        tool_name: "Bash",
        tool_input: { command: "kill 111 222 333" },
      },
      expects: "deny",
    },
  },
];
