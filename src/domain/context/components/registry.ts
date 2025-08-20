/**
 * Context Component Registry
 *
 * Manages registration and retrieval of context components
 * with dependency resolution and organization.
 */

import { ContextComponent, ContextComponentRegistry } from "./types";

/**
 * Default context component registry implementation
 */
export class DefaultContextComponentRegistry implements ContextComponentRegistry {
  private components = new Map<string, ContextComponent>();

  /**
   * Register a component
   */
  register(component: ContextComponent): void {
    this.components.set(component.id, component);
  }

  /**
   * Get a component by ID
   */
  get(id: string): ContextComponent | undefined {
    return this.components.get(id);
  }

  /**
   * Get all registered components
   */
  getAll(): ContextComponent[] {
    return Array.from(this.components.values());
  }

  /**
   * List all registered components (alias for getAll for interface compatibility)
   */
  listComponents(): ContextComponent[] {
    return this.getAll();
  }

  /**
   * Get components by tag
   */
  getByTag(tag: string): ContextComponent[] {
    return this.getAll().filter((component) => component.dependencies?.includes(tag));
  }

  /**
   * Get components with dependencies resolved
   * Returns components in dependency order
   */
  getWithDependencies(componentIds: string[]): ContextComponent[] {
    const resolved: ContextComponent[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Circular dependency detected involving component: ${id}`);
      }

      const component = this.components.get(id);
      if (!component) {
        throw new Error(`Component not found: ${id}`);
      }

      visiting.add(id);

      // Visit dependencies first
      if (component.dependencies) {
        for (const depId of component.dependencies) {
          visit(depId);
        }
      }

      visiting.delete(id);
      visited.add(id);
      resolved.push(component);
    };

    for (const id of componentIds) {
      visit(id);
    }

    return resolved;
  }

  /**
   * Check if all components exist
   */
  validateComponents(componentIds: string[]): { valid: boolean; missing: string[] } {
    const missing: string[] = [];

    for (const id of componentIds) {
      if (!this.components.has(id)) {
        missing.push(id);
      }
    }

    return {
      valid: missing.length === 0,
      missing,
    };
  }

  /**
   * Get component information for debugging
   */
  getComponentInfo(): Array<{
    id: string;
    name: string;
    description: string;
    dependencies: string[];
    hasGatherInputs: boolean;
    hasRender: boolean;
    hasLegacyGenerate: boolean;
  }> {
    return this.getAll().map((component) => ({
      id: component.id,
      name: component.name,
      description: component.description,
      dependencies: component.dependencies || [],
      hasGatherInputs: typeof component.gatherInputs === "function",
      hasRender: typeof component.render === "function",
      hasLegacyGenerate: typeof component.generate === "function",
    }));
  }
}

/**
 * Global registry instance
 */
let globalRegistry: ContextComponentRegistry | null = null;

/**
 * Get the global component registry
 */
export function getContextComponentRegistry(): ContextComponentRegistry {
  if (!globalRegistry) {
    globalRegistry = new DefaultContextComponentRegistry();
  }
  return globalRegistry;
}

/**
 * Set the global component registry (for testing)
 */
export function setContextComponentRegistry(registry: ContextComponentRegistry): void {
  globalRegistry = registry;
}

/**
 * Reset the global registry (for testing)
 */
export function resetContextComponentRegistry(): void {
  globalRegistry = new DefaultContextComponentRegistry();
}
