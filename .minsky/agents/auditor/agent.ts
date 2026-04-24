import { defineAgent, loadMarkdown } from "../../../src/domain/definitions/factories";

export default defineAgent({
  name: "auditor",
  description:
    "Spec-verification agent: reads a task spec and verifies the implementation satisfies each acceptance criterion. Does not modify source code, but may run validation commands (tests, typechecks) via Bash. Routes to the verify-completion subagent type.",
  model: "sonnet",
  skills: [],
  tools: ["Read", "Glob", "Grep", "Bash", "mcp__minsky__tasks_get", "mcp__minsky__tasks_spec_get"],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
