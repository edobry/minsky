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
    // mt#3381: same rationale as the reviewer agent — this agent runs read-only
    // git commands via Bash to verify an implementation against a spec, and
    // `block-git-gh-cli` denies them while naming replacements it does not hold.
    // Read-only only; no mutation tool is added.
    "mcp__minsky__git_log",
    "mcp__minsky__git_diff",
    "mcp__minsky__git_status",
    // mt#3401: see the reviewer agent — same missed read-only command.
    "mcp__minsky__git_blame",
    "mcp__minsky__tasks_get",
    "mcp__minsky__tasks_spec_get",
    "mcp__github__get_file_contents",
  ],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
