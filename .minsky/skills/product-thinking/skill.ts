import { defineSkill, loadMarkdown } from "../../../packages/domain/src/definitions/factories";

export default defineSkill({
  name: "product-thinking",
  description:
    "First-principles method for principal-facing Minsky surfaces: derive what a surface SHOULD BE from the principal's supervision loop (triage/decide/steer/verify), not dashboard convention. Use when designing, auditing, or critiquing a surface, comparing one against another tool or surface, or deciding what it should adopt. Above /cockpit-design and /minsky-brand.",
  content: loadMarkdown(import.meta.dir, "content.md"),
});
