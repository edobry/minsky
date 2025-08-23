import { z } from "zod";
import { enumSchemas } from "./base";

export const tasksConfigSchema = z
  .object({
    strictIds: z.boolean().default(false),
    backend: enumSchemas.backendType.optional(), // Optional - let user/environment configuration set this
  })
  .strict()
  .default({ strictIds: false }); // Removed backend from default object

export type TasksConfig = z.infer<typeof tasksConfigSchema>;
