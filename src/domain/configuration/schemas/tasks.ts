import { z } from "zod";
import { enumSchemas } from "./base";

export const tasksConfigSchema = z
  .object({
    strictIds: z.boolean().default(false),
    backend: enumSchemas.backendType.default("markdown"),
  })
  .strict()
  .default({ strictIds: false, backend: "markdown" });

export type TasksConfig = z.infer<typeof tasksConfigSchema>;
