/**
 * AI Completion Backend Types
 *
 * This module defines the types for our multi-provider AI completion system.
 * Built on top of Vercel AI SDK for provider abstraction.
 */

import type { LanguageModel } from "ai";

// Provider configuration
export interface AIProviderConfig {
  provider: "openai" | "anthropic" | "google" | "cohere" | "mistral";
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  supportedCapabilities: AICapability[];
}

export interface AICapability {
  name: "reasoning" | "tool-calling" | "prompt-caching" | "image-input" | "structured-output";
  supported: boolean;
  maxTokens?: number;
  metadata?: Record<string, any>;
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
  metadata?: Record<string, any>;
}

export interface AITool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute?: (args: Record<string, any>) => Promise<any>;
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
  metadata?: Record<string, any>;
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
  arguments: Record<string, any>;
  result?: any;
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
  getAvailableModels(provider?: string): Promise<AIModel[]>;
  validateConfiguration(): Promise<ValidationResult>;
}

export interface AIModel {
  id: string;
  provider: string;
  name: string;
  description?: string;
  capabilities: AICapability[];
  contextWindow: number;
  maxOutputTokens: number;
  costPer1kTokens?: {
    input: number;
    output: number;
  };
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
    public details?: Record<string, any>
  ) {
    super(message);
    (this as any).name = "AICompletionError";
  }
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public code: string,
    public details?: Record<string, any>
  ) {
    super(message);
    (this as any).name = "AIProviderError";
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
