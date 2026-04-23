import { defineAgent, loadMarkdown } from "../../../src/domain/definitions/factories";

export default defineAgent({
  name: "reviewer",
  description:
    "Read-only code review agent for analyzing diff sections. Dispatched by the review-pr skill for large PRs (~25 files per agent). Verifies each change against the actual source before reporting findings. Cannot modify code.",
  model: "sonnet",
  skills: ["review-pr"],
  tools: ["Read", "Glob", "Grep", "Bash"],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
