import { z } from "zod";
import { enumSchemas } from "./base";

export const tasksConfigSchema = z
  .strictObject({
    strictIds: z.boolean().default(false),
    backend: enumSchemas.backendType.optional(), // Optional - let user/environment configuration set this
    /**
     * Controls whether the github-issues task backend is available.
     * Defaults to false (disabled). Set enabled=true to restore prior behavior
     * (requires GitHub credentials to be configured).
     */
    githubBackend: z
      .object({
        enabled: z.boolean().default(false),
      })
      .default({ enabled: false }),
  })
  .default({ strictIds: false, githubBackend: { enabled: false } });

export type TasksConfig = z.infer<typeof tasksConfigSchema>;
