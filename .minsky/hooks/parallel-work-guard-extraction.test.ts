// Tests for mt#2811's parallel-work guard hardening: the In-scope file
// extractor (extractInScopeFiles / extractScopeConstraintsFiles), the
// resolveInScopeFiles entrypoint helper, the shouldReportAsGuardDegraded
// stderr-vs-stdout discriminator, and the buildTasksChildrenArgv CLI-shape
// fix. Split out of parallel-work-guard.test.ts (PR #1953 review 4708851338
// R1, addressing max-lines) — mirrors the existing
// parallel-work-guard-dedup.test.ts split for the duplicate-child guard.

import { describe, expect, it } from "bun:test";
// This hook test reads a checked-in fixture file
// (.minsky/hooks/fixtures/session-generate-prompt-scope-constraints.txt), not
// application state; this IS the mt#2811 PR #1953 review's mandated binding
// mechanism (BLOCKING #2) replacing a live cross-package import — see the
// fixture's own header comment and the describe block below.
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads a checked-in test fixture, not application state
import { readFileSync } from "fs";
import { join } from "path";

import {
  extractInScopeFiles,
  extractScopeConstraintsFiles,
  resolveInScopeFiles,
  shouldReportAsGuardDegraded,
  buildTasksChildrenArgv,
  DISPATCH_TOOL_NAME,
  type ResolvedInScopeFiles,
} from "./parallel-work-guard";

// ---------------------------------------------------------------------------
// extractScopeConstraintsFiles / extractInScopeFiles — session_generate_prompt
// contract (mt#2811)
//
// mt#2811 acceptance criterion #1 + #4: bind the guard's parser to
// session_generate_prompt's ACTUAL rendered output format, via a test that
// generates a real prompt and feeds it straight to the extractor. If either
// side drifts (renderScopeSection's heading/bullet shape, or this parser's
// expectations), this test fails loudly in CI instead of the guard silently
// no-op-ing at fire time — exactly the mt#2811 incident (12/12 tasks_dispatch
// fires logged "Could not extract file paths ... — parallel-work check
// skipped").
// ---------------------------------------------------------------------------

// mt#2811 PR #1953 review 4708851338 R1 BLOCKING #2: the contract test binds
// extractInScopeFiles to session_generate_prompt's ACTUAL render format via a
// CHECKED-IN FIXTURE (a real captured generateSubagentPrompt() output) rather
// than importing packages/domain/src/session/prompt-generation.ts directly
// from this hook test — that import crossed the .minsky/hooks <->
// packages/domain package boundary from test code that runs on every
// `bun test:hooks` invocation, a cycle/fragility risk the review flagged. The
// fixture, regenerable via `bun run scripts/regenerate-mt2811-prompt-fixture.ts`
// (see its header comment), is the binding: if renderScopeSection's output
// shape ever changes without the fixture being refreshed, this test fails —
// exactly the "SOME binding that fails when the prompt format drifts"
// guarantee the original test existed for, without the import-boundary risk.
const SCOPE_CONSTRAINTS_FIXTURE_PATH = join(
  __dirname,
  "fixtures",
  "session-generate-prompt-scope-constraints.txt"
);

describe("extractScopeConstraintsFiles / session_generate_prompt contract (mt#2811)", () => {
  it("parses the exact '## Scope Constraints' shape session_generate_prompt renders (checked-in fixture)", () => {
    // Checked-in test fixture read, not application state under test; see
    // the import-site justification above.
    // eslint-disable-next-line custom/no-real-fs-in-tests -- checked-in test fixture read, not application state
    const fixturePrompt = readFileSync(SCOPE_CONSTRAINTS_FIXTURE_PATH, "utf8");
    const scopeFiles = [
      "/Users/example/.local/state/minsky/sessions/00000000-0000-0000-0000-000000000000/src/foo.ts",
      "/Users/example/.local/state/minsky/sessions/00000000-0000-0000-0000-000000000000/src/bar.ts",
    ];

    expect(fixturePrompt).toContain("## Scope Constraints");

    // extractInScopeFiles is the ONE parser production code calls; assert
    // through it (not the lower-level extractScopeConstraintsFiles alone) so
    // the contract covers the actual production entrypoint. The leading HTML
    // comment header in the fixture file does not interfere — the extractor
    // matches "## Scope Constraints" per-line, and comment lines never start
    // with "##".
    const { files, warnings } = extractInScopeFiles(fixturePrompt);
    expect(warnings).toHaveLength(0);
    for (const f of scopeFiles) {
      expect(files).toContain(f);
    }
  });

  it("extractScopeConstraintsFiles returns [] for content with no such heading", () => {
    expect(extractScopeConstraintsFiles("## Summary\n\nNo scope constraints here.\n")).toEqual([]);
  });

  it("extractScopeConstraintsFiles stops at the next ## heading", () => {
    const content = `## Scope Constraints

Only modify the following files:
- /a/b.ts
- /a/c.ts

## Committing Your Work

Some unrelated instructions.
`;
    const files = extractScopeConstraintsFiles(content);
    expect(files).toEqual(["/a/b.ts", "/a/c.ts"]);
  });
});

// ---------------------------------------------------------------------------
// extractInScopeFiles — mt#2811 fallback chain (current /create-task convention)
//
// Root cause of the 12/12 tasks_dispatch "Could not extract file paths"
// fires: the CURRENT /create-task spec template
// (.claude/skills/create-task/SKILL.md, compiled from
// .minsky/skills/create-task/SKILL.md) writes "**In scope:**" as a PROSE
// sentence describing scope AREAS, never a bullet list of literal file
// paths. Confirmed against mt#2811's own real spec and the skill's own
// worked example (both reproduced below verbatim). The strict mt#1362
// bullet-list extraction therefore ALWAYS finds zero files against any
// current-convention spec; these tests exercise the fallback chain that
// recovers file references from '## Context' or, failing that, reports a
// loud, specific degradation.
// ---------------------------------------------------------------------------

describe("extractInScopeFiles — mt#2811 fallback chain", () => {
  // Reproduces mt#2811's OWN real spec content (fetched live via
  // tasks_spec_get during this task's root-cause investigation) — the exact
  // shape that triggered "Could not extract file paths from '**In scope:**'
  // block" on every dispatch fire.
  const mt2811RealSpec = `## Summary

Harden the parallel-work guard's two data-extraction paths.

## Success Criteria

- [ ] The In-scope path extractor parses the CURRENT session_generate_prompt output format

## Scope

**In scope:** extractor + enumeration fixes, parser<->prompt-format contract test, loud-degradation messaging.
**Out of scope:** tier policy / override semantics (mt#1637), duplicate-matcher coverage (sibling child).

## Acceptance Tests

- Feed the guard the exact In-scope block from a recorded 2026-07-14 dispatch prompt

## Context

- Evidence: conversation b64e6224 — 12/12 dispatch fires skipped path extraction
- Files: \`.claude/hooks/parallel-work-guard.ts\`, \`session_generate_prompt\` template source
- Parent: mt#2806. Related: mt#1637 (override/tier work), sibling duplicate-matcher task.
`;

  it("falls back to '## Context' backtick-path scan when '**In scope:**' is prose-only", () => {
    const result = extractInScopeFiles(mt2811RealSpec);
    expect(result.files).toContain(".claude/hooks/parallel-work-guard.ts");
    // The original strict-parse failure warning is still present (diagnostic
    // continuity), PLUS a warning documenting the fallback strategy used.
    expect(result.warnings.some((w) => /Could not extract file paths/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /Context.*backtick-path scan/.test(w))).toBe(true);
    // mt#2811 R1 (PR #1953 review, BLOCKING #3): the fallback RECOVERED files
    // (check still runs), so this is NOT a genuine failure — must not be
    // reported as a guard degradation.
    expect(result.genuineExtractionFailure).toBeFalsy();
  });

  it("falls back to a whole-spec backtick scan when '## Context' has no backtick paths", () => {
    const spec = `## Scope

**In scope:** some prose description of the work, no literal file list.
**Out of scope:** nothing relevant.

## Context

- Related to mt#1999, no code paths named here.
- See the \`renderScopeSection\` helper for background.
`;
    const result = extractInScopeFiles(spec);
    // "renderScopeSection" has no `/` and doesn't start with `.` — filtered
    // out as non-path noise, so this spec has NO backtick path anywhere.
    expect(result.files).toEqual([]);
    expect(result.warnings.some((w) => /no extractable file references/i.test(w))).toBe(true);
    // GENUINE failure: a '**In scope:**' block was located, but neither the
    // block itself nor either fallback strategy recovered anything.
    expect(result.genuineExtractionFailure).toBe(true);
  });

  it("emits a LOUD, specific degradation message when nothing is extractable anywhere", () => {
    const spec = `## Summary

A task with no file references at all.

## Scope

**In scope:** general improvements to the reliability of the thing.
**Out of scope:** nothing specific.
`;
    const result = extractInScopeFiles(spec);
    expect(result.files).toEqual([]);
    const terminal = result.warnings[result.warnings.length - 1] ?? "";
    // mt#2811 success criterion #3: states WHAT could not be checked and WHY.
    expect(terminal).toMatch(/In scope.*bullet list/);
    expect(terminal).toMatch(/Context/);
    expect(terminal).toMatch(/whole-document backtick scan/);
    expect(terminal).toMatch(/SKIPPED/);
    expect(result.genuineExtractionFailure).toBe(true);
  });

  it("still prefers the strict bullet-list extraction when both a bullet list AND prose exist", () => {
    // Back-compat: a spec that DOES use the original mt#1362 bullet-list
    // convention must not be routed through the fallback chain.
    const spec = `## Scope

**In scope:**
- \`src/domain/foo.ts\`
- \`src/domain/bar.ts\`

**Out of scope:**
- nothing
`;
    const result = extractInScopeFiles(spec);
    expect(result.warnings).toHaveLength(0);
    expect(result.files).toEqual(["src/domain/foo.ts", "src/domain/bar.ts"]);
    expect(result.genuineExtractionFailure).toBeUndefined();
  });

  // mt#2811 R1 (PR #1953 review, BLOCKING #3): the ROUTINE case — a spec with
  // NO scope structure at all (no '## Scope' section). This is the class the
  // review specifically wants QUIET (stdout), not reported as a genuine
  // extraction failure — the guard has always tolerated this gracefully, and
  // it is NOT the mt#2811 regression (that was a `**In scope:**` block that
  // failed to yield paths, not the absence of a Scope section entirely).
  it("does NOT mark the routine 'no ## Scope section at all' case as a genuine failure", () => {
    const spec = `## Summary

A minimal task with no Scope section whatsoever.
`;
    const result = extractInScopeFiles(spec);
    expect(result.files).toEqual([]);
    expect(result.genuineExtractionFailure).toBeFalsy();
  });

  it("does NOT mark the routine '## Scope present but no In-scope sub-block' case as a genuine failure", () => {
    const spec = `## Scope

This section has no bold In scope header at all, just prose.

## Next Section
`;
    const result = extractInScopeFiles(spec);
    expect(result.files).toEqual([]);
    expect(result.genuineExtractionFailure).toBeFalsy();
  });

  // mt#2811 R1 (PR #1953 review, NON-BLOCKING #4): the '## Context' backtick
  // fallback must not capture URLs or CLI-flag-shaped tokens as file paths.
  it("excludes URL and CLI-flag-shaped backtick tokens from the Context-section fallback", () => {
    const spec = `## Scope

**In scope:** prose description, no bullet list.
**Out of scope:** nothing.

## Context

- See \`https://example.com/some/path\` for background.
- Run with \`--foo/bar\` to reproduce.
- Files: \`src/domain/real-file.ts\`
`;
    const result = extractInScopeFiles(spec);
    expect(result.files).toEqual(["src/domain/real-file.ts"]);
    expect(result.files).not.toContain("https://example.com/some/path");
    expect(result.files).not.toContain("--foo/bar");
  });
});

// ---------------------------------------------------------------------------
// shouldReportAsGuardDegraded (mt#2811 R1 — PR #1953 review 4708851338 BLOCKING #3)
//
// The single decision point the hook entrypoint consults to choose stderr
// ("GUARD DEGRADED") vs stdout (routine). Tested directly as a literal proxy
// for "would this write to stderr" — the entrypoint's actual process.stderr
// write is a thin, untested-by-design side effect gated on exactly this
// boolean (matching the existing pattern for the rest of this hook's I/O).
// ---------------------------------------------------------------------------

describe("shouldReportAsGuardDegraded (mt#2811 R1)", () => {
  function resolved(overrides: Partial<ResolvedInScopeFiles>): ResolvedInScopeFiles {
    return { files: [], warnings: [], source: "spec-parse", ...overrides };
  }

  it("is LOUD when the spec CLI fetch itself failed", () => {
    expect(shouldReportAsGuardDegraded(resolved({ source: "spec-fetch-failed" }))).toBe(true);
  });

  it("is LOUD when the parser found an In-scope block but extracted nothing (genuine failure)", () => {
    expect(
      shouldReportAsGuardDegraded(
        resolved({ source: "spec-parse", genuineExtractionFailure: true })
      )
    ).toBe(true);
  });

  it("is QUIET (routine, no stderr) when the spec simply has no scope structure at all", () => {
    expect(
      shouldReportAsGuardDegraded(
        resolved({ source: "spec-parse", genuineExtractionFailure: false })
      )
    ).toBe(false);
    expect(
      shouldReportAsGuardDegraded(
        resolved({ source: "spec-parse", genuineExtractionFailure: undefined })
      )
    ).toBe(false);
  });

  it("is QUIET for a dispatch-scope-param resolution (not a parse path at all)", () => {
    expect(
      shouldReportAsGuardDegraded(resolved({ source: "dispatch-scope-param", files: ["a.ts"] }))
    ).toBe(false);
  });

  it("routine no-scope-anywhere resolution end to end: extractInScopeFiles -> resolveInScopeFiles -> not degraded", () => {
    // mt#2811 R1 acceptance: "Add a test for the routine-no-scope case
    // asserting no stderr" — this exercises the FULL chain a real
    // tasks_dispatch call with a bare, scope-free spec would take.
    const fetchNoScopeSpec = () => "## Summary\n\nA task with nothing scope-shaped in it.\n";
    const result = resolveInScopeFiles(
      DISPATCH_TOOL_NAME,
      { taskId: "mt#1" },
      fetchNoScopeSpec,
      "mt#1"
    );
    expect(result.files).toEqual([]);
    expect(shouldReportAsGuardDegraded(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveInScopeFiles (mt#2811)
// ---------------------------------------------------------------------------

describe("resolveInScopeFiles (mt#2811)", () => {
  const alwaysFailSpec = () => null;
  const specWithFiles = () => "## Scope\n\n**In scope:**\n- `src/a.ts`\n\n**Out of scope:**\n";

  it("prefers tasks_dispatch's own 'scope' parameter over spec parsing", () => {
    const result = resolveInScopeFiles(
      DISPATCH_TOOL_NAME,
      { taskId: "mt#1", scope: "src/a.ts, src/b.ts" },
      alwaysFailSpec, // proves the spec fetcher is never even consulted
      "mt#1"
    );
    expect(result.source).toBe("dispatch-scope-param");
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.warnings).toHaveLength(0);
  });

  it("falls back to spec parsing when tasks_dispatch omits 'scope'", () => {
    const result = resolveInScopeFiles(
      DISPATCH_TOOL_NAME,
      { taskId: "mt#1" },
      specWithFiles,
      "mt#1"
    );
    expect(result.source).toBe("spec-parse");
    expect(result.files).toEqual(["src/a.ts"]);
  });

  it("always uses spec parsing for session_start (no 'scope' param exists on that tool)", () => {
    const result = resolveInScopeFiles(
      "mcp__minsky__session_start",
      { task: "mt#1", scope: "src/a.ts" }, // even if somehow present, ignored
      specWithFiles,
      "mt#1"
    );
    expect(result.source).toBe("spec-parse");
  });

  it("reports spec-fetch-failed with a specific warning when the spec CLI call fails", () => {
    const result = resolveInScopeFiles(
      DISPATCH_TOOL_NAME,
      { taskId: "mt#1" },
      alwaysFailSpec,
      "mt#1"
    );
    expect(result.source).toBe("spec-fetch-failed");
    expect(result.files).toEqual([]);
    expect(result.warnings[0]).toMatch(/Could not fetch spec for mt#1/);
  });

  it("treats an empty 'scope' string the same as absent (falls back to spec parsing)", () => {
    const result = resolveInScopeFiles(
      DISPATCH_TOOL_NAME,
      { taskId: "mt#1", scope: "   " },
      specWithFiles,
      "mt#1"
    );
    expect(result.source).toBe("spec-parse");
  });

  // mt#2811 R1 (PR #1953 review, BLOCKING #3): genuineExtractionFailure must
  // propagate from extractInScopeFiles through to the resolved result, since
  // that is what shouldReportAsGuardDegraded consults.
  it("propagates genuineExtractionFailure=true from a real extraction failure", () => {
    const fetchGenuineFailureSpec = () =>
      "## Scope\n\n**In scope:** prose only, no bullet list.\n**Out of scope:** nothing.\n";
    const result = resolveInScopeFiles(
      DISPATCH_TOOL_NAME,
      { taskId: "mt#1" },
      fetchGenuineFailureSpec,
      "mt#1"
    );
    expect(result.source).toBe("spec-parse");
    expect(result.files).toEqual([]);
    expect(result.genuineExtractionFailure).toBe(true);
  });

  it("propagates a falsy genuineExtractionFailure for the routine no-scope-section case", () => {
    const fetchNoScopeSpec = () => "## Summary\n\nNo scope section at all.\n";
    const result = resolveInScopeFiles(
      DISPATCH_TOOL_NAME,
      { taskId: "mt#1" },
      fetchNoScopeSpec,
      "mt#1"
    );
    expect(result.source).toBe("spec-parse");
    expect(result.files).toEqual([]);
    expect(result.genuineExtractionFailure).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// buildTasksChildrenArgv (mt#2811) — the actual CLI-invocation-shape bug fix
//
// mt#2811 root-caused "could not enumerate children of mt#2766" (4/9
// tasks_create fires) to fetchTaskChildren invoking the CLI with a bare
// POSITIONAL argument (`minsky tasks children <parent>`), which the CLI
// rejects outright: `tasks.children`'s parameter map declares taskId/task as
// OPTIONAL, so the bridge's auto first-required-param promotion never wires
// a positional slot for it (unlike every sibling tasks.* command) — verified
// live: `minsky tasks children mt#2806` -> exit 1, "error: too many
// arguments for 'children'. Expected 0 arguments but got 1." This test locks
// the fix (the `--task` flag form, confirmed live to succeed) so a future
// edit can't silently regress back to the positional form.
// ---------------------------------------------------------------------------

describe("buildTasksChildrenArgv (mt#2811)", () => {
  it("uses the --task flag form, not a bare positional argument", () => {
    const argv = buildTasksChildrenArgv("mt#2806");
    expect(argv).toEqual(["minsky", "tasks", "children", "--task", "mt#2806"]);
  });
});
