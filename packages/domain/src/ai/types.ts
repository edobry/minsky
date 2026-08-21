/**
 * AI Completion Backend Types
 *
 * This module defines the types for our multi-provider AI completion system.
 * Built on top of Vercel AI SDK for provider abstraction.
 */

import type { ZodType } from "zod";

// Provider configuration
export interface AIProviderConfig {
  provider: "openai" | "anthropic" | "google" | "cohere" | "mistral" | "morph";
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  supportedCapabilities: AICapability[];
}

export interface AICapability {
  name:
    | "reasoning"
    | "tool-calling"
    | "prompt-caching"
    | "image-input"
    | "structured-output"
    | "fast-apply";
  supported: boolean;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

// AI completion request types
export interface AICompletionRequest {
  prompt: string;
  model?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: AITool[];
  maxSteps?: number;
  systemPrompt?: string;
  context?: AIContext[];
}

export interface AIContext {
  type: "text" | "image" | "file";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AITool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
}

// Response types
export interface AICompletionResponse {
  content: string;
  model: string;
  provider: string;
  usage: AIUsage;
  toolCalls?: AIToolCall[];
  steps?: AIStep[];
  finishReason: "stop" | "length" | "tool-calls" | "error";
  metadata?: Record<string, unknown>;
}

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

export interface AIStep {
  type: "text" | "tool-call";
  content: string;
  toolCalls?: AIToolCall[];
  usage: AIUsage;
}

// Service interfaces
export interface AICompletionService {
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
  stream(request: AICompletionRequest): AsyncIterable<AICompletionResponse>;
  generateObject(request: AIObjectGenerationRequest): Promise<unknown>;
  getAvailableModels(provider?: string): Promise<AIModel[]>;
  validateConfiguration(): Promise<ValidationResult>;
}

export interface AIObjectGenerationRequest {
  messages?: Array<{ role: string; content: string }>;
  schema: ZodType;
  model?: string;
  temperature?: number;
  provider?: string;
  prompt?: string;
  maxTokens?: number;
  /**
   * Structured-output strategy the AI SDK uses to obtain the object (mt#4317).
   *
   * `"json"` asks the model to emit a JSON document matching the schema; `"tool"` exposes the
   * schema as a TOOL the model calls, so the provider enforces the argument shape rather than
   * the model remembering to. `"auto"` is the SDK default when this is unset, and is what every
   * Minsky caller currently gets — NO production caller sets this field.
   *
   * Exposed as a request field rather than hardcoded because the right strategy is a property
   * of the SCHEMA being asked for, not of the service. mt#4317 added it to measure one consumer
   * whose schema the model kept under-filling, found tool mode not separable from variance
   * (11/40 vs 15/40 at n=40 per arm), and therefore did NOT adopt it. It stays because the
   * measurement harness sets it per-arm and a larger run may yet settle the question.
   */
  mode?: "auto" | "json" | "tool";
}

/**
 * Tokenizer metadata for a specific AI model
 */
export interface TokenizerInfo {
  id?: string; // e.g., "cl100k_base", "o200k_base"
  type?: string; // e.g., "bpe", "sentencepiece"
  source: "api" | "config" | "fallback";
  library?: string; // preferred library: "gpt-tokenizer" | "tiktoken"
  encoding?: string; // encoding name for the tokenizer library
  [key: string]: unknown; // allow additional provider-specific fields
}

export interface AIModel {
  id: string;
  provider: string;
  name: string;
  description?: string;
  spec?: string;
  capabilities: AICapability[];
  contextWindow: number;
  maxOutputTokens: number;
  costPer1kTokens?: {
    input: number;
    output: number;
  };
  tokenizer?: TokenizerInfo;
}

// Configuration service types
export interface AIConfigurationService {
  getProviderConfig(provider: string): Promise<AIProviderConfig | null>;
  setProviderConfig(provider: string, config: AIProviderConfig): Promise<void>;
  getDefaultProvider(): Promise<string>;
  setDefaultProvider(provider: string): Promise<void>;
  validateProviderKey(provider: string, apiKey: string): Promise<boolean>;
}

// Error types
export class AICompletionError extends Error {
  constructor(
    message: string,
    public provider: string,
    public model: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AICompletionError";
  }
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

// Re-export from AI SDK for external use
export type { LanguageModel } from "ai";

// Validation types
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  code: string;
}
