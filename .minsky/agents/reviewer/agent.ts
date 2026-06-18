import { defineAgent, loadMarkdown } from "../../../packages/domain/src/definitions/factories";

export default defineAgent({
  name: "reviewer",
  description:
    "Code review agent for independent Chinese-wall reviews and large-PR diff sectioning. In Mode 2 (whole-PR), fetches context via MCP, validates anchors, and posts findings directly via mcp__minsky__session_pr_review_submit. In Mode 1 (sectioning), returns raw observations to the parent aggregator and MUST NOT call submit — the parent validates anchors and posts the final review. Cannot modify code — posting a GitHub review is an allowed write (Mode 2 only).",
  model: "sonnet",
  skills: [],
  tools: [
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "mcp__minsky__session_pr_review_context",
    "mcp__minsky__session_pr_review_submit",
    "mcp__minsky__tasks_spec_get",
    "mcp__github__get_file_contents",
  ],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
