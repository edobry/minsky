import { defineAgent, loadMarkdown } from "../../../src/domain/definitions/factories";

export default defineAgent({
  name: "cockpit-dev",
  description:
    "Frontend engineering and design for the Cockpit mission-control web app (src/cockpit/**): React + Tailwind + shadcn/ui + TanStack Query stack with Minsky-domain IA. Use when implementing or redesigning Cockpit widgets, applying the design + engineering + IA bundle, or rebuilding widgets on the new stack.",
  model: "sonnet",
  skills: ["cockpit-design"],
  prompt: loadMarkdown(import.meta.dir, "prompt.md"),
});
