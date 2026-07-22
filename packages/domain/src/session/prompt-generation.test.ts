/**
 * Prompt-generation `intent` variant tests (mt#2865, PR #2033 R1 BLOCKING #3)
 *
 * Pins what each generated prompt contains/omits across the three `intent`
 * states — absent (default), explicit `"implementation"`, and
 * `"read-only"` — closing the review finding that the read-only intent's
 * SILENT suppression of commit/PR instructions was underdocumented and
 * untested. `harness: "claude-code"` is passed throughout to skip the
 * standalone skill-loading path entirely (no filesystem access needed —
 * `planSkillSection` returns an empty section for the native harness).
 */

import { describe, test, expect } from "bun:test";
import {
  generateSubagentPrompt,
  ENVELOPE_HEADER,
  PROMPT_WATERMARK,
  type GeneratePromptParams,
} from "./prompt-generation";
import { DEFAULT_DISPATCH_MODEL_ID } from "../ai/dispatch-models";

const BASE_PARAMS: Omit<GeneratePromptParams, "type" | "intent"> = {
  sessionDir: "/Users/edobry/.local/state/minsky/sessions/mock-session-id",
  sessionId: "mock-session-id",
  taskId: "2865",
  instructions: "Search memory for X and report back under 300 words.",
  harness: "claude-code",
};

const COMMIT_SECTION_MARKER = "## Committing Your Work";
const CREATE_PR_SECTION_MARKER = "## Creating a Pull Request";
const READ_ONLY_BOUND_MARKER = "## Read-Only Dispatch Bound";
/** Distinguishing phrase unique to the readOnly=true Operating Envelope variant. */
const READ_ONLY_ENVELOPE_MARKER = "stop investigating new areas";
/** Distinguishing phrase unique to the readOnly=false (implementation) Operating Envelope variant. */
const IMPLEMENTATION_ENVELOPE_MARKER = "stop starting new work";

describe("generateSubagentPrompt — model threading (mt#3043)", () => {
  test("an explicit model is returned as suggestedModel", () => {
    const result = generateSubagentPrompt({
      ...BASE_PARAMS,
      type: "implementation",
      model: "fable",
    });
    expect(result.suggestedModel).toBe("fable");
  });

  test("omitting model falls back to the registry default, not a hardcoded literal", () => {
    const result = generateSubagentPrompt({ ...BASE_PARAMS, type: "implementation" });
    expect(result.suggestedModel).toBe(DEFAULT_DISPATCH_MODEL_ID);
  });

  test("the model is dispatch metadata only — it does not alter the prompt text", () => {
    const withFable = generateSubagentPrompt({
      ...BASE_PARAMS,
      type: "implementation",
      model: "fable",
    });
    const withoutModel = generateSubagentPrompt({ ...BASE_PARAMS, type: "implementation" });
    expect(withFable.prompt).toBe(withoutModel.prompt);
  });
});

describe("generateSubagentPrompt — intent absent vs explicit 'implementation'", () => {
  test("omitting intent produces a byte-identical prompt to explicit intent: 'implementation'", () => {
    const withoutIntent = generateSubagentPrompt({ ...BASE_PARAMS, type: "implementation" });
    const withExplicitImplementation = generateSubagentPrompt({
      ...BASE_PARAMS,
      type: "implementation",
      intent: "implementation",
    });
    expect(withoutIntent.prompt).toBe(withExplicitImplementation.prompt);
  });

  test("intent 'implementation' (type implementation): contains commit/PR instructions and the implementation envelope, omits the read-only-bound section", () => {
    const result = generateSubagentPrompt({
      ...BASE_PARAMS,
      type: "implementation",
      intent: "implementation",
    });
    expect(result.prompt).toContain(COMMIT_SECTION_MARKER);
    expect(result.prompt).toContain(CREATE_PR_SECTION_MARKER);
    expect(result.prompt).toContain(ENVELOPE_HEADER);
    expect(result.prompt).toContain(IMPLEMENTATION_ENVELOPE_MARKER);
    expect(result.prompt).not.toContain(READ_ONLY_ENVELOPE_MARKER);
    expect(result.prompt).not.toContain(READ_ONLY_BOUND_MARKER);
    expect(result.prompt).toContain(PROMPT_WATERMARK);
  });
});

describe("generateSubagentPrompt — intent 'read-only'", () => {
  test("type implementation + intent read-only: adds the read-only-bound section, OMITS commit/PR instructions, forces the read-only envelope", () => {
    const result = generateSubagentPrompt({
      ...BASE_PARAMS,
      type: "implementation",
      intent: "read-only",
    });
    expect(result.prompt).toContain(READ_ONLY_BOUND_MARKER);
    expect(result.prompt).not.toContain(COMMIT_SECTION_MARKER);
    expect(result.prompt).not.toContain(CREATE_PR_SECTION_MARKER);
    expect(result.prompt).toContain(READ_ONLY_ENVELOPE_MARKER);
    expect(result.prompt).not.toContain(IMPLEMENTATION_ENVELOPE_MARKER);
  });

  test("type refactor + intent read-only: still omits commit/PR instructions and adds the read-only-bound section", () => {
    const result = generateSubagentPrompt({
      ...BASE_PARAMS,
      type: "refactor",
      intent: "read-only",
    });
    expect(result.prompt).toContain(READ_ONLY_BOUND_MARKER);
    expect(result.prompt).not.toContain(COMMIT_SECTION_MARKER);
    expect(result.prompt).not.toContain(CREATE_PR_SECTION_MARKER);
    expect(result.prompt).toContain(READ_ONLY_ENVELOPE_MARKER);
  });

  test("type cleanup + intent read-only: still omits commit/PR instructions and adds the read-only-bound section", () => {
    const result = generateSubagentPrompt({
      ...BASE_PARAMS,
      type: "cleanup",
      intent: "read-only",
    });
    expect(result.prompt).toContain(READ_ONLY_BOUND_MARKER);
    expect(result.prompt).not.toContain(COMMIT_SECTION_MARKER);
    expect(result.prompt).not.toContain(CREATE_PR_SECTION_MARKER);
  });

  test("type review + intent read-only: additive — read-only-bound section appears alongside the existing review-only shape (which never had commit/PR instructions)", () => {
    const withoutIntent = generateSubagentPrompt({ ...BASE_PARAMS, type: "review" });
    const withReadOnlyIntent = generateSubagentPrompt({
      ...BASE_PARAMS,
      type: "review",
      intent: "read-only",
    });
    // Baseline: type "review" never had commit/PR instructions, with or without intent.
    expect(withoutIntent.prompt).not.toContain(COMMIT_SECTION_MARKER);
    expect(withReadOnlyIntent.prompt).not.toContain(COMMIT_SECTION_MARKER);
    // The read-only-bound section is a NEW addition only present when intent is explicitly declared.
    expect(withoutIntent.prompt).not.toContain(READ_ONLY_BOUND_MARKER);
    expect(withReadOnlyIntent.prompt).toContain(READ_ONLY_BOUND_MARKER);
  });

  test("omitOperatingEnvelope: true + intent read-only: no envelope of either shape, but the read-only-bound section still appears", () => {
    const result = generateSubagentPrompt({
      ...BASE_PARAMS,
      type: "implementation",
      intent: "read-only",
      omitOperatingEnvelope: true,
    });
    expect(result.prompt).toContain(READ_ONLY_BOUND_MARKER);
    expect(result.prompt).not.toContain(ENVELOPE_HEADER);
    expect(result.prompt).not.toContain(COMMIT_SECTION_MARKER);
  });
});
