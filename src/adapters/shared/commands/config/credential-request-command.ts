/**
 * `credentials.request` — agent-initiated credential request (mt#4030).
 *
 * The affordance half of the `family:transcript-secret-leak` pair: it gives an
 * agent that needs a credential somewhere to go OTHER than asking the principal
 * to paste a secret into chat (mem#564 — the transcript is persisted to disk AND
 * ingested into the transcripts DB). mt#2428 is the enforcement half; neither
 * substitutes for the other.
 *
 * **This command's input schema has no field that can carry a value, and that is
 * load-bearing rather than incidental.** `config.credentials.add` takes a
 * `token` parameter for its scripted path, so an agent calling THAT over MCP
 * writes the secret into its own tool-call input — which is the transcript. This
 * command is deliberately not a wrapper over it: the value travels
 * browser → cockpit server → `~/.config/minsky/config.yaml` and never passes
 * through the MCP boundary at all.
 *
 * @see packages/domain/src/credentials/request.ts — the pure request/resolve core
 */
import { z } from "zod";
import { CommandCategory, defineCommand } from "../../command-registry";
import { CommonParameters, composeParams } from "../../common-parameters";
import {
  KNOWN_PROVIDER_IDS,
  getCredentialProvider,
  listCredentialProviders,
} from "@minsky/domain/credentials";
import { buildCredentialRequestAsk, isPolicyResolved } from "@minsky/domain/credentials/request";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { createAskWithFormLint, requireAskRepository } from "../asks";

/** Path named in the refusal below, so the fix is one file away from the error. */
const REGISTRY_PATH = "packages/domain/src/credentials/providers/index.ts";

/**
 * Build the registration. Takes the container rather than reaching for a
 * singleton so the ask repository resolves the same way every other ask-writing
 * command resolves it.
 */
export function createCredentialRequestRegistration(container?: AppContainerInterface) {
  return defineCommand({
    id: "credentials.request",
    category: CommandCategory.CONFIG,
    name: "credentials.request",
    description:
      "Ask the principal for a credential you cannot read. Routes to a masked cockpit form; " +
      "resolves when the credential is present. Never accepts or returns the value.",
    requiresSetup: false,
    parameters: composeParams(
      { json: CommonParameters.json },
      {
        provider: {
          schema: z.string(),
          description: `Credential provider id (${KNOWN_PROVIDER_IDS.join(" | ")})`,
          required: true as const,
        },
        reason: {
          schema: z.string().min(1),
          description:
            "Why this credential is needed now, in the principal's terms. Shown on the request.",
          required: true as const,
        },
        parentTaskId: {
          schema: z.string().optional(),
          description:
            "Task blocked by this request. Set it — the task is what holds the pending state " +
            "when the requesting conversation ends.",
          required: false as const,
        },
      }
    ),
    execute: async (params, _ctx) => {
      // Refuse at call time rather than filing an ask the principal has no way
      // to satisfy — that was exactly the mt#4028 situation (the key had no
      // provider to land on), and it is the one failure this must not reproduce.
      const provider = getCredentialProvider(params.provider);
      if (!provider) {
        const known = listCredentialProviders()
          .map((p) => p.id)
          .join(", ");
        throw new Error(
          `credentials.request: no credential provider is registered for "${params.provider}", ` +
            `so there is nowhere for the principal to enter it. Known providers: ${known}. ` +
            `Register one in ${REGISTRY_PATH} first.`
        );
      }

      const repo = await requireAskRepository(container, "credentials.request");
      const draft = buildCredentialRequestAsk({
        provider,
        reason: params.reason,
        parentTaskId: params.parentTaskId,
      });

      const { ask } = await createAskWithFormLint(repo, draft);

      // Read the ask back and fail loudly if phase-1 policy consultation
      // resolved it instead of routing it to a human.
      //
      // `authorization.approve` is the SOLE member of POLICY_ELIGIBLE_KINDS, so
      // the kind chosen for its operator-inbox binding is the one kind that path
      // can short-circuit — repeatedly, on well-formed questions, in ~150ms with
      // an unrelated citation and nobody ever seeing it (mt#3233). Resolution
      // here is presence-based, so such a close produces no false "satisfied";
      // it produces a request that never resolves while the row reads as settled
      // at zero operator cost. Waiting on that is a permanent silent stall, so
      // the caller is told now. Clean fix: mt#3715.
      const persisted = (await repo.getById(ask.id)) ?? ask;
      if (isPolicyResolved(persisted)) {
        throw new Error(
          `credentials.request: the ask was resolved in-policy (routingTarget=` +
            `${persisted.routingTarget}) and never reached the principal, so no credential is ` +
            `coming. Do NOT wait on it. Ask id ${ask.id}. This is the mt#3233 exposure; ` +
            `mt#3715 owns the fix. Meanwhile the principal can enter the credential directly ` +
            `in the cockpit credentials form (${provider.displayName}).`
        );
      }

      return {
        success: true,
        json: params.json || false,
        requestId: ask.id,
        shortId: ask.shortId ?? undefined,
        provider: provider.id,
        configPath: provider.configPath,
        state: persisted.state,
        // No value, and no field that could hold one — the agent's observable is
        // the request's identity plus where it will land.
      };
    },
  });
}
