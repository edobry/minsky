/**
 * Static widget registry (mt#1144)
 *
 * Maps widget IDs to their WidgetModule implementations.
 * Adding a new widget:
 *   1. Implement WidgetModule in src/cockpit/widgets/<name>.ts
 *   2. Import it here and add an entry to WIDGET_REGISTRY
 * No shell code changes are needed. A registered widget's data endpoint is
 * served automatically — there is no per-widget enable flag (mt#2294).
 */
import type { WidgetModule } from "./types";
import { agentsWidget } from "./widgets/agents";
import { attentionWidget } from "./widgets/attention";
import { basicHealthWidget } from "./widgets/basic-health";
import { contextInspectorWidget } from "./widgets/context-inspector";
import { credentialsWidget } from "./widgets/credentials";
import { embeddingsHealthWidget } from "./widgets/embeddings-health";
import { mcpServerStatusWidget } from "./widgets/mcp-server-status";
import { memoriesDetailWidget } from "./widgets/memories-detail";
import { memoriesHealthWidget } from "./widgets/memories-health";
import { memoriesListWidget } from "./widgets/memories-list";
import { memoriesSearchWidget } from "./widgets/memories-search";
import { memoriesStatsWidget } from "./widgets/memories-stats";
import { taskGraphWidget } from "./widgets/task-graph";
import { taskListWidget } from "./widgets/task-list";
import { workstreamsWidget } from "./widgets/workstreams";

export type WidgetRegistry = Record<string, WidgetModule>;

// The `attention-stub` widget was retired in mt#1147 once the real `attention`
// widget shipped. Operator configs that still reference `attention-stub` will
// see it disabled (not present in registry) — they should migrate to `attention`.
export const WIDGET_REGISTRY: WidgetRegistry = {
  agents: agentsWidget,
  attention: attentionWidget,
  "basic-health": basicHealthWidget,
  "context-inspector": contextInspectorWidget,
  credentials: credentialsWidget,
  "embeddings-health": embeddingsHealthWidget,
  "mcp-server-status": mcpServerStatusWidget,
  "memories-detail": memoriesDetailWidget,
  "memories-health": memoriesHealthWidget,
  "memories-list": memoriesListWidget,
  "memories-search": memoriesSearchWidget,
  "memories-stats": memoriesStatsWidget,
  "task-graph": taskGraphWidget,
  "task-list": taskListWidget,
  workstreams: workstreamsWidget,
};
