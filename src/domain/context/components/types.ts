export interface ComponentInput {
  environment?: { os?: string; shell?: string; };
  workspacePath?: string;
  task?: { id: string; title: string; status: string; description: string; };
  userQuery?: string;
  targetModel?: string;
  // ... other potential inputs
}

export interface ComponentOutput {
  content: string;
  metadata: {
    componentId: string;
    generatedAt: string;
    tokenCount?: number;
  };
}

// New: Gathered inputs for a specific component
export interface ComponentInputs {
  [key: string]: any; // Flexible structure for component-specific data
}

// Refactored: Split component interface
export interface ContextComponent {
  id: string;
  name: string;
  description: string;
  dependencies?: string[];
  
  // Phase 1: Async input gathering (component-specific, can be optimized later)
  gatherInputs: (context: ComponentInput) => Promise<ComponentInputs>;
  
  // Phase 2: Pure rendering using template system and gathered inputs
  render: (inputs: ComponentInputs, context: ComponentInput) => ComponentOutput;
  
  // Legacy method for backwards compatibility (can be removed later)
  generate?: (input: ComponentInput) => Promise<ComponentOutput>;
}

// Registry interface
export interface ContextComponentRegistry {
  register(component: ContextComponent): void;
  get(id: string): ContextComponent | undefined;
  getAll(): ContextComponent[];
  listComponents(): ContextComponent[];
  getWithDependencies(componentIds: string[]): ContextComponent[];
  validateComponents(componentIds: string[]): { valid: boolean; missing: string[] };
}

// Template integration types
export interface TemplateContext {
  [key: string]: any;
}

export interface ComponentTemplate {
  template: string;
  context: TemplateContext;
}