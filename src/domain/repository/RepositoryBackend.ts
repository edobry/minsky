export interface Result {
  success: boolean;
  message?: string;
  error?: Error;
}

export interface RepoStatus {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  remotes: string[];
  [key: string]: unknown;
}

export interface RepositoryBackend {
  clone(): Promise<Result>;
  getStatus(): Promise<RepoStatus>;
  push(): Promise<Result>;
  pull(): Promise<Result>;
  validate(): Promise<Result>;
  getPath(): string;
} 
