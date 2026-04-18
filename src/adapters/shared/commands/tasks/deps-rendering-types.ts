/**
 * Shared types for dependency rendering sub-modules
 */

export interface LayoutOptions {
  layout?: string;
  direction?: string;
  spacing?: string;
  style?: string;
}

export interface TaskNode {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  dependents: string[];
}
