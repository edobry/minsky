#!/usr/bin/env bun
// PostToolUse hook: Validate task spec structure after tasks_create
//
// Blocks task creation if the spec content is missing required sections.
// Short specs (under 100 chars) pass through — not all tasks need full structure.
//
// Required sections: ## Success Criteria, ## Acceptance Tests

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";

const input = await readInput<ToolHookInput>();

// Get spec content from the tool input (spec or deprecated description alias)
const specContent =
  (input.tool_input.spec as string | undefined) ??
  (input.tool_input.description as string | undefined) ??
  "";

// Short specs pass through — quick tasks don't need full structure
if (specContent.length < 100) {
  process.exit(0);
}

// Check for required sections
const missingHeadings: string[] = [];

if (!/^## Success Criteria/m.test(specContent)) {
  missingHeadings.push("## Success Criteria");
}

if (!/^## Acceptance Tests/m.test(specContent)) {
  missingHeadings.push("## Acceptance Tests");
}

if (missingHeadings.length > 0) {
  const title = (input.tool_input.title as string) ?? "unknown";
  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [
        `⚠️ Task "${title}" spec is missing required sections: ${missingHeadings.join(", ")}`,
        "",
        "Task specs over 100 chars must include:",
        "  - ## Success Criteria — measurable criteria for task completion",
        "  - ## Acceptance Tests — concrete tests to verify the work",
        "",
        "Please update the task spec with the missing sections using tasks_spec_edit.",
      ].join("\n"),
    },
  });
  process.exit(1);
}

process.exit(0);
