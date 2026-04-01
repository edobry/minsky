/**
 * Types for the context generate command
 */

export interface GenerateRequest {
  components: string[];
  input: {
    environment: { os: string; shell: string };
    workspacePath: string;
    task: { id: string; title: string; status: string; description: string };
    userQuery: string;
    userPrompt?: string;
    targetModel: string;
    interfaceConfig: { interface: string; mcpEnabled: boolean; preferMcp: boolean };
  };
}

export interface GenerateResult {
  content: string;
  components: Array<{
    component_id: string;
    content: string;
    generated_at: string;
    token_count?: number;
  }>;
  metadata: {
    generationTime: number;
    totalTokens: number;
    skipped: string[];
    errors: string[];
  };
}

export interface GenerateOptions {
  json?: boolean;
  components?: string;
  output?: string;
  template?: string;
  model?: string;
  prompt?: string;
  interface?: string;
  analyze?: boolean;
  analyzeOnly?: boolean;
  compareModels?: string;
  showBreakdown?: boolean;
  // Visualization options
  visualize?: boolean;
  visualizeOnly?: boolean;
  chartType?: string;
  maxWidth?: string;
  showDetails?: boolean;
  csv?: boolean;
}
