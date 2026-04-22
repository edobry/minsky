/**
 * Derivation-Discipline Validator Tests
 *
 * Covers the checkDerivation() heuristics: positive detections per category
 * and negative (clean) cases that should pass through without an issue.
 */

import { describe, test, expect } from "bun:test";
import {
  checkDerivation,
  type DerivationIssue,
} from "../../../../../src/adapters/shared/commands/memory/derivation-validator";

// ─── Helper ──────────────────────────────────────────────────────────────────

function expectIssue(content: string, source: DerivationIssue["source"]): void {
  const result = checkDerivation(content);
  expect(result).not.toBeNull();
  expect(result?.source).toBe(source);
}

function expectClean(content: string): void {
  const result = checkDerivation(content);
  expect(result).toBeNull();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("checkDerivation", () => {
  // ── Code heuristic ──────────────────────────────────────────────────────────

  describe("code source", () => {
    test("flags 'The file X ...' content", () => {
      expectIssue("The file src/bar.ts does X", "code");
    });

    test("flags 'The function foo ...' content", () => {
      expectIssue("The function foo in src/bar.ts handles Y", "code");
    });

    test("flags 'The class Foo ...' content", () => {
      expectIssue("The class MemoryService exports the search method", "code");
    });

    test("flags 'The method bar ...' content", () => {
      expectIssue("The method create() inserts a row into the memories table", "code");
    });

    test("flags 'The variable X ...' content", () => {
      expectIssue("The variable result holds the array of search hits", "code");
    });

    test("flags 'The constant FOO ...' content", () => {
      expectIssue("The constant MEMORY_TYPES enumerates valid type values", "code");
    });

    test("flags 'The type X ...' content (TypeScript type)", () => {
      expectIssue("The type MemoryRecord has a supersededBy field", "code");
    });

    test("flags 'The interface X ...' content", () => {
      expectIssue("The interface MemoryServiceDb narrows Drizzle DB usage", "code");
    });

    test("is case-insensitive (uppercase THE)", () => {
      expectIssue("THE FILE src/domain/memory/types.ts exports MemoryRecord", "code");
    });

    test("passes 'This file ...' (wrong prefix)", () => {
      expectClean("This file is a reference to earlier work on embeddings");
    });

    test("passes content that mentions functions without the trigger prefix", () => {
      expectClean("Learned that using generateEmbedding inside create() avoids duplicate work");
    });
  });

  // ── Git-commit heuristic ────────────────────────────────────────────────────

  describe("git (commit) source", () => {
    test("flags 'The commit <hash> ...' with 7-char hash", () => {
      expectIssue("The commit a1b2c3d introduced the memory schema", "git");
    });

    test("flags 'The commit <hash> ...' with 40-char hash", () => {
      expectIssue(
        "The commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 merged the provenance PR",
        "git"
      );
    });

    test("passes 'The commit message was ...' (no hash)", () => {
      // No hash follows 'The commit', so it doesn't match the pattern
      expectClean("The commit message was well-structured");
    });
  });

  // ── Git-output heuristic ────────────────────────────────────────────────────

  describe("git (output) source", () => {
    test("flags 'Git log shows ...'", () => {
      expectIssue("Git log shows 3 recent commits on the main branch", "git");
    });

    test("flags 'Git blame says ...'", () => {
      expectIssue("Git blame says edobry last touched this line in 2025", "git");
    });

    test("flags 'Git status output ...'", () => {
      expectIssue("Git status output lists two modified files", "git");
    });

    test("flags 'Git diff shows ...'", () => {
      expectIssue("Git diff shows a net addition of 42 lines", "git");
    });

    test("is case-insensitive", () => {
      expectIssue("GIT LOG SHOWS five commits since last release", "git");
    });

    test("passes 'Git is a version control system'", () => {
      expectClean("Git is a version control system used for tracking changes");
    });
  });

  // ── Task heuristic ──────────────────────────────────────────────────────────

  describe("task source", () => {
    test("flags 'Task mt#NNN status ...'", () => {
      expectIssue("Task mt#1007 status is IN-PROGRESS", "task");
    });

    test("flags 'Task md#NNN spec ...'", () => {
      expectIssue("Task md#42 spec describes the MCP command surface", "task");
    });

    test("flags 'Task gh#NNN title ...'", () => {
      expectIssue("Task gh#999 title is 'Memory Phase 1'", "task");
    });

    test("task heuristic matches regardless of case", () => {
      expectIssue("TASK MT#1007 STATUS is ready", "task");
    });

    test("passes 'The task was completed yesterday'", () => {
      expectClean("The task was completed yesterday without any blockers");
    });

    test("passes 'Task mt#123 was interesting' (no keyword after id)", () => {
      expectClean("Task mt#123 was interesting because of the new approach");
    });
  });

  // ── Rule heuristic ──────────────────────────────────────────────────────────

  describe("rule source", () => {
    test("flags 'Rule X says ...'", () => {
      expectIssue("Rule no-unsafe-any says to avoid implicit any types", "rule");
    });

    test("flags 'Rule \"X\" says ...' (quoted name)", () => {
      expectIssue('Rule "no-console" says console calls are forbidden in prod', "rule");
    });

    test("flags \"Rule 'X' says ...\" (single-quoted name)", () => {
      expectIssue("Rule 'max-lines' says files must not exceed 400 lines", "rule");
    });

    test("rule heuristic matches regardless of case", () => {
      expectIssue("RULE eslint-plugin says do not use var", "rule");
    });

    test("passes 'Rules exist for a reason'", () => {
      expectClean("Rules exist for a reason — they encode hard-won lessons");
    });
  });

  // ── Fenced-block ratio heuristic ────────────────────────────────────────────

  describe("quoted source (fenced ratio)", () => {
    test("flags content that is >90% fenced code", () => {
      // Preamble is very short; the block takes up ~95% of characters.
      const content = `x\n\`\`\`\n${"a".repeat(200)}\n\`\`\``;
      expectIssue(content, "quoted");
    });

    test("does not flag content with ~50% fenced code", () => {
      const prose = "a".repeat(100);
      const code = "b".repeat(100);
      const content = `${prose}\n\`\`\`\n${code}\n\`\`\``;
      expectClean(content);
    });

    test("does not flag content with no fenced blocks", () => {
      expectClean(
        "Learned that edobry prefers double quotes and 2-space indentation in TypeScript"
      );
    });

    test("does not flag content with exactly 0% fenced code (empty string edge case)", () => {
      expectClean("");
    });
  });

  // ── Clean cases (no issue) ──────────────────────────────────────────────────

  describe("clean content passes all heuristics", () => {
    test("plain preference memory", () => {
      expectClean(
        "edobry prefers strict TypeScript with no implicit any. Always enable strict mode."
      );
    });

    test("feedback memory", () => {
      expectClean(
        "Subagents should commit incrementally so failures are recoverable at each stage."
      );
    });

    test("cross-project insight", () => {
      expectClean(
        "When working with Drizzle ORM, narrow DB interfaces prevent unsafe casts in tests."
      );
    });

    test("user profile fact", () => {
      expectClean(
        "edobry values clean architecture and will ask for rework if layers are violated."
      );
    });
  });
});
