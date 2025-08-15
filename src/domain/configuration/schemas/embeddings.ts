import { z } from "zod";

export const embeddingsConfigSchema = z
  .object({
    provider: z.string().default("openai"),
    model: z.string().default("text-embedding-3-small"),
    dimension: z.number().optional(),
    normalize: z.boolean().default(false),
  })
  .default({ provider: "openai", model: "text-embedding-3-small", normalize: false });

export type EmbeddingsConfig = z.infer<typeof embeddingsConfigSchema>;
