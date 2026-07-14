/**
 * principal_corpus.similar command — find tweets similar to a given
 * tweet by ID (mt#1930).
 */

import { z } from "zod";
import { composeParams, CommonParameters } from "../../common-parameters";
import type { CommandExecutionContext, InferParams } from "../../command-registry";
import type { CommandParameterMap } from "../../schema-bridge";
import { createPrincipalCorpusService } from "@minsky/domain/principal-corpus/principal-corpus-service";
import type { TweetMetadata } from "@minsky/domain/principal-corpus/types";
import { resolvePersistenceFromCtx } from "../principal-corpus";

export const principalCorpusSimilarParams = composeParams(
  {
    tweetId: {
      schema: z.string().min(1),
      description: "Tweet ID to find similar tweets for",
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

export class PrincipalCorpusSimilarCommand {
  readonly id = "principal_corpus.similar";
  readonly name = "similar";
  readonly description = "Find tweets similar to a given tweet (by ID) in the principal-corpus";
  readonly parameters = principalCorpusSimilarParams;

  async execute(
    params: InferParams<typeof principalCorpusSimilarParams>,
    ctx: CommandExecutionContext
  ): Promise<{
    success: boolean;
    count: number;
    results: Array<{ id: string; score: number; metadata?: TweetMetadata }>;
    backend: string;
    degraded: boolean;
    degradedReason?: string;
  }> {
    const persistence = resolvePersistenceFromCtx(ctx, "principal_corpus.similar");
    const service = await createPrincipalCorpusService(persistence);
    const response = await service.similar(params.tweetId, params.limit ?? 10);
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

export function createPrincipalCorpusSimilarCommand(): PrincipalCorpusSimilarCommand {
  return new PrincipalCorpusSimilarCommand();
}
