/**
 * Task Dependency Rendering
 *
 * Barrel re-export — sub-modules contain the actual implementations:
 *   - deps-rendering-types.ts    — LayoutOptions, TaskNode
 *   - deps-rendering-ascii.ts    — generateDependencyTree, buildDependencyChain,
 *                                  renderDependencyChain, generateDependencyGraph
 *   - deps-rendering-graphviz.ts — generateGraphvizDot, renderGraphvizFormat
 */

export type { LayoutOptions, TaskNode } from "./deps-rendering-types";

export {
  generateDependencyTree,
  buildDependencyChain,
  renderDependencyChain,
  generateDependencyGraph,
} from "./deps-rendering-ascii";

export { generateGraphvizDot, renderGraphvizFormat } from "./deps-rendering-graphviz";
