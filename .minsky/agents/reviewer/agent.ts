import { defineAgent, loadMarkdown } from "../../../src/domain/definitions/factories";

export default defineAgent({
  name: "reviewer",
  description:
    "Code review agent for independent Chinese-wall reviews and large-PR diff sectioning. Fetches PR context via MCP, verifies each change against actual source, and posts findings directly via mcp__minsky__session_pr_review_submit. Cannot modify code — posting a GitHub review is an allowed write.",
  model: "sonnet",
  skills: ["review-pr"],
  tools: [
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "mcp__minsky__session_pr_review_context",
    "mcp__minsky__session_pr_review_submit",
    "mcp__minsky__tasks_spec_get",
  ],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
