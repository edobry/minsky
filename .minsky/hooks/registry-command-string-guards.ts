// Registry entries for the command-string guard family (mt#4096, mt#4144).
//
// ## Why a family module
//
// `registry.ts` is AT the 1500-line `max-lines` ERROR ceiling, and the rule sets
// `skipComments`/`skipBlankLines`, so comments cannot buy room. Adding mt#4144's
// guard inline put the file at 1519 and broke the build — the recurrence
// `registry-pr-create-guards.ts` predicted in its own header: "at 1499 of 1500
// the next guard on any OTHER matcher still breaks the build. mt#4115 owns that
// general split."
//
// This is that split, done for the family that forced it — the same shape and
// for the same reason as the `session_pr_create` module. Exporting an ARRAY
// means `registry.ts` pays ONE import and ONE spread for the whole family, so
// every further guard on this matcher costs it zero additional lines. It does
// not buy headroom back for other families; mt#4115 still owns the general case.
//
// ## What these guards share
//
// Both register on `Bash|mcp__minsky__session_exec` and both match a STRUCTURED
// COMMAND STRING with no paraphrase axis — which is why ADR-024's ladder does not
// govern either of them (its rungs scope to `UserPromptSubmit` guidance hooks
// matching behavioral trigger phrases in the agent's own prose; there is no
// paraphrase to widen in a shell command). Both ship calibration-first and never
// deny: the commands they match are ordinary, and only a conjunction makes them
// reportable.
//
// Where they diverge: mt#4096 catches "the outcome field was discarded before
// anyone read it"; mt#4144 catches "the MCP surface was rebuilt out of CLI calls
// without telling the operator".

import type { GuardRegistration } from "./registry";
import { recorderEffect } from "./registry-effects";

export const COMMAND_STRING_GUARDS: readonly GuardRegistration[] = [
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
];
