// Tests for the durable-artifact claim surface (mt#3642).
//
// Its own file rather than another block in code-mechanism-assertion-detector.
// test.ts: that file is at the 1500-line ESLint ceiling, and the tool-name
// literals here collide with its own under custom/no-magic-string-duplication.
//
// The originating incident (mt#3092): a false claim about postgres-js's socket
// contract was asserted in a PR BODY, the change shipped, and minsky-mcp went
// down. The detector produced NO calibration record for that turn — a PR body
// is a `tool_use` INPUT and the claim corpus was assistant chat text only, so
// the claim was never extracted. That is a different defect from backing
// precision (mt#3594), which operates on claims already extracted.

import { describe, test, expect } from "bun:test";
import {
  detectCodeMechanismAssertion,
  buildArtifactProseCorpus,
} from "./code-mechanism-assertion-detector";
import type { TranscriptLine } from "./transcript";

const PR_CREATE = "mcp__minsky__session_pr_create";
const SPEC_PATCH = "mcp__minsky__tasks_spec_patch";
const MEMORY_CREATE = "mcp__minsky__memory_create";
const ASKS_CREATE = "mcp__minsky__asks_create";
const WRITE_FILE = "mcp__minsky__session_write_file";
const TASKS_CREATE = "mcp__minsky__tasks_create";

/** The claim as it was actually written, verbatim from the mt#3092 PR body. */
const SOCKET_CLAIM =
  "**TLS composes.** postgres-js upgrades whatever socket the factory returns " +
  "(`connection.js` passes it into the tls options), so a plain socket is the " +
  "supported shape against the Supabase pooler.";

function artifactTurn(name: string, input: Record<string, unknown>): TranscriptLine[] {
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_a1", name, input }],
      },
    },
  ] as TranscriptLine[];
}

describe("durable-artifact surface (mt#3642)", () => {
  test("mt#3092 replay: the PR-body claim is collected and detected", () => {
    // A fixture, not the original transcript — it reproduces the payload SHAPE
    // (a `session_pr_create` body) carrying the claim's REAL text.
    const turn = artifactTurn(PR_CREATE, { title: "Bound the socket", body: SOCKET_CLAIM });

    expect(buildArtifactProseCorpus(turn)).toContain("postgres-js upgrades whatever socket");

    const result = detectCodeMechanismAssertion(buildArtifactProseCorpus(turn), "", "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("connection.js");
  });

  test("a same-turn read of the claimed symbol backs the claim", () => {
    // Backing works on this surface exactly as it does in chat prose — the
    // widening is of WHAT is scanned, not of what counts as verified.
    const turn = artifactTurn(PR_CREATE, { body: SOCKET_CLAIM });
    const backed = detectCodeMechanismAssertion(
      buildArtifactProseCorpus(turn),
      "if (options.socket) return ssl ? secure() : connected() // connection.js"
    );
    expect(backed.hadSameTurnRead).toBe(true);
  });

  test("the other artifact keys are collected: spec, memory content, ask question", () => {
    expect(buildArtifactProseCorpus(artifactTurn(SPEC_PATCH, { content: "a" }))).toBe("a");
    expect(buildArtifactProseCorpus(artifactTurn(MEMORY_CREATE, { content: "b" }))).toBe("b");
    expect(buildArtifactProseCorpus(artifactTurn(ASKS_CREATE, { question: "c" }))).toBe("c");
  });

  test("an ordinary source edit is NOT collected — that is the comment surface's job", () => {
    // `session_write_file` is write-class but not artifact-class. Without this
    // boundary the two surfaces would double-count every source edit.
    expect(buildArtifactProseCorpus(artifactTurn(WRITE_FILE, { content: SOCKET_CLAIM }))).toBe("");
  });

  test("a tool with no prose key contributes nothing", () => {
    expect(buildArtifactProseCorpus(artifactTurn(TASKS_CREATE, { title: "x" }))).toBe("");
  });

  // PR #2584 R1. `TranscriptLine` documents two shapes — "tool_use lines may
  // carry name/input at top level OR inside message.content" — and
  // `extractToolUseNames` has handled both since it was written. The first
  // draft of this corpus handled only the nested one, so a turn recorded in the
  // top-level shape was invisible to the surface with no test to say otherwise.
  describe("top-level tool_use lines (not just nested message.content blocks)", () => {
    function topLevelTurn(name: string, input: Record<string, unknown>): TranscriptLine[] {
      return [{ type: "tool_use", name, input }] as TranscriptLine[];
    }

    test("a top-level tool_use line is collected", () => {
      const turn = topLevelTurn(PR_CREATE, { body: SOCKET_CLAIM });
      expect(buildArtifactProseCorpus(turn)).toContain("postgres-js upgrades whatever socket");
    });

    test("the `tool_name` spelling is honored too", () => {
      // `extractToolUseNames` reads `name ?? tool_name`; both spellings occur.
      const turn = [{ type: "tool_use", tool_name: SPEC_PATCH, input: { content: "a" } }];
      expect(buildArtifactProseCorpus(turn as TranscriptLine[])).toBe("a");
    });

    test("a top-level non-artifact tool is still excluded", () => {
      expect(buildArtifactProseCorpus(topLevelTurn(WRITE_FILE, { content: SOCKET_CLAIM }))).toBe(
        ""
      );
    });

    test("both shapes in one turn are collected and deduped", () => {
      const turn = [
        { type: "tool_use", name: PR_CREATE, input: { body: "shared" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: SPEC_PATCH, input: { content: "shared" } },
              { type: "tool_use", id: "t2", name: MEMORY_CREATE, input: { content: "other" } },
            ],
          },
        },
      ];
      expect(
        buildArtifactProseCorpus(turn as TranscriptLine[])
          .split("\n")
          .sort()
      ).toEqual(["other", "shared"]);
    });
  });
});

// mt#4525 — `tasks_edit` was absent from ARTIFACT_TOOL_RE entirely, so a claim
// written through it reached this corpus through NEITHER of its two body paths.
// Found in the failure it caused: `tasks_spec_patch` timed out twice during the
// mt#4489 session, every subsequent spec write was routed through `tasks edit`,
// and two of them carried a false mechanism claim nothing could see.
describe("tasks_edit write paths (mt#4525)", () => {
  const TASKS_EDIT = "mcp__minsky__tasks_edit";

  /** The real claim that rode through the uncovered channel (filed as mt#4523). */
  const LINT_CLAIM =
    "Reconciling with `no-dynamic-imports` (`eslint.config.js` sets " +
    "`allowDynamicImports: false`), production dynamic imports are already linted.";

  test("a claim written inline via specContent reaches the corpus", () => {
    const turn = artifactTurn(TASKS_EDIT, { taskId: "mt#4523", specContent: LINT_CLAIM });
    expect(buildArtifactProseCorpus(turn)).toContain("allowDynamicImports");
  });

  test("end-to-end: a claim written via tasks_edit is DETECTED, not just collected", () => {
    // Uses the mt#3092 socket claim rather than the lint one because this asserts
    // through the recognizer, and only the corpus half is this task's subject —
    // which claim SHAPES are recognized is a separate axis (mt#3775 owns it, and
    // this spec's `## Scope` puts it out of scope). Pairing them here keeps the
    // corpus assertion above from being the only evidence: the widened surface
    // reaches the detector, not merely a string set.
    const turn = artifactTurn(TASKS_EDIT, { taskId: "mt#3092", specContent: SOCKET_CLAIM });
    const result = detectCodeMechanismAssertion(buildArtifactProseCorpus(turn), "", "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("connection.js");
  });

  test("a claim written BY REFERENCE via specFile reaches the corpus", () => {
    // The reader is INJECTED rather than writing a real file: the branch under
    // test is "a named path's contents become corpus prose", and a real write
    // would test the filesystem instead (`custom/no-real-fs-in-tests`).
    const turn = artifactTurn(TASKS_EDIT, { taskId: "mt#4523", specFile: "spec.md" });
    const reads: string[] = [];
    const corpus = buildArtifactProseCorpus(turn, (p) => {
      reads.push(p);
      return LINT_CLAIM;
    });

    expect(corpus).toContain("allowDynamicImports");
    // The path actually reached the reader — without this the assertion above
    // would pass against a corpus that ignored `specFile` and got the text some
    // other way.
    expect(reads).toEqual(["spec.md"]);
  });

  test("a specFile OUTSIDE the repo is not read (mt#4295 SC4)", () => {
    // A PreToolUse observer runs against arbitrary tool input; it must not become
    // a read primitive for an arbitrary path. The reference implementation this
    // was extracted from did NOT have this check.
    const turn = artifactTurn(TASKS_EDIT, { taskId: "mt#4523", specFile: "/etc/hosts" });
    expect(buildArtifactProseCorpus(turn)).toBe("");
  });

  test("a specFile that does not exist contributes nothing and does not throw", () => {
    const turn = artifactTurn(TASKS_EDIT, {
      taskId: "mt#4523",
      specFile: ".minsky/hooks/__fixtures__/mt4525-absent.md",
    });
    expect(buildArtifactProseCorpus(turn)).toBe("");
  });

  test("tasks_edit's boolean `spec` flag is not read as prose", () => {
    // `spec` IS in ARTIFACT_PROSE_INPUT_KEYS (it is tasks_create's body), but on
    // tasks_edit the same name is a boolean flag. PR #3063 R1 conflated the two on
    // the sibling detector; the typeof guard is what keeps it from mattering here.
    const turn = artifactTurn(TASKS_EDIT, { taskId: "mt#4523", spec: true });
    expect(buildArtifactProseCorpus(turn)).toBe("");
  });
});

// mt#4534 — a git-tracked repo FILE (an ADR, a rule, a doc) reached NO claim
// corpus, because coverage was enumerated by TOOL NAME over Minsky entity
// writers and a repo file is written by a different tool set entirely. A
// different artifact CLASS, not a missing name — so it is gated on the written
// PATH, since `Write` also writes ordinary source.
//
// Found in the failure it caused (2026-08-24): while amending
// docs/architecture/adr-006-agent-identity.md SPECIFICALLY to correct an
// unverified stale claim, a NEW unverified claim went into the same edit. No
// detector surface existed at all.
describe("durable repo-file writes (mt#4534)", () => {
  const WRITE = "Write";
  const EDIT = "Edit";
  const SEARCH_REPLACE = "mcp__minsky__session_search_replace";
  const EDIT_FILE = "mcp__minsky__session_edit_file";
  const BASH = "Bash";
  const ADR_PATH = "docs/architecture/adr-006-agent-identity.md";
  /** An ordinary source file — write-class, but not a decision record. */
  const SOURCE_PATH = "src/domain/session/socket.ts";
  /** A compile OUTPUT: matches the durable path set on extension, but is a projection. */
  const COMPILED_PATH = "CLAUDE.md";
  const BANNER = "<!-- Generated by minsky rules compile. Do not edit directly. -->";

  /** A turn whose write REPORTS having created the file it targeted. */
  function createdTurn(name: string, input: Record<string, unknown>): TranscriptLine[] {
    return [
      ...artifactTurn(name, input),
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_a1",
              content: JSON.stringify({ created: true }),
            },
          ],
        },
      },
    ] as TranscriptLine[];
  }

  test("AT1: a claim edited into an ADR reaches the corpus and is DETECTED", () => {
    const turn = artifactTurn(EDIT, {
      file_path: ADR_PATH,
      old_string: "## Verification",
      new_string: SOCKET_CLAIM,
    });

    expect(buildArtifactProseCorpus(turn)).toContain(SOCKET_CLAIM);

    // Through the recognizer, not merely into a string set — the same pairing
    // the mt#4525 block makes, and for the same reason: only the corpus half is
    // this task's subject, so asserting collection alone would leave the widened
    // surface untested where it actually has to land.
    const result = detectCodeMechanismAssertion(buildArtifactProseCorpus(turn), "", "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("connection.js");
  });

  test("AT1 negative control: the same claim reached nothing pre-fix", () => {
    // The pre-fix builder read the tool NAME only and never looked at a path, so
    // its corpus for the fixture above was identical to its corpus for the same
    // call with no path at all — which is what this asserts. `Edit` is not in
    // ARTIFACT_TOOL_RE, so pre-fix there was no branch that could admit it.
    //
    // The stronger control — these tests run against the un-fixed tree and FAIL
    // — is in the PR body, where reverting the implementation is possible.
    const control = artifactTurn(EDIT, { old_string: "x", new_string: SOCKET_CLAIM });
    expect(buildArtifactProseCorpus(control)).toBe("");
  });

  test("a NEW doc written whole-file is collected", () => {
    const turn = createdTurn(WRITE, { file_path: ADR_PATH, content: SOCKET_CLAIM });
    expect(buildArtifactProseCorpus(turn)).toContain(SOCKET_CLAIM);
  });

  test("OVERWRITING an existing doc is NOT collected — the documented carve-out", () => {
    // Same payload, no `created` on the result. Every paragraph of a rewritten
    // doc arrives in the payload, and scanning them would re-flag prose the
    // agent is not asserting now (mem#719). The cost is stated in the builder:
    // a claim ADDED during an overwrite is not covered, because the payload
    // carries no before-image to subtract.
    const turn = artifactTurn(WRITE, { file_path: ADR_PATH, content: SOCKET_CLAIM });
    expect(buildArtifactProseCorpus(turn)).toBe("");
  });

  test("a targeted edit needs no `created` flag — its payload IS the new text", () => {
    const turn = artifactTurn(SEARCH_REPLACE, {
      path: ".minsky/rules/claim-confidence.mdc",
      search: "old",
      replace: SOCKET_CLAIM,
    });
    expect(buildArtifactProseCorpus(turn)).toContain(SOCKET_CLAIM);
  });

  test("session_edit_file's partial payload is not misread as a whole-file write", () => {
    // Its edit pattern rides under `content`, which is also a whole-file key —
    // so classifying by KEY (as the comment corpus does) would gate every such
    // call on a `created` flag it never carries, and the surface would be
    // silently empty for the tool. The marker is what makes this the partial
    // shape; the marker-less and fullReplace cases are covered below.
    const turn = artifactTurn(EDIT_FILE, {
      path: ADR_PATH,
      instructions: "Amend the verification section",
      content: `// ... existing code ...\n${SOCKET_CLAIM}\n// ... existing code ...`,
    });
    expect(buildArtifactProseCorpus(turn)).toContain(SOCKET_CLAIM);
  });

  test("AT2: a write to a non-durable path contributes nothing", () => {
    const scratch = artifactTurn(WRITE, {
      file_path: "/tmp/scratch/notes.txt",
      content: SOCKET_CLAIM,
    });
    expect(buildArtifactProseCorpus(scratch)).toBe("");

    // Nor does a source file — that claim belongs to the comment surface.
    const source = artifactTurn(EDIT, {
      file_path: SOURCE_PATH,
      old_string: "a",
      new_string: SOCKET_CLAIM,
    });
    expect(buildArtifactProseCorpus(source)).toBe("");
  });

  test("a compiled output is excluded when the PAYLOAD carries the banner", () => {
    // CLAUDE.md and .cursor/rules/*.mdc are projections of a source rule, not
    // claims authored at that path; admitting one would enter the whole rule
    // corpus as a fresh assertion on every regeneration. Recognised by the
    // shared generation banner (mt#1798), not by a path list that could drift.
    const turn = createdTurn(WRITE, {
      file_path: COMPILED_PATH,
      content: `${BANNER}\n\n${SOCKET_CLAIM}`,
    });
    expect(buildArtifactProseCorpus(turn)).toBe("");
  });

  test("a TARGETED edit into a compiled output is excluded via the target file (PR #3328 R1)", () => {
    // The payload of a search-replace is a fragment and carries no banner however
    // generated the file it lands in, so checking the payload alone let this
    // through. The target file's own head answers it — read through the injected
    // reader, which is also what proves the read actually happened.
    const turn = artifactTurn(SEARCH_REPLACE, {
      path: COMPILED_PATH,
      search: "old",
      replace: SOCKET_CLAIM,
    });
    const reads: string[] = [];
    const corpus = buildArtifactProseCorpus(turn, (p) => {
      reads.push(p);
      return `${BANNER}\n\n# Some compiled rule text`;
    });

    expect(corpus).toBe("");
    expect(reads).toEqual([COMPILED_PATH]);
  });

  test("a targeted edit into a NON-generated durable doc is still collected", () => {
    // The other side of the same branch: a reader that reports no banner must not
    // suppress. Without this, a reader returning anything at all would look like
    // a passing exclusion test.
    const turn = artifactTurn(SEARCH_REPLACE, {
      path: ADR_PATH,
      search: "old",
      replace: SOCKET_CLAIM,
    });
    expect(buildArtifactProseCorpus(turn, () => "## Context\n\nNo banner here.")).toContain(
      SOCKET_CLAIM
    );
  });

  test("session_edit_file with fullReplace is gated like a whole-file write (PR #3328 R1)", () => {
    // `session_edit_file` is the only dual-shape writer: `fullReplace: true`
    // replaces the whole file, so classifying the TOOL as targeted let a full
    // overwrite of an existing ADR skip the `created` gate and re-flag every
    // paragraph in it.
    const turn = artifactTurn(EDIT_FILE, {
      path: ADR_PATH,
      instructions: "Replace the document",
      content: SOCKET_CLAIM,
      fullReplace: true,
    });
    expect(buildArtifactProseCorpus(turn)).toBe("");

    // ...and IS collected when the same call reports having created the file.
    const created = createdTurn(EDIT_FILE, {
      path: ADR_PATH,
      instructions: "Create the document",
      content: SOCKET_CLAIM,
      fullReplace: true,
    });
    expect(buildArtifactProseCorpus(created)).toContain(SOCKET_CLAIM);
  });

  test("marker-less session_edit_file content is whole-file, per the domain's own test", () => {
    // `session-file-edit-operation.ts` branches on `hasExistingCodeMarkers`:
    // marker-less content is a full write (refused against an existing file
    // unless `fullReplace`), marked content is a partial edit. This reuses that
    // predicate rather than restating it, so the two cannot drift.
    const markerless = artifactTurn(EDIT_FILE, {
      path: ADR_PATH,
      instructions: "Rewrite",
      content: SOCKET_CLAIM,
    });
    expect(buildArtifactProseCorpus(markerless)).toBe("");

    const marked = artifactTurn(EDIT_FILE, {
      path: ADR_PATH,
      instructions: "Amend one section",
      content: `// ... existing code ...\n${SOCKET_CLAIM}\n// ... existing code ...`,
    });
    expect(buildArtifactProseCorpus(marked)).toContain(SOCKET_CLAIM);
  });

  test("AT3: the Bash channel contributes nothing — the recorded SC2 disposition", () => {
    // Deliberate, not an oversight: mt#4536 owns the CLI/Bash surface for all
    // five guards blind to it and decides the mechanism once. Asserted here so
    // the disposition is a fact about the code rather than a claim in prose —
    // if a later change starts reading Bash here, this test says so.
    const turn = artifactTurn(BASH, {
      command: `cat > ${ADR_PATH} <<'EOF'\n${SOCKET_CLAIM}\nEOF`,
    });
    expect(buildArtifactProseCorpus(turn)).toBe("");
  });

  test("the entity surface is unchanged by the widening", () => {
    // AT4 in miniature: the two classes are independent branches, so a PR body
    // still reaches the corpus with no path involved at all.
    expect(buildArtifactProseCorpus(artifactTurn(PR_CREATE, { body: "entity prose" }))).toBe(
      "entity prose"
    );
  });
});
