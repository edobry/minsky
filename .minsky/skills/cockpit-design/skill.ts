import { defineSkill, loadMarkdown } from "../../../packages/domain/src/definitions/factories";

export default defineSkill({
  name: "cockpit-design",
  description:
    "Minsky-domain patterns for Cockpit UI work: the entity model and its conventions, mission-control density, command-palette UX, drill-down navigation, attention-debt visualization. Use when designing or rebuilding Cockpit widgets (src/cockpit/web/**), implementing entity displays, or auditing Cockpit UI against Minsky-domain conventions.",
  content: loadMarkdown(import.meta.dir, "content.md"),
});
