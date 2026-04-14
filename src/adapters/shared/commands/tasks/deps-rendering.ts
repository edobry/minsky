/**
 * Barrel re-export for task dependency rendering utilities.
 * ASCII/text rendering: deps-rendering-ascii.ts
 * Graphviz/DOT rendering: deps-rendering-graphviz.ts
 */

export type { LayoutOptions, TaskNode } from "./deps-rendering-ascii";
export {
  generateDependencyTree,
  buildDependencyChain,
  renderDependencyChain,
  generateDependencyGraph,
} from "./deps-rendering-ascii";
export { generateGraphvizDot, renderGraphvizFormat } from "./deps-rendering-graphviz";
