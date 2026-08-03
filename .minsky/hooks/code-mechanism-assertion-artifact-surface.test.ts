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
});
