import { z } from "zod";
import { enumSchemas } from "./base";

export const tasksConfigSchema = z
  .strictObject({
    strictIds: z.boolean().default(false),
    backend: enumSchemas.backendType.optional(), // Optional - let user/environment configuration set this
  })
  .default({ strictIds: false }); // Removed backend from default object

export type TasksConfig = z.infer<typeof tasksConfigSchema>;
