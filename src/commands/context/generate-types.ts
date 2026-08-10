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
  /** Null when the model is absent from the model cache — render as unknown, never as a default (mt#3390). */
  contextWindowSize: number | null;
  analysisTimestamp: string;
  generationTime: number;
}

export interface AnalysisSummary {
  /** The breakdown's denominator: the sum of the per-component counts shown beside it (mt#3458). */
  totalTokens: number;
  /** The assembled context including the generation header, which belongs to no component (mt#3458). */
  assembledTokens: number;
  totalComponents: number;
  averageTokensPerComponent: number;
  largestComponent: string;
  /** Null when the context window is unknown, so no percentage can be computed (mt#3390). */
  contextWindowUtilization: number | null;
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
    task: { id: string; title: string; status: string; spec?: string };
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
    /** Sum of the components' `token_count`. Excludes the assembly header — see `assembledTokens`. */
    totalTokens: number;
    /** Real token count of the full assembled `content`, header included (mt#3458). */
    assembledTokens: number;
    /**
     * The model the counts above were produced for. The analysis path reuses
     * `token_count` only when its own target model matches this, so the
     * breakdown's numerators and its denominator are always the same
     * measurement (mt#3458).
     */
    tokenizedForModel: string;
    /**
     * Labels whose count fell back to a character estimate because tokenization
     * threw — component ids, plus `<assembled context>` for the assembled
     * string. Empty on the normal path.
     */
    tokenCountFallbacks: string[];
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
