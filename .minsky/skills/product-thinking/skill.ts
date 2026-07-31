import { defineSkill, loadMarkdown } from "../../../packages/domain/src/definitions/factories";

export default defineSkill({
  name: "product-thinking",
  description:
    "First-principles product-thinking method for principal-facing Minsky surfaces (cockpit pages/widgets, tray, vitals, future surfaces): derive what a surface SHOULD BE from the principal's supervision loop (triage/decide/steer/verify) instead of dashboard convention. Six moves: job story, owning question (receipts to the record), lightweight HTA (leaf = affordance), altitude (radiator/console/detail), ten decision-forcing X-over-Y principles (needs-me over newest, anomaly over inventory, blast-radius over action-type, ...), Do-Confirm audit (SAGAT freeze test, ISA-18.2 tier discipline, analogy + uniqueness tests). Use when designing or auditing any principal-facing surface, answering 'what should this page/widget be', or running a cockpit redesign/product pass. Sits ABOVE /cockpit-design (entity/visual layer) and /minsky-brand (register); implements the ambient-cockpit RFC's pull-surface discipline.",
  content: loadMarkdown(import.meta.dir, "content.md"),
});
