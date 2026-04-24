import { defineAgent, loadMarkdown } from "../../../src/domain/definitions/factories";

export default defineAgent({
  name: "cleaner",
  description:
    "Technical debt cleanup agent: fixes skipped tests, removes dead code, tidies imports, and addresses small structural issues. Less rigorous than refactorer — focused on low-risk hygiene.",
  model: "sonnet",
  skills: ["code-organization", "fix-skipped-tests"],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
