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
import {
  buildCredentialRequestAsk,
  classifyCredentialRequest,
  isPolicyResolved,
} from "@minsky/domain/credentials/request";
import { decideParentBlock } from "@minsky/domain/credentials/parent-task-block";
import { blockParentTask } from "@minsky/domain/credentials/parent-task-gate";
import type { ParentTaskGateDeps } from "@minsky/domain/credentials/parent-task-gate";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { createAskWithFormLint, requireAskRepository } from "../asks";

/**
 * The narrowest slice of the task service the parent-task gate needs (mt#4486).
 *
 * Reads `container.taskService` — the same instance every other task-touching
 * command uses — rather than constructing one. A first draft called
 * `createConfiguredTaskService` directly and did not typecheck: that factory
 * requires a `persistenceProvider` the command has no business resolving, which
 * is the type system pointing at the container that already holds a wired
 * service.
 *
 * Returns `undefined` when there is no container, so the block is SKIPPED rather
 * than failing the request — the same soft posture as every other branch here.
 */
function taskGateDeps(container?: AppContainerInterface): ParentTaskGateDeps | undefined {
  // `has` before `get`: the container THROWS on an unresolved key, and an
  // unresolved task service is a skip here, not an error.
  if (!container?.has("taskService")) return undefined;
  const service = container.get("taskService");
  if (!service) return undefined;
  return {
    async readTask(taskId: string) {
      const task = await service.getTask(taskId);
      if (!task) return null;
      return { status: task.status, kind: (task as { kind?: string | null }).kind ?? null };
    },
    async setStatus(taskId: string, status: string) {
      await service.setTaskStatus(taskId, status);
    },
  };
}

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

      // Peek at the parent BEFORE building the draft, because the entry status
      // has to be embedded in the payload the ask is created with — by release
      // time the task IS blocked and the prior status is gone (mt#4486).
      //
      // Deliberately does NOT write yet: the ask is created first, so a failed
      // create cannot strand a task in BLOCKED with no request explaining why.
      // The cost is that the status is read twice and could change in between;
      // `blockParentTask` re-reads and re-decides, so the WRITE is always
      // correct, and only the recorded entry status could be stale — worst case
      // a released task lands on READY instead of PLANNING.
      const gate = params.parentTaskId ? taskGateDeps(container) : undefined;
      let plannedEntryStatus: string | undefined;
      if (params.parentTaskId && gate) {
        try {
          const peek = await gate.readTask(params.parentTaskId);
          if (peek) {
            const decision = decideParentBlock(peek);
            if (decision.block) plannedEntryStatus = decision.entryStatus;
          }
        } catch {
          // A task-service failure must not fail the request — the credential is
          // the deliverable. `parentBlock` below re-reads and reports the miss.
        }
      }

      const draft = buildCredentialRequestAsk({
        provider,
        reason: params.reason,
        parentTaskId: params.parentTaskId,
        parentEntryStatus: plannedEntryStatus,
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

      // Block the parent LAST, so nothing above can leave a task marked blocked
      // by a request that does not exist. Soft-fails by construction — see
      // `parent-task-gate`'s module docblock for why this must not fail the
      // request.
      const parentBlock =
        params.parentTaskId && gate
          ? await blockParentTask(gate, params.parentTaskId, {
              id: ask.id,
              shortId: ask.shortId ?? undefined,
            })
          : undefined;

      return {
        success: true,
        json: params.json || false,
        requestId: ask.id,
        shortId: ask.shortId ?? undefined,
        provider: provider.id,
        configPath: provider.configPath,
        state: persisted.state,
        // Reported rather than silent: a caller that passed `parentTaskId` needs
        // to know whether the task actually got marked, because a TODO or
        // state-ops parent is skipped and that is not a failure (mt#4486).
        ...(params.parentTaskId
          ? {
              parentTaskId: params.parentTaskId,
              parentBlocked: parentBlock?.outcome === "blocked",
              parentBlockOutcome: parentBlock?.outcome ?? "failed",
              ...(parentBlock?.outcome === "skipped"
                ? { parentBlockSkipped: parentBlock.why }
                : {}),
              ...(parentBlock?.outcome === "failed" ? { parentBlockError: parentBlock.error } : {}),
            }
          : {}),
        // No value, and no field that could hold one — the agent's observable is
        // the request's identity plus where it will land.
      };
    },
  });
}

/**
 * `credentials.request-status` — the agent-side read of a filed request.
 *
 * The awaitable half: a requesting agent polls this rather than ending its turn
 * and losing the thread.
 *
 * **Why a poll.** The original reason was that no push toward an agent existed —
 * mt#3564 owned that and had not shipped. **mt#3564 is now DONE**, so that
 * justification is retired; the poll stays on its own merits, which are worth
 * stating rather than inheriting. Resolution here is presence-based and driven by
 * a sweep, so there is no single moment to push FROM: the credential can arrive
 * through the cockpit form, through `config credentials add` in a terminal, or
 * have been set before the request was ever filed. A poll reads the same answer in
 * all three cases. Whether to ALSO deliver an answered-ask push is a real design
 * question and deliberately not decided here.
 *
 * If it is adopted, the seam is the resolver's close — `satisfy()` in
 * `@minsky/domain/credentials/request-resolver`, which is the one place that
 * knows a request just became satisfied — feeding mt#3564's wake path
 * (`src/mcp/middleware/wake-enrichment.ts`). Recorded so the next reader does not
 * have to re-derive where a push would attach.
 *
 * Either way the durable handle when a conversation ends is the parent task, not
 * the conversation.
 *
 * **The observable is a status plus a status LINE, never a value.** `satisfied`
 * carries the provider's own validation detail ("3 buckets visible"); there is no
 * field here, or on the ask row it reads, capable of holding a credential.
 *
 * `declined` is deliberately distinct from `pending` and from `unanswered`
 * (cancelled/expired): an agent that cannot tell a refusal from a slow answer
 * re-asks, which is the loop this primitive exists to prevent.
 */
export function createCredentialRequestStatusRegistration(container?: AppContainerInterface) {
  return defineCommand({
    id: "credentials.request-status",
    category: CommandCategory.CONFIG,
    name: "credentials.request-status",
    description:
      "Check a credential request filed with credentials.request. Returns pending / satisfied / " +
      "declined / unanswered plus a status line. Never returns the credential.",
    requiresSetup: false,
    parameters: composeParams(
      { json: CommonParameters.json },
      {
        requestId: {
          schema: z.string().min(1),
          description: "The requestId returned by credentials.request.",
          required: true as const,
        },
      }
    ),
    execute: async (params, _ctx) => {
      const repo = await requireAskRepository(container, "credentials.request-status");
      const ask = await repo.getById(params.requestId);
      if (!ask) {
        throw new Error(`credentials.request-status: no ask found for id "${params.requestId}".`);
      }

      const status = classifyCredentialRequest(ask);
      if (!status) {
        // A real id that is not a credential request is a caller mistake worth
        // naming, not a "pending" to sit and wait on.
        throw new Error(
          `credentials.request-status: ask ${params.requestId} is not a credential request ` +
            `(kind=${ask.kind}). Check the id returned by credentials.request.`
        );
      }

      return {
        success: true,
        json: params.json || false,
        requestId: params.requestId,
        ...status,
      };
    },
  });
}
