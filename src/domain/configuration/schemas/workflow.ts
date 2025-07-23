/**
 * Workflow Configuration Schema
 *
 * Defines the schema for project workflow commands including lint, test, build,
 * and other common development workflow commands that should be consistent across teams.
 */

import { z } from "zod";

/**
 * Workflow commands configuration
 *
 * These commands define the standard development workflow for a project.
 * They should be configured in .minsky/config.yaml for team consistency
 * but can be overridden in user configuration for personal preferences.
 */
export const workflowConfigSchema = z
  .object({
    // Linting commands
    lint: z.string().optional(),
    "lint:fix": z.string().optional(),
    "lint:check": z.string().optional(),

    // Testing commands
    test: z.string().optional(),
    "test:watch": z.string().optional(),
    "test:coverage": z.string().optional(),

    // Build commands
    build: z.string().optional(),
    "build:dev": z.string().optional(),
    "build:prod": z.string().optional(),

    // Development commands
    dev: z.string().optional(),
    start: z.string().optional(),
    serve: z.string().optional(),

    // Code formatting
    format: z.string().optional(),
    "format:check": z.string().optional(),

    // Other common workflows
    clean: z.string().optional(),
    install: z.string().optional(),
    setup: z.string().optional(),
  })
  .strict()
  .default({});

export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;
