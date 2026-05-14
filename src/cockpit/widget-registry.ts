/**
 * Static widget registry (mt#1144)
 *
 * Maps widget IDs to their WidgetModule implementations.
 * Adding a new widget:
 *   1. Implement WidgetModule in src/cockpit/widgets/<name>.ts
 *   2. Import it here and add an entry to WIDGET_REGISTRY
 *   3. Enable it in ~/.config/minsky/cockpit.json
 * No shell code changes are needed.
 */
import type { WidgetModule } from "./types";
import { agentsWidget } from "./widgets/agents";
import { attentionWidget } from "./widgets/attention";
import { basicHealthWidget } from "./widgets/basic-health";
import { taskGraphWidget } from "./widgets/task-graph";
import { workstreamsWidget } from "./widgets/workstreams";

export type WidgetRegistry = Record<string, WidgetModule>;

// The `attention-stub` widget was retired in mt#1147 once the real `attention`
// widget shipped. Operator configs that still reference `attention-stub` will
// see it disabled (not present in registry) — they should migrate to `attention`.
export const WIDGET_REGISTRY: WidgetRegistry = {
  agents: agentsWidget,
  attention: attentionWidget,
  "basic-health": basicHealthWidget,
  "task-graph": taskGraphWidget,
  workstreams: workstreamsWidget,
};
