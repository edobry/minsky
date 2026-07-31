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
    // mt#3381: the read-only git tools `block-git-gh-cli` redirects `git log` /
    // `git diff` / `git status` to. This agent's prompt documents Bash as being
    // in the allowlist precisely so it can run those commands; without these the
    // guard denies them and names replacements the agent does not hold, leaving
    // no legal path to PR history. All three are read-only — the allowlist still
    // omits every mutation tool (session_write_file, session_edit_file,
    // session_exec), which is what the Chinese-wall guarantee rests on.
    "mcp__minsky__git_log",
    "mcp__minsky__git_diff",
    "mcp__minsky__git_status",
    // mt#3401: `git blame` is the fourth read-only git command the guard denies;
    // mt#3401's generalized reachability test caught that mt#3381 missed it.
    "mcp__minsky__git_blame",
    "mcp__minsky__session_pr_review_context",
    "mcp__minsky__session_pr_review_submit",
    "mcp__minsky__tasks_spec_get",
    "mcp__github__get_file_contents",
  ],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
