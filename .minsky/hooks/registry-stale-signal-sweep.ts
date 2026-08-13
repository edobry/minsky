// Registry entry for `stale-signal-sweep` (mt#3959).
//
// ## Why this entry lives in its own file
//
// `registry.ts` is AT the 1500-line `max-lines` error ceiling — measured 1497
// counted lines (the rule sets `skipComments`/`skipBlankLines`, so comments
// cannot buy room) before this guard was added, and 1516 with the entry
// inlined. The repo's established answer to that ceiling is extraction into a
// new file, not an exemption: `eslint.config.js` records the same move twice
// for `ConversationView.tsx` (mt#3262, mt#3692) in those words — "same
// exemption rationale, same code, new file."
//
// So this is a one-entry module by necessity rather than by design, and the
// three-line margin means the NEXT guard author hits the same wall. The real
// fix — splitting `GUARD_REGISTRY`'s 2100-line array into per-family modules —
// is **mt#4115**, filed rather than absorbed here because refactoring the
// registry every hook depends on is its own change with its own risk. That task
// deletes this file as part of its own acceptance criteria.
//
// The import is safe in both directions: `recorderEffect` already lives in
// `./registry-effects`, and `GuardRegistration` is imported as a TYPE, which
// TypeScript erases — so `registry.ts` importing this module back is not a
// runtime cycle.

import { recorderEffect } from "./registry-effects";
import type { GuardRegistration } from "./registry";

export const STALE_SIGNAL_SWEEP_GUARD: GuardRegistration = {
  // mt#3959 — artifacts still quoting an output label this PR stopped
  // emitting. Rationale, posture and the measured FP shape live in the
  // module's own doc comment; this entry stays terse per `hook-observers.mdc`.
  name: "stale-signal-sweep",
  effects: [recorderEffect()],
  // `advisory`: whether a quoted reading is actually STALE is a judgment, and
  // the planning measurement found correct usages among the originating
  // token's own matches.
  tuningOwnership: "advisory",
  event: "PreToolUse",
  matcher: "mcp__minsky__session_pr_create",
  module: () => import("./stale-signal-sweep").then((m) => ({ run: m.run })),
  // MUST stay above the module's SWEEP_TIMEOUT_MS (15s) so the guard's OWN
  // deadline fires: that path records a `skipped` outcome, whereas a
  // dispatcher kill records nothing and an infra outage reads as a clean pass.
  timeoutMs: 18000,
  calibrationLog: "stale-signal-sweep",
  // NEVER denies — a stale reading is a conclusion to re-check, not a defect.
  denyCapable: false,
  // MAX_REPORTED_MATCHES (5) x a 200-char excerpt plus a ~420-char frame.
  attentionCost: { denialMessageSizeChars: 2000, optionCount: 1 },
  // Needs a live DB and a git tree, so the healthy canary outcome is a
  // RECORDED skip, short-circuited before any DB is touched (mt#3824 R2).
  canary: {
    input: {
      tool_name: "mcp__minsky__session_pr_create",
      tool_input: { title: "canary stale-signal sweep", type: "chore" },
    },
    expects: "calibration",
  },
};
