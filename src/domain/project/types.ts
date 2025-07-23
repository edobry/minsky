/**
 * Project Configuration Types
 *
 * Basic implementation of project configuration based on task #321
 * Currently focused on workflow commands, especially lint configuration
 */

export interface ProjectWorkflows {
  install?: string;
  build?: string;
  start?: string;
  dev?: string;
  test?: string;
  lint?: string;
  format?: string;
  clean?: string;
  custom?: Record<string, string>;
}

export interface ProjectConfiguration {
  // Basic project information
  project?: {
    name?: string;
    description?: string;
    version?: string;
  };

  // Workflow commands (main focus for session lint)
  workflows?: ProjectWorkflows;

  // Future extensions from task #321
  // technology?: { ... };
  // development?: { ... };
  // containerization?: { ... };
  // etc.
}

export interface ProjectConfigSource {
  type: "package.json" | "minsky.json" | "default";
  path?: string;
  workflows: ProjectWorkflows;
}
