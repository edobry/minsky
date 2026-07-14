/**
 * principal_corpus.search command — semantic query over the principal's
 * corpus embeddings (mt#1930).
 */

import { z } from "zod";
import { composeParams, CommonParameters } from "../../common-parameters";
import type { CommandExecutionContext, InferParams } from "../../command-registry";
import type { CommandParameterMap } from "../../schema-bridge";
import { createPrincipalCorpusService } from "@minsky/domain/principal-corpus/principal-corpus-service";
import type { TweetMetadata } from "@minsky/domain/principal-corpus/types";
import { resolvePersistenceFromCtx } from "../principal-corpus";

export const principalCorpusSearchParams = composeParams(
  {
    query: {
      schema: z.string().min(1),
      description: "Natural-language query (semantic search)",
      required: true,
    },
    limit: {
      schema: z.number().int().positive(),
      description: "Maximum number of results to return (default 10)",
      required: false,
      defaultValue: 10,
    },
  },
  {
    json: CommonParameters.json,
  }
) satisfies CommandParameterMap;

export class PrincipalCorpusSearchCommand {
  readonly id = "principal_corpus.search";
  readonly name = "search";
  readonly description = "Semantic search over the principal-corpus tweet archive";
  readonly parameters = principalCorpusSearchParams;

  async execute(
    params: InferParams<typeof principalCorpusSearchParams>,
    ctx: CommandExecutionContext
  ): Promise<{
    success: boolean;
    count: number;
    results: Array<{ id: string; score: number; metadata?: TweetMetadata }>;
    backend: string;
    degraded: boolean;
    degradedReason?: string;
  }> {
    const persistence = resolvePersistenceFromCtx(ctx, "principal_corpus.search");
    const service = await createPrincipalCorpusService(persistence);
    const response = await service.searchByText(params.query, params.limit ?? 10);
    return {
      success: !response.degraded,
      count: response.results.length,
      results: response.results.map((r) => ({
        id: r.id,
        score: r.score,
        metadata: r.metadata,
      })),
      backend: response.backend,
      degraded: response.degraded,
      degradedReason: response.degradedReason,
    };
  }
}

export function createPrincipalCorpusSearchCommand(): PrincipalCorpusSearchCommand {
  return new PrincipalCorpusSearchCommand();
}
