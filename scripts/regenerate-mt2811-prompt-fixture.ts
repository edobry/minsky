#!/usr/bin/env bun
/**
 * Regenerates the fixture at
 * .minsky/hooks/fixtures/session-generate-prompt-scope-constraints.txt —
 * a REAL captured output of generateSubagentPrompt(), used by
 * .minsky/hooks/parallel-work-guard.test.ts's contract test to bind
 * extractInScopeFiles's "## Scope Constraints" parser to the actual render
 * format (mt#2811, PR #1953 review 4708851338 R1 BLOCKING #2) — without the
 * hook TEST importing packages/domain internals directly across the
 * .minsky/hooks <-> packages/domain package boundary.
 *
 * Run whenever packages/domain/src/session/prompt-generation.ts's
 * renderScopeSection (or the surrounding prompt shape) changes:
 *
 *   bun run scripts/regenerate-mt2811-prompt-fixture.ts \
 *     > .minsky/hooks/fixtures/session-generate-prompt-scope-constraints.txt
 *
 * This script is NOT run automatically (not part of the build or test
 * pipeline) — it's a manual dev tool for refreshing the fixture after an
 * intentional prompt-format change. If prettier/formatting complains about
 * the regenerated file, that's expected — the file is prose, not code.
 */
import { generateSubagentPrompt } from "../packages/domain/src/session/prompt-generation";

const FIXTURE_SESSION_ID = "00000000-0000-0000-0000-000000000000";
const FIXTURE_SESSION_DIR = `/Users/example/.local/state/minsky/sessions/${FIXTURE_SESSION_ID}`;

/**
 * mt#1279 added a second variant. `--with-notes` emits a prompt that ALSO
 * carries a `scopeNotes` prose section, binding the parser's stop-at-the-
 * next-`##` behavior to the real render: the prose must never leak into the
 * extracted file list. Both variants must be regenerated when the prompt
 * shape changes — see the two commands in each fixture's header.
 */
const withNotes = process.argv.includes("--with-notes");

const FIXTURE_SCOPE_NOTES =
  "Convert the three call sites only. Do NOT touch the render surfaces — that is a separate task.";

const result = generateSubagentPrompt({
  sessionDir: FIXTURE_SESSION_DIR,
  sessionId: FIXTURE_SESSION_ID,
  taskId: withNotes ? "1279" : "2811",
  type: "implementation",
  instructions: "Fix the thing.",
  scope: [`${FIXTURE_SESSION_DIR}/src/foo.ts`, `${FIXTURE_SESSION_DIR}/src/bar.ts`],
  ...(withNotes ? { scopeNotes: FIXTURE_SCOPE_NOTES } : {}),
  // Lean (native-harness) path — no filesystem skill-loading side effects,
  // keeps the fixture deterministic regardless of the machine it's run on.
  harness: "claude-code",
});

const fixtureName = withNotes
  ? "session-generate-prompt-scope-notes.txt"
  : "session-generate-prompt-scope-constraints.txt";
const variantFlag = withNotes ? " --with-notes" : "";
const scopeNotesLine = withNotes ? `\n    scopeNotes:   "${FIXTURE_SCOPE_NOTES}"` : "";

const header = `<!--
  FIXTURE (mt#2811, PR #1953 review 4708851338 R1 BLOCKING #2).

  This is a REAL captured output of
  packages/domain/src/session/prompt-generation.ts's generateSubagentPrompt().
  It exists so parallel-work-guard.test.ts's contract test can bind
  extractInScopeFiles's "## Scope Constraints" parser to the ACTUAL render
  format WITHOUT the hook test importing the domain package's internal
  module across the .minsky/hooks <-> packages/domain boundary (the
  cycle/fragility risk the review flagged). This file, not a live import, is
  the binding mechanism — if renderScopeSection's output shape ever changes,
  regenerate this fixture and the contract test will fail until the parser is
  updated to match (or vice versa).

  Regenerate with:
    bun run scripts/regenerate-mt2811-prompt-fixture.ts${variantFlag} > .minsky/hooks/fixtures/${fixtureName}

  Both variants must be regenerated together when the prompt shape changes —
  the sibling is the same command with the flag toggled (mt#1279).

  Generated with:
    sessionDir:   "${FIXTURE_SESSION_DIR}"
    sessionId:    "${FIXTURE_SESSION_ID}"
    taskId:       "${withNotes ? "1279" : "2811"}"
    type:         "implementation"
    instructions: "Fix the thing."
    scope: [
      "${FIXTURE_SESSION_DIR}/src/foo.ts",
      "${FIXTURE_SESSION_DIR}/src/bar.ts",
    ]${scopeNotesLine}
    harness: "claude-code"  (lean/native-harness path — no filesystem skill-loading)
-->
`;

process.stdout.write(header + result.prompt);
