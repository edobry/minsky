import { z } from "zod";

export const tasksConfigSchema = z
  .object({
    strictIds: z.boolean().default(false),
  })
  .strict()
  .default({ strictIds: false });

export type TasksConfig = z.infer<typeof tasksConfigSchema>;
