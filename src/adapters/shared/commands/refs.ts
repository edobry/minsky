/**
 * Shared Refs Commands (mt#2819)
 *
 * `refs.status` — id-set cross-reference: given mixed entity refs (task ids,
 * PR/changeset numbers, ask uuids), return each ref's current status in one
 * call, with not-found explicit per ref. Replaces the hand-rolled `jq`/`comm`
 * set-diff pipelines that produced real bugs in the 2026-07-13/14 bulk
 * sweeps (numeric-vs-lexical `comm` sort misclassifying open PRs; a jq
 * context-binding bug) — see the mt#2819 spec.
 */
import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
import { CommonParameters } from "../common-parameters";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

// ---------------------------------------------------------------------------
// Ref classification
// ---------------------------------------------------------------------------

export type RefKind = "task" | "changeset" | "ask" | "unknown";

export interface ClassifiedRef {
  raw: string;
  kind: RefKind;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "PR #123" / "pr#123" / "pr 123" — checked BEFORE the generic task pattern so
// the "pr" prefix is never misread as a task backend prefix.
const PR_PREFIX_RE = /^pr\s*#?\s*(\d+)$/i;
// "#123" / "123" — bare numbers are changeset (PR) refs.
const BARE_NUMBER_RE = /^#?(\d+)$/;
// "mt#123" / "md#456" — backend-qualified task ids.
const TASK_RE = /^[a-z]+#\d+$/i;

/** Classify one raw ref string into its entity kind. Exported for tests. */
export function classifyRef(raw: string): ClassifiedRef {
  const trimmed = raw.trim();
  if (UUID_RE.test(trimmed)) return { raw, kind: "ask", id: trimmed.toLowerCase() };
  const prPrefix = trimmed.match(PR_PREFIX_RE);
  if (prPrefix?.[1]) return { raw, kind: "changeset", id: prPrefix[1] };
  if (TASK_RE.test(trimmed)) return { raw, kind: "task", id: trimmed };
  const bare = trimmed.match(BARE_NUMBER_RE);
  if (bare?.[1]) return { raw, kind: "changeset", id: bare[1] };
  return { raw, kind: "unknown", id: trimmed };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface ResolvedRef {
  found: boolean;
  status?: string;
  title?: string;
}

/** Per-kind resolver seam — production binds container-backed lookups; tests inject fakes. */
export interface RefResolvers {
  getTaskStatus(id: string): Promise<ResolvedRef>;
  getChangesetStatus(prNumber: string): Promise<ResolvedRef>;
  getAskState(id: string): Promise<ResolvedRef>;
}

export interface RefStatusResult {
  ref: string;
  kind: RefKind;
  id: string;
  found: boolean;
  status?: string;
  title?: string;
  error?: string;
}

/**
 * Resolve every ref concurrently. A resolver error surfaces on THAT ref's
 * result (`found: false` + `error`) rather than failing the whole call — a
 * cross-reference over N refs must never lose the other N-1 answers to one
 * backend hiccup.
 */
export async function resolveRefs(
  refs: string[],
  resolvers: RefResolvers
): Promise<RefStatusResult[]> {
  return Promise.all(
    refs.map(async (raw): Promise<RefStatusResult> => {
      const classified = classifyRef(raw);
      const base = { ref: raw.trim(), kind: classified.kind, id: classified.id };
      if (classified.kind === "unknown") {
        return {
          ...base,
          found: false,
          error:
            "unrecognized ref format (expected a task id like mt#123, a PR number, or an ask uuid)",
        };
      }
      try {
        const resolved =
          classified.kind === "task"
            ? await resolvers.getTaskStatus(classified.id)
            : classified.kind === "changeset"
              ? await resolvers.getChangesetStatus(classified.id)
              : await resolvers.getAskState(classified.id);
        if (!resolved.found) return { ...base, found: false };
        return { ...base, found: true, status: resolved.status, title: resolved.title };
      } catch (error) {
        return { ...base, found: false, error: getErrorMessage(error) };
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Production resolvers
// ---------------------------------------------------------------------------

async function getDb(
  container: AppContainerInterface | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  if (!container?.has("persistence")) return null;
  try {
    const provider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!provider.getDatabaseConnection) return null;
    return (await provider.getDatabaseConnection()) ?? null;
  } catch (err: unknown) {
    log.warn("refs: could not resolve DB connection", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function buildProductionResolvers(
  container: AppContainerInterface | undefined,
  repo: string | undefined
): RefResolvers {
  // One changeset service per refs.status call, created lazily on the first
  // changeset ref and shared by the rest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let changesetServicePromise: Promise<any> | null = null;
  const getChangesetService = () => {
    if (!changesetServicePromise) {
      changesetServicePromise = (async () => {
        const { resolveChangesetRepoUrl } = await import("./changeset/changeset-commands");
        const { createChangesetService } = await import("@minsky/domain/changeset/index");
        const repoUrl = await resolveChangesetRepoUrl(repo);
        return createChangesetService(repoUrl);
      })();
    }
    return changesetServicePromise;
  };

  return {
    async getTaskStatus(id) {
      if (!container?.has("taskService")) {
        throw new Error("Task service unavailable — DI container not initialized");
      }
      const service = container.get("taskService");
      const task = await service.getTask(id);
      return task ? { found: true, status: task.status, title: task.title } : { found: false };
    },
    async getChangesetStatus(prNumber) {
      const service = await getChangesetService();
      const changeset = await service.get(prNumber);
      return changeset
        ? { found: true, status: changeset.status, title: changeset.title }
        : { found: false };
    },
    async getAskState(id) {
      const db = await getDb(container);
      if (!db) throw new Error("DB unavailable for ask lookup");
      const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
      const ask = await new DrizzleAskRepository(db).getById(id);
      if (!ask) return { found: false };
      const record = ask as { state?: string; question?: string };
      return { found: true, status: record.state, title: record.question?.slice(0, 100) };
    },
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

const refsStatusParams = {
  refs: {
    schema: z.union([z.string(), z.array(z.string())]),
    description:
      "Entity refs to resolve (array, or comma-separated string): task ids (mt#123), " +
      "PR numbers (123 / #123 / PR #123), ask uuids",
    required: true,
  },
  repo: CommonParameters.repo,
  json: CommonParameters.json,
} satisfies CommandParameterMap;

export function registerRefsCommands(container?: AppContainerInterface): void {
  sharedCommandRegistry.registerCommand({
    id: "refs.status",
    name: "status",
    description:
      "Cross-reference mixed entity refs (task ids, PR numbers, ask uuids) to their current " +
      "status in one call, with not-found explicit per ref",
    category: CommandCategory.TASKS,
    parameters: refsStatusParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      const rawRefs = params.refs;
      const refs = (Array.isArray(rawRefs) ? rawRefs : rawRefs.split(","))
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      if (refs.length === 0) {
        return { success: false, error: "At least one ref is required." };
      }

      const resolvers = buildProductionResolvers(container, params.repo);
      const results = await resolveRefs(refs, resolvers);
      const found = results.filter((r) => r.found).length;

      if (!params.json && ctx?.format !== "json") {
        for (const result of results) {
          const label = result.found
            ? `${result.status}${result.title ? `  ${result.title}` : ""}`
            : `NOT FOUND${result.error ? ` (${result.error})` : ""}`;
          log.cli(`${result.ref}  [${result.kind}]  ${label}`);
        }
      }

      return {
        success: true,
        total: results.length,
        found,
        notFound: results.length - found,
        results,
      };
    },
  });
}
