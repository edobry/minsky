import { defineAgent, loadMarkdown } from "../../../packages/domain/src/definitions/factories";

export default defineAgent({
  name: "auditor",
  description:
    "Ad-hoc spec verification when explicitly requested: reads a task spec and verifies the implementation satisfies each acceptance criterion. Does not modify source code, but may run validation commands (tests, typechecks) via Bash. As of mt#1551, /verify-task no longer dispatches this agent on the standard closeout path — the reviewer subagent handles spec verification at review time. Use this agent for one-off audits, second-opinion verification, or non-PR spec checks against main.",
  model: "sonnet",
  skills: [],
  tools: [
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "mcp__minsky__tasks_get",
    "mcp__minsky__tasks_spec_get",
    "mcp__github__get_file_contents",
  ],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
