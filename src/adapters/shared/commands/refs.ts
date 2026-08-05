/**
 * Shared Refs Commands (mt#2819)
 *
 * `refs.status` — id-set cross-reference: given mixed entity refs (task ids,
 * PR/changeset numbers, and the ADR-029 uuid-keyed entities — asks, memories,
 * and workspaces — by either short id or uuid), return each ref's current
 * status in one call, with not-found explicit per ref. Replaces the hand-rolled `jq`/`comm`
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
import { describeContainerPersistenceUnavailability } from "./persistence-unavailability";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { parseShortId, formatShortId } from "@minsky/domain/utils/short-id";

// ---------------------------------------------------------------------------
// Ref classification
// ---------------------------------------------------------------------------

export type RefKind = "task" | "changeset" | "ask" | "memory" | "workspace" | "uuid" | "unknown";

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

/**
 * The three ADR-029 short-id families, mapped to the kind each resolves as.
 *
 * `<prefix>#<n>` is the SAME lexical shape as a backend-qualified task id, so
 * without this table `ask#6448` / `mem#775` / `ws#1` all satisfy `TASK_RE`, get
 * looked up in the task id-space, and can only ever miss — reported as a plain
 * `found: false`, indistinguishable from a ref that genuinely does not exist
 * (mt#3354).
 *
 * A prefix NOT listed here deliberately falls through to `TASK_RE`: task
 * backend prefixes come from a registry (`mt`, `md`, `gh`, ...) and are
 * open-ended, so allowlisting that side would narrow a set meant to grow.
 */
const SHORT_ID_KINDS: Record<string, RefKind> = {
  ask: "ask",
  mem: "memory",
  ws: "workspace",
};

/**
 * Classify one raw ref string into its entity kind. Exported for tests.
 *
 * A bare uuid classifies as `"uuid"`, NOT as a concrete entity: asks, memories,
 * and workspaces are all uuid-keyed, so the token's shape cannot say which one
 * it names. `resolveRefs` narrows it to whichever store actually holds it.
 * Before mt#3354 every uuid was assumed to be an ask, which reported a real
 * memory as a missing ask — a silent false negative on the very id form ADR-029
 * makes canonical for citing a memory.
 */
export function classifyRef(raw: string): ClassifiedRef {
  const trimmed = raw.trim();
  if (UUID_RE.test(trimmed)) return { raw, kind: "uuid", id: trimmed.toLowerCase() };
  const prPrefix = trimmed.match(PR_PREFIX_RE);
  if (prPrefix?.[1]) return { raw, kind: "changeset", id: prPrefix[1] };
  // Entity short ids are checked BEFORE the task pattern for the same reason
  // `pr#123` is: all three are `<prefix>#<digits>`, and first match wins.
  const shortId = parseShortId(trimmed);
  const shortIdKind = shortId ? SHORT_ID_KINDS[shortId.prefix] : undefined;
  // Report the CANONICAL token (`formatShortId`), not the raw casing, so
  // `Ask#6448` and `ask#6448` produce the same `id` — matching how a uuid is
  // lower-cased above. The resolvers normalize internally either way; this
  // keeps the tool's OWN output stable for callers that key off `id`.
  if (shortId && shortIdKind) {
    return { raw, kind: shortIdKind, id: formatShortId(shortId.prefix, shortId.n) };
  }
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
  /**
   * Full canonical UUID, for the uuid-keyed kinds (ask/memory/workspace) only.
   * ADR-029 makes the uuid the sole `minsky://` deeplink target while the
   * short id is a label form, so a caller composing links needs this alongside
   * the short id `id` — without it every linked citation costs a second
   * per-entity lookup (mt#3685). Task/changeset resolvers leave it unset:
   * their `id` already IS the link target.
   */
  uuid?: string;
}

/** Per-kind resolver seam — production binds container-backed lookups; tests inject fakes. */
export interface RefResolvers {
  getTaskStatus(id: string): Promise<ResolvedRef>;
  getChangesetStatus(prNumber: string): Promise<ResolvedRef>;
  getAskState(id: string): Promise<ResolvedRef>;
  getMemoryState(id: string): Promise<ResolvedRef>;
  getWorkspaceState(id: string): Promise<ResolvedRef>;
}

/** The kinds `classifyRef` can settle from the token alone. */
type ResolvableKind = Exclude<RefKind, "uuid" | "unknown">;

/**
 * The uuid-keyed entity families, in the order a bare uuid is tried against
 * them. Asks are first because they are by far the most common uuid ref in
 * practice, so the common case costs one query rather than three.
 */
const UUID_KEYED_KINDS = ["ask", "memory", "workspace"] as const;

function lookupByKind(
  kind: ResolvableKind,
  id: string,
  resolvers: RefResolvers
): Promise<ResolvedRef> {
  switch (kind) {
    case "task":
      return resolvers.getTaskStatus(id);
    case "changeset":
      return resolvers.getChangesetStatus(id);
    case "ask":
      return resolvers.getAskState(id);
    case "memory":
      return resolvers.getMemoryState(id);
    case "workspace":
      return resolvers.getWorkspaceState(id);
  }
}

export interface RefStatusResult {
  ref: string;
  kind: RefKind;
  id: string;
  found: boolean;
  status?: string;
  title?: string;
  /** Full canonical UUID for found ask/memory/workspace rows (see ResolvedRef.uuid); absent otherwise. */
  uuid?: string;
  error?: string;
}

/**
 * Resolve a bare uuid by trying each uuid-keyed store in turn and reporting the
 * kind that actually held it — the token's shape cannot distinguish an ask from
 * a memory from a workspace.
 *
 * A store that THROWS must not mask a hit in a later one, so per-store failures
 * are collected and surfaced only when no store produced a match. Otherwise a
 * transient asks-table hiccup would report a perfectly resolvable memory as an
 * error.
 */
async function resolveUuidRef(
  base: { ref: string; kind: RefKind; id: string },
  resolvers: RefResolvers
): Promise<RefStatusResult> {
  const failures: Array<{ kind: RefKind; cause: string }> = [];
  for (const kind of UUID_KEYED_KINDS) {
    try {
      const resolved = await lookupByKind(kind, base.id, resolvers);
      if (resolved.found) {
        return {
          ...base,
          kind,
          found: true,
          status: resolved.status,
          title: resolved.title,
          // For a bare-uuid ref the classified id already IS the uuid, so a
          // resolver that omits it still yields a uniform field.
          uuid: resolved.uuid ?? base.id,
        };
      }
    } catch (error) {
      failures.push({ kind, cause: getErrorMessage(error) });
    }
  }
  // Kind stays "uuid": the ref parsed fine, it just belongs to no uuid-keyed
  // store we know of. Reporting it as an absent ASK is the mt#3354 defect.
  if (failures.length > 0) {
    // The common total-failure case is one cause (the DB is down) hit three
    // times, which would otherwise print the same sentence three times on one
    // CLI line. Collapse when every store failed identically; keep the per-store
    // breakdown only when the causes genuinely differ.
    const distinct = [...new Set(failures.map((f) => f.cause))];
    const detail =
      distinct.length === 1 ? distinct[0] : failures.map((f) => `${f.kind}: ${f.cause}`).join("; ");
    return { ...base, found: false, error: `uuid lookup failed — ${detail}` };
  }
  return { ...base, found: false };
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
            "unrecognized ref format (expected a task id like mt#123, a PR number, " +
            "a short id like ask#12 / mem#34 / ws#5, or a uuid)",
        };
      }
      try {
        if (classified.kind === "uuid") return await resolveUuidRef(base, resolvers);
        const resolved = await lookupByKind(classified.kind, classified.id, resolvers);
        if (!resolved.found) return { ...base, found: false };
        return {
          ...base,
          found: true,
          status: resolved.status,
          title: resolved.title,
          // Spread rather than assign so task/changeset rows (whose resolvers
          // never set it) carry NO uuid key, not `uuid: undefined`.
          ...(resolved.uuid ? { uuid: resolved.uuid } : {}),
        };
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
      if (!db) {
        throw new Error(
          `DB unavailable — ${await describeContainerPersistenceUnavailability(container, "refs")}`
        );
      }
      const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
      // `getById` accepts BOTH id forms via the shared `askIdWhere`, so an
      // `ask#N` needs no extra resolution here — it only needs to be routed to
      // this resolver instead of the task one (mt#3354).
      const ask = await new DrizzleAskRepository(db).getById(id);
      if (!ask) return { found: false };
      const record = ask as { id?: string; state?: string; question?: string };
      return {
        found: true,
        status: record.state,
        title: record.question?.slice(0, 100),
        uuid: record.id,
      };
    },
    async getMemoryState(id) {
      const db = await getDb(container);
      if (!db) {
        throw new Error(
          `DB unavailable — ${await describeContainerPersistenceUnavailability(container, "refs")}`
        );
      }
      const { getMemoryRefSummary } = await import("@minsky/domain/memory/memory-service");
      const memory = await getMemoryRefSummary(db, id);
      if (!memory) return { found: false };
      // A memory has no status; its `type` (feedback/project/user/reference) is
      // the closest analogue and is what a cross-reference reader wants.
      return { found: true, status: memory.type, title: memory.name, uuid: memory.id };
    },
    async getWorkspaceState(id) {
      const db = await getDb(container);
      if (!db) {
        throw new Error(
          `DB unavailable — ${await describeContainerPersistenceUnavailability(container, "refs")}`
        );
      }
      const { DrizzleSessionRepository } = await import(
        "@minsky/domain/session/drizzle-session-repository"
      );
      // `getSession` resolves `ws#N`, a uuid, a hex prefix, and legacy custom
      // session names — all four forms, via the shared `resolveEntityIdPrefix`.
      const record = await new DrizzleSessionRepository(db).getSession(id);
      if (!record) return { found: false };
      return {
        found: true,
        status: record.status,
        title: record.taskId ?? record.branch ?? record.repoName,
        uuid: record.sessionId,
      };
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
      "PR numbers (123 / #123 / PR #123), short ids (ask#12 / mem#34 / ws#5), and " +
      "uuids for asks, memories, and workspaces",
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
      "Cross-reference mixed entity refs (task ids, PR numbers, ask/memory/workspace short ids " +
      "or uuids) to their current status in one call, with not-found explicit per ref",
    category: CommandCategory.REFS,
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
