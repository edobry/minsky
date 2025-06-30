/**
 * Essential configuration types for Minsky (post node-config migration)
 * 
 * This module contains only the essential types still needed after migrating
 * from custom configuration system to node-config.
 */

export interface SessionDbConfig {
  backend: "json" | "sqlite" | "postgres";
  dbPath?: string;
  baseDir?: string;
  connectionString?: string;
}

export interface DetectionRule {
  condition: "json_file_exists" | "tasks_md_exists" | "always";
  backend: string;
}

// AI Provider Configuration Types (still needed for AI service)
export interface AIProviderRepoConfig {
  default_model?: string;
  base_url?: string;
  enabled?: boolean;
  models?: string[];
}

export interface AIProviderUserConfig {
  default_model?: string;
  base_url?: string;
  enabled?: boolean;
  models?: string[];
  max_tokens?: number;
  temperature?: number;
}

export interface AICredentialConfig {
  source: "environment" | "file" | "prompt";
  api_key?: string;
  api_key_file?: string;
}

export type CredentialSource = "environment" | "file" | "prompt";
