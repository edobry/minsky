import { defineAgent, loadMarkdown } from "../../../src/domain/definitions/factories";

export default defineAgent({
  name: "refactorer",
  description:
    "Structural refactoring agent: improves code organization, naming, and module boundaries without altering behavior.",
  model: "sonnet",
  skills: ["code-organization", "testing-guide"],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
