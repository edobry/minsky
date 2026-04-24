import { defineAgent, loadMarkdown } from "../../../src/domain/definitions/factories";

export default defineAgent({
  name: "implementer",
  description:
    "Full-cycle implementation agent: reads spec, writes code and tests, commits incrementally, creates PR. Operates inside a Minsky session.",
  model: "sonnet",
  skills: ["implement-task", "prepare-pr", "testing-guide", "error-handling"],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
