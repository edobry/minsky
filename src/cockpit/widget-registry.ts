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
import { attentionStubWidget } from "./widgets/attention-stub";
import { basicHealthWidget } from "./widgets/basic-health";

export type WidgetRegistry = Record<string, WidgetModule>;

export const WIDGET_REGISTRY: WidgetRegistry = {
  "attention-stub": attentionStubWidget,
  "basic-health": basicHealthWidget,
};
