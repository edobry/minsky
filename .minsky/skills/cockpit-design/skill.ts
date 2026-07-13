import { defineSkill, loadMarkdown } from "../../../packages/domain/src/definitions/factories";

export default defineSkill({
  name: "cockpit-design",
  description:
    "Minsky-domain patterns for Cockpit UI work: entity model (tasks/sessions/changesets/PRs/asks/agents) and their conventions, mission-control density patterns, command-palette UX, drill-down navigation, dark-mode elevation, attention-debt visualization, workstream display. Use when designing or rebuilding Cockpit widgets (src/cockpit/web/**), implementing entity displays, or auditing Cockpit UI against Minsky-domain conventions. Complements the 12 vendored Tier-1 skills (visual design / engineering / IA) with the Minsky-specific layer those skills don't cover.",
  content: loadMarkdown(import.meta.dir, "content.md"),
});
