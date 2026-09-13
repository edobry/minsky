/**
 * tasks.package.succeed — work-package succession (ADR-046 decision 3, mt#5133).
 *
 * The handoff skill's terminal step used to mint a NEW package on every hop and
 * leave the one it resumed open (the measured 7-link chain mt#5030 → … →
 * mt#5119). ADR-046 rejected mint-per-succession; this command is the primitive
 * that decision assumed: the conversation holding a package rewrites its
 * briefing and member set, appends a `succession` transfer carrying the
 * outcome, and (by default) releases the claim so the same row re-enters the
 * pool. No new package row.
 *
 * Two forms, exactly one per call:
 *   --spec     the full replacement briefing the skill's steps 1-7 produce,
 *              validated by the SAME create seam (`prepareWorkPackageCreate`:
 *              `Origin: succession`, the required sections, every cited ref
 *              resolvable — mem#676 R5); its `## Members` becomes the member set.
 *   --members  a comma list of member refs, each resolved; only `## Members`
 *              is rewritten and the rest of the briefing is kept.
 * Neither: members unchanged, transfer appended, briefing kept.
 *
 * Tool registered: tasks_package_succeed.
 */

import { z } from "zod";
import { defineCommand, CommandCategory } from "../../command-registry";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { ValidationError } from "@minsky/domain/errors/index";
import { isQualifiedTaskId } from "@minsky/domain/tasks/task-id";
import { resolveCallerActorId } from "@minsky/domain/agent-identity/index";
import {
  succeedWorkPackage,
  type SuccessionMember,
} from "@minsky/domain/tasks/work-package-succession";
import { buildProductionResolvers, resolveRefs, type RefResolvers } from "../refs";
import { prepareWorkPackageCreate } from "./work-package-create-prep";

export const WORK_PACKAGE_SUCCEED_COMMAND_ID = "tasks.package.succeed";

const callerActorIdParam = {
  schema: z.string(),
  description:
    "The caller's resolved agentId (ADR-006), recorded as the succession transfer's " +
    "by_conversation. Server-injected from the resolved MCP identity (src/mcp/server.ts) — " +
    "any hand-supplied value is overwritten there. Absent on the CLI path, which resolves " +
    "identity from the harness environment instead.",
  required: false,
  cliHidden: true,
  mcpHidden: true,
} as const;

const succeedParams = {
  taskId: {
    schema: z.string(),
    description: 'The work package THIS conversation holds (e.g. "mt#5119").',
    required: true,
  },
  notes: {
    schema: z.string(),
    description:
      "The outcome, recorded on the succession transfer: what shipped, what remains, judgment " +
      "that must survive the fold.",
    required: true,
  },
  spec: {
    schema: z.string().optional(),
    description:
      "The full replacement briefing (Origin: succession; ## Situation, ## Decisions, " +
      "## Provenance; ## Members as an ordered list of task refs). Validated exactly as a " +
      "create is; its ## Members becomes the member set. Mutually exclusive with --members.",
    required: false,
  },
  members: {
    schema: z.string().optional(),
    description:
      'Comma-separated member task refs in queue order (e.g. "mt#12,mt#34"). Each must ' +
      "resolve. Rewrites only the briefing's ## Members section. Mutually exclusive with --spec.",
    required: false,
  },
  releaseClaim: {
    schema: z.boolean().default(true),
    description:
      "Release the claim after the succession so the package returns to READY (default). Pass " +
      "false to record the succession and keep holding the package.",
    required: false,
    defaultValue: true,
  },
  callerActorId: callerActorIdParam,
} as const;

/** Pure: the comma list as the command reads it — trimmed, empties dropped, order kept. */
export function parseMemberList(members: string): string[] {
  return members
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

async function getDb(getPersistenceProvider: () => unknown) {
  const provider = getPersistenceProvider() as SqlCapablePersistenceProvider | undefined;
  if (!provider?.getDatabaseConnection) {
    throw new ValidationError(
      "Work-package succession requires the SQL persistence provider, which is not available."
    );
  }
  const db = await provider.getDatabaseConnection();
  if (!db) {
    throw new ValidationError("Could not obtain a database connection for the succession.");
  }
  return db;
}

/**
 * Resolve the member set for either form through the create seam's resolvers,
 * so a ref that does not exist refuses the succession the way it refuses a
 * create. Returns the members with their live status (the F7 baseline), or the
 * refusal payload.
 */
export async function resolveSuccessionMembers(
  params: { spec?: string; members?: string },
  resolvers: RefResolvers
): Promise<
  | { ok: true; spec: string | null; members: SuccessionMember[] | null }
  | { ok: false; reason: string; message: string; details?: unknown }
> {
  if (params.spec !== undefined) {
    const prep = await prepareWorkPackageCreate(params.spec, resolvers);
    if (!prep.ok) {
      return {
        ok: false,
        reason: prep.reason,
        message: prep.message,
        details: prep.reason === "invalid-briefing" ? prep.failures : prep.unresolved,
      };
    }
    if (prep.parsed.origin !== "succession") {
      return {
        ok: false,
        reason: "wrong-origin",
        message:
          `A succession briefing declares "Origin: succession"; this one declares ` +
          `"Origin: ${prep.parsed.origin}". A groomed briefing is a curator's bundle, not a hop.`,
      };
    }
    return {
      ok: true,
      spec: params.spec,
      members: prep.parsed.members.map((m) => ({
        taskId: m.taskId,
        rationale: m.rationale,
        statusAtWrite: prep.refStatuses.get(m.taskId) ?? null,
      })),
    };
  }

  if (params.members !== undefined) {
    const refs = parseMemberList(params.members);
    const results = await resolveRefs(refs, resolvers);
    const unresolved = results.filter((r) => !r.found);
    if (unresolved.length > 0) {
      return {
        ok: false,
        reason: "unresolved-refs",
        message:
          `Member refs that do not resolve — every member must exist at write time ` +
          `(mem#676 R5):\n${unresolved
            .map((u) => `  - ${u.ref} (${u.outcome}${u.error ? `: ${u.error}` : ""})`)
            .join("\n")}`,
        details: unresolved.map((u) => ({ ref: u.ref, outcome: u.outcome, error: u.error })),
      };
    }
    const statuses = new Map(results.map((r) => [r.ref, r.status ?? null]));
    return {
      ok: true,
      spec: null,
      members: refs.map((taskId) => ({
        taskId,
        rationale: null,
        statusAtWrite: statuses.get(taskId) ?? null,
      })),
    };
  }

  return { ok: true, spec: null, members: null };
}

export function createTasksPackageSucceedCommand(
  getPersistenceProvider: () => unknown,
  container?: AppContainerInterface
) {
  return defineCommand({
    id: WORK_PACKAGE_SUCCEED_COMMAND_ID,
    category: CommandCategory.TASKS,
    name: "succeed",
    description:
      "Succeed the work package this conversation holds (ADR-046 mutate-plus-log): replace its " +
      "member set and briefing, append a `succession` transfer carrying the outcome, render the " +
      "transfer log into the spec's ## Transfers section, and release the claim so the SAME " +
      "package returns to READY — no new package is minted. Refuses a package that is not " +
      "IN-PROGRESS, a member ref that does not exist, and an empty resulting member set (close " +
      "that package instead; the lifecycle sweep completes it).",
    parameters: succeedParams,

    // ADR-004: input-shape refusals live in validate(), not execute().
    async validate(params) {
      if (!isQualifiedTaskId(params.taskId)) {
        throw new ValidationError(
          `Invalid task ID: '${params.taskId}'. Please provide a qualified task ID (mt#123, gh#456).`
        );
      }
      if (!params.notes?.trim()) {
        throw new ValidationError(
          "notes is required: the succession transfer records what shipped, what remains, and " +
            "the judgment the next claimant needs."
        );
      }
      if (params.spec !== undefined && params.members !== undefined) {
        throw new ValidationError(
          "Pass either --spec (a full replacement briefing) or --members (a member list), not both."
        );
      }
      if (params.members !== undefined) {
        const refs = parseMemberList(params.members);
        const malformed = refs.filter((r) => !isQualifiedTaskId(r));
        if (malformed.length > 0) {
          throw new ValidationError(
            `members must be qualified task refs (mt#123, gh#456); got: ${malformed.join(", ")}`
          );
        }
      }
    },

    async execute(params) {
      const resolved = await resolveSuccessionMembers(
        { spec: params.spec, members: params.members },
        buildProductionResolvers(container, undefined)
      );
      if (!resolved.ok) {
        // Same as the create seam's refusal: a shell caller sees a non-zero exit.
        process.exitCode = 1;
        return {
          success: false,
          taskId: params.taskId,
          reason: resolved.reason,
          details: resolved.details,
          message: resolved.message,
        };
      }

      const db = await getDb(getPersistenceProvider);
      const outcome = await succeedWorkPackage(db, {
        taskId: params.taskId,
        spec: resolved.spec,
        members: resolved.members,
        byConversation: resolveCallerActorId(params.callerActorId),
        notes: params.notes.trim(),
        releaseClaim: params.releaseClaim !== false,
      });

      if (!outcome.ok) {
        process.exitCode = 1;
        return { success: false, ...outcome };
      }
      const releaseClause =
        outcome.release === null
          ? "claim kept"
          : outcome.release.ok
            ? `released (transfer #${outcome.release.transferSeq})`
            : `release refused: ${outcome.release.message}`;
      return {
        success: true,
        taskId: outcome.taskId,
        members: outcome.members,
        transferSeq: outcome.transferSeq,
        status: outcome.status,
        release: outcome.release,
        message:
          `Work package ${outcome.taskId} succeeded — transfer #${outcome.transferSeq} ` +
          `(succession) recorded, ${outcome.members.length} member(s), ${releaseClause}.`,
      };
    },
  });
}
