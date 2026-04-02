/**
 * Types for the context generate command
 */

export interface ComponentBreakdown {
  component: string;
  tokens: number;
  percentage: string;
  content_length: number;
}

export interface TokenizerInfo {
  name: string;
  encoding: string;
  description: string;
}

export interface AnalysisMetadata {
  model: string;
  tokenizer: TokenizerInfo;
  interface: string;
  contextWindowSize: number;
  analysisTimestamp: string;
  generationTime: number;
}

export interface AnalysisSummary {
  totalTokens: number;
  totalComponents: number;
  averageTokensPerComponent: number;
  largestComponent: string;
  contextWindowUtilization: number;
}

export interface OptimizationSuggestion {
  type: string;
  component: string;
  currentTokens: number;
  suggestion: string;
  confidence: string;
  potentialSavings: number;
}

export interface AnalysisResult {
  metadata: AnalysisMetadata;
  summary: AnalysisSummary;
  componentBreakdown: ComponentBreakdown[];
  optimizations: OptimizationSuggestion[];
  fullResult: GenerateResult;
}

export interface ComponentGroup {
  name: string;
  totalTokens: number;
  percentage: number;
  components: EnrichedComponent[];
}

export interface SubComponent {
  name: string;
  description?: string;
}

export interface EnrichedComponent extends ComponentBreakdown {
  subComponents: SubComponent[];
}

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
