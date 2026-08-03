import { defineSkill, loadMarkdown } from "../../../packages/domain/src/definitions/factories";

export default defineSkill({
  name: "product-thinking",
  description:
    "First-principles method for principal-facing Minsky surfaces: derive what a surface SHOULD BE from the principal's supervision loop (triage/decide/steer/verify) instead of dashboard convention. Use when designing or auditing a principal-facing surface, answering 'what should this page/widget be', or running a cockpit product pass. Sits above /cockpit-design and /minsky-brand.",
  content: loadMarkdown(import.meta.dir, "content.md"),
});
