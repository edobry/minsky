/**
 * Cockpit memory curation write routes (mt#4766).
 *
 * Until this file, the cockpit could not change a memory in any way: the widget
 * transport is `app.get` only (`routes/health.ts`'s dispatcher), and every
 * memory widget calls `list`/`search`/`get`/`lineage`/`similar` — never a
 * mutating method.
 *
 * ## Why these routes call the SHARED COMMAND REGISTRY, not `MemoryService` directly
 *
 * `asks.ts` (this directory's write-route precedent) calls the domain function
 * `respondAndCloseAsk` directly, and that is correct there: `respondAndCloseAsk`
 * IS the function carrying the ask's preconditions. Memory is not shaped that
 * way — its guardrails live in the COMMAND-LAYER `execute` handlers
 * (`src/adapters/shared/commands/memory/index.ts`), not in `MemoryService`:
 *
 *   - `checkDerivation` (memory.create only)
 *   - `validateAssociations` — the closed ADR-012 8-key vocabulary, checked on
 *     BOTH `memory.create` and `memory.update` (retag is an update)
 *   - `extractTrackingTaskRefs` — `tracksTask` auto-derivation (memory.create only)
 *
 * A route calling `MemoryService.update`/`.delete`/`.supersede` directly would
 * silently skip `validateAssociations` on every edit made from the cockpit.
 * Per ADR-004 (Two-Phase Command Execution, ACCEPTED), the shared command
 * registry is also the framework-enforced place these guarantees are meant to
 * live — "remember to validate first" is explicitly the bug class ADR-004
 * exists to close by construction, not by convention. Calling the service
 * directly steps outside that guarantee even where a given command has no
 * separate `validate()` phase of its own (the memory commands validate inline
 * inside `execute`, which still only runs when the registry's `execute` is the
 * thing invoked).
 *
 * ## Command construction, not persistent registration
 *
 * `registerMemoryCommands` is normally called ONCE per process (`src/cli.ts`,
 * MCP's `registerAllSharedCommands`). This module instead builds a FRESH,
 * throwaway `SharedCommandRegistry` per request, injecting the cockpit's own
 * cached `MemoryServiceSurface` (`getSharedMemoryService()`, epoch-invalidated
 * on a persistence pool recycle) via the command layer's `MemoryCommandsDeps`
 * pre-built-instance path. This is deliberate, not an oversight:
 *
 *   - Registering ONCE at module load and pre-binding `deps.memoryService`
 *     would pin that instance past a persistence pool recycle (mt#3638) —
 *     the same staleness `shared-memory-service.ts`'s epoch cache exists to
 *     avoid — since the shared registry has no way to invalidate a closed-over
 *     dependency.
 *   - Registering once with NO deps override would require threading a real
 *     `AppContainerInterface`-shaped DI container through every call so
 *     `resolveMemoryService` can resolve persistence — machinery the cockpit
 *     doesn't otherwise have, for services it already caches under
 *     `getSharedMemoryService()`.
 *
 * Building a fresh registry costs a handful of synchronous `Map.set` calls
 * (no I/O, no schema re-validation cost worth measuring) and is deliberately
 * cheap at only the frequency memory curation happens.
 *
 * `resolveMemoryIdInput`'s `mem#N`/prefix-resolution branch is inert on this
 * path (falls through to "no container, pass id through unchanged") — every
 * `:id` these routes see already arrived as the full UUID the cockpit's own
 * list/detail widgets navigate on, so no short-id resolution is needed here.
 *
 *   PATCH  /api/memories/:id           — edit tags / name / description / associations
 *   POST   /api/memories/:id/supersede — create a replacement, mark this one superseded
 *   DELETE /api/memories/:id           — hard delete (row + best-effort embedding)
 *   POST   /api/memories/bulk/retag    — dry-run preview, then execute, over ≤10 ids
 *   POST   /api/memories/bulk/delete   — dry-run preview, then execute, over ≤10 ids
 *
 * Auth: none of these paths appear in `passkey-auth.ts`'s `isPublicPath`
 * allowlist, so the cockpit's existing global session gate covers them the
 * same way it covers `/api/shares` — closed by default, no per-route work
 * needed (pinned by `memories.test.ts`'s `isPublicPath` assertions).
 */
import type express from "express";
import {
  createSharedCommandRegistry,
  type CommandExecutionContext,
  type SharedCommand,
} from "../../adapters/shared/command-registry";
import { registerMemoryCommands } from "../../adapters/shared/commands/memory";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { MemoryRecord } from "@minsky/domain/memory/types";
import { MEMORY_TYPES, MEMORY_SCOPES } from "@minsky/domain/memory/types";
import { getSharedMemoryService } from "../widgets/shared-memory-service";
import { describeServerPersistenceUnavailability } from "../db-providers";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";

/** Options accepted by {@link mountMemoryRoutes}. */
export interface MemoryRoutesOptions {
  /**
   * Override the MemoryService used for both reads (bulk preview) and command
   * construction (used in tests to avoid real DB/embedding setup). `null`
   * simulates persistence being unavailable (503 on every route).
   */
  memoryServiceOverride?: MemoryServiceSurface | null;
  /**
   * Override the command registry entirely (tests) — when set,
   * `memoryServiceOverride` is ignored for command construction (a test that
   * needs to assert on the command layer's OWN guardrails registers its own
   * fixture registry directly, the same pattern `memory-commands.test.ts` uses).
   */
  registryOverride?: { getCommand(id: string): SharedCommand | undefined };
}

/**
 * Server-ascribed identity for a cockpit-originated memory write (mt#4766).
 *
 * mt#2898 documents that `POST /api/asks/:id/resolve` reads `responder` from
 * the request body, making `responder: "operator"` assertable by ANY caller —
 * and that this became load-bearing once a permission bridge started trusting
 * it. These routes never read `sourceAgentId`/`sourceSessionId` from the
 * client at all (see `mountMemoryRoutes` below): a supersede's replacement
 * record is always ascribed this constant server-side, and a plain metadata
 * edit (retag / rename / re-describe / re-associate) never touches those
 * fields in the first place.
 */
export const COCKPIT_OPERATOR_SOURCE_AGENT_ID = "cockpit-operator";

/** Bulk operations over this many records require a task wrapper (`operational-safety-dry-run-first`). */
export const BULK_RECORD_CAP = 10;

// ─── Body-shape guards (trust-boundary discipline per asks.ts) ───────────────

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isAssociationsShape(v: unknown): v is Record<string, string[]> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((val) => isStringArray(val));
}

function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  res: express.Response
): boolean {
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    res.status(400).json({ error: `Unknown field(s): ${unknown.join(", ")}` });
    return true;
  }
  return false;
}

// ─── Command construction (see module docblock for why this is per-request) ─

async function resolveMemoryServiceForRequest(
  res: express.Response,
  options: MemoryRoutesOptions
): Promise<MemoryServiceSurface | null> {
  const service =
    options.memoryServiceOverride !== undefined
      ? options.memoryServiceOverride
      : await getSharedMemoryService();
  if (!service) {
    res.status(503).json({
      error: `Memory service unavailable — ${await describeServerPersistenceUnavailability()}`,
    });
    return null;
  }
  return service;
}

function commandsFor(
  memoryService: MemoryServiceSurface,
  options: MemoryRoutesOptions
): { getCommand(id: string): SharedCommand | undefined } {
  if (options.registryOverride) return options.registryOverride;
  const registry = createSharedCommandRegistry();
  registerMemoryCommands(registry, { memoryService });
  return registry;
}

const COMMAND_CONTEXT: CommandExecutionContext = { interface: "cockpit" };

/** Map a command-layer thrown error to an HTTP status. */
function classifyMemoryCommandError(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("not found") || message.includes("Not found")) {
    return { status: 404, message };
  }
  // `validateAssociations`'s messages always name ADR-012 (see
  // `unknownKeyMessage` / the malformed-id branch in
  // `packages/domain/src/memory/associations.ts`) — this is AT2, the test
  // that discriminates routing through the command layer from calling
  // `MemoryService` directly: only the command layer can produce this 400.
  if (message.includes("ADR-012")) {
    return { status: 400, message };
  }
  return { status: 500, message };
}

async function handleCommandError(
  res: express.Response,
  err: unknown,
  scope: string
): Promise<void> {
  if (await respondIfDatabaseUnavailable(res, err, scope)) return;
  const { status, message } = classifyMemoryCommandError(err);
  res.status(status).json({ error: message });
}

// ─── PATCH /api/memories/:id — edit tags / name / description / associations ─

const UPDATE_ALLOWED_FIELDS = new Set(["name", "description", "tags", "associations"]);

interface MemoryUpdateFields {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  associations?: Record<string, string[]>;
}

function parseUpdateBody(
  id: string,
  body: Record<string, unknown>,
  res: express.Response
): MemoryUpdateFields | null {
  if (rejectUnknownFields(body, UPDATE_ALLOWED_FIELDS, res)) return null;

  const fields: MemoryUpdateFields = { id };

  if ("name" in body) {
    if (typeof body.name !== "string" || body.name.length === 0) {
      res.status(400).json({ error: "`name` must be a non-empty string" });
      return null;
    }
    fields.name = body.name;
  }
  if ("description" in body) {
    if (typeof body.description !== "string") {
      res.status(400).json({ error: "`description` must be a string" });
      return null;
    }
    fields.description = body.description;
  }
  if ("tags" in body) {
    if (!isStringArray(body.tags)) {
      res.status(400).json({ error: "`tags` must be an array of strings" });
      return null;
    }
    fields.tags = body.tags;
  }
  if ("associations" in body) {
    if (!isAssociationsShape(body.associations)) {
      res
        .status(400)
        .json({ error: "`associations` must be an object mapping string keys to string arrays" });
      return null;
    }
    fields.associations = body.associations;
  }

  if (Object.keys(fields).length === 1) {
    res
      .status(400)
      .json({ error: "No updatable fields supplied (name, description, tags, associations)" });
    return null;
  }

  return fields;
}

// ─── POST /api/memories/:id/supersede ────────────────────────────────────────

const SUPERSEDE_REQUIRED_FIELDS = ["type", "name", "description", "content", "scope"] as const;
const SUPERSEDE_ALLOWED_FIELDS = new Set<string>([
  ...SUPERSEDE_REQUIRED_FIELDS,
  "projectId",
  "tags",
  "confidence",
  "reason",
]);

interface MemorySupersedeParams {
  oldId: string;
  type: string;
  name: string;
  description: string;
  content: string;
  scope: string;
  projectId?: string | null;
  tags: string[];
  confidence?: number;
  reason?: string;
  sourceAgentId: string;
  sourceSessionId: null;
}

function parseSupersedeBody(
  oldId: string,
  body: Record<string, unknown>,
  res: express.Response
): MemorySupersedeParams | null {
  // Trust-boundary discipline (mt#2898 applied to memory, see the module
  // docblock and `COCKPIT_OPERATOR_SOURCE_AGENT_ID`): `sourceAgentId` and
  // `sourceSessionId` are NEVER in the allowed-fields set, so a client-supplied
  // value for either is rejected by `rejectUnknownFields` below rather than
  // silently accepted-and-ignored — a caller attempting to set them gets a
  // clear 400, not a false sense that the value took effect.
  if (rejectUnknownFields(body, SUPERSEDE_ALLOWED_FIELDS, res)) return null;

  for (const key of SUPERSEDE_REQUIRED_FIELDS) {
    if (typeof body[key] !== "string" || (body[key] as string).length === 0) {
      res.status(400).json({ error: `\`${key}\` is required and must be a non-empty string` });
      return null;
    }
  }

  const type = body.type as string;
  const validTypes = Object.values(MEMORY_TYPES) as string[];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `Invalid type: "${type}". Valid: ${validTypes.join(", ")}` });
    return null;
  }

  const scope = body.scope as string;
  const validScopes = Object.values(MEMORY_SCOPES) as string[];
  if (!validScopes.includes(scope)) {
    res.status(400).json({ error: `Invalid scope: "${scope}". Valid: ${validScopes.join(", ")}` });
    return null;
  }

  if ("tags" in body && !isStringArray(body.tags)) {
    res.status(400).json({ error: "`tags` must be an array of strings" });
    return null;
  }
  if ("projectId" in body && body.projectId !== null && typeof body.projectId !== "string") {
    res.status(400).json({ error: "`projectId` must be a string or null" });
    return null;
  }
  if ("confidence" in body && typeof body.confidence !== "number") {
    res.status(400).json({ error: "`confidence` must be a number" });
    return null;
  }
  if ("reason" in body && typeof body.reason !== "string") {
    res.status(400).json({ error: "`reason` must be a string" });
    return null;
  }

  return {
    oldId,
    type,
    name: body.name as string,
    description: body.description as string,
    content: body.content as string,
    scope,
    projectId: (body.projectId as string | null | undefined) ?? undefined,
    tags: (body.tags as string[] | undefined) ?? [],
    confidence: (body.confidence as number | undefined) ?? undefined,
    reason: (body.reason as string | undefined) ?? undefined,
    // Server-ascribed, never client-suppliable — see docblock above.
    sourceAgentId: COCKPIT_OPERATOR_SOURCE_AGENT_ID,
    sourceSessionId: null,
  };
}

// ─── Bulk routes — dry-run-first (`operational-safety-dry-run-first`) ────────

interface BulkPreviewRow {
  id: string;
  name: string;
}

function parseBulkIdsBody(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  res: express.Response
): { ids: string[]; execute: boolean } | null {
  if (rejectUnknownFields(body, allowed, res)) return null;
  if (!isStringArray(body.ids) || body.ids.length === 0) {
    res.status(400).json({ error: "`ids` must be a non-empty array of strings" });
    return null;
  }
  if (body.ids.length > BULK_RECORD_CAP) {
    res.status(400).json({
      error:
        `Bulk operations over ${BULK_RECORD_CAP} records require a task wrapper ` +
        "(operational-safety-dry-run-first) — reduce the selection or file a task for the bulk mutation.",
    });
    return null;
  }
  return { ids: body.ids, execute: body.execute === true };
}

/** Fetch every id's current row for the preview; returns null (already responded) on a missing id. */
async function previewLookup(
  memoryService: MemoryServiceSurface,
  ids: string[],
  res: express.Response
): Promise<Map<string, MemoryRecord> | null> {
  const rows = await Promise.all(
    ids.map(async (id) => [id, await memoryService.getWithoutAccessTracking(id)] as const)
  );
  const missing = rows.filter(([, r]) => r === null).map(([id]) => id);
  if (missing.length > 0) {
    res.status(404).json({ error: `Memory not found: ${missing.join(", ")}` });
    return null;
  }
  return new Map(rows as Array<[string, MemoryRecord]>);
}

// ─── Route mounting ───────────────────────────────────────────────────────────

/** Mount the memory curation write routes on `app`. */
export function mountMemoryRoutes(app: express.Express, options: MemoryRoutesOptions = {}): void {
  app.patch("/api/memories/:id", async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "Memory ID required" });
      return;
    }
    const fields = parseUpdateBody(id, (req.body ?? {}) as Record<string, unknown>, res);
    if (!fields) return;

    try {
      const memoryService = await resolveMemoryServiceForRequest(res, options);
      if (!memoryService) return;
      const command = commandsFor(memoryService, options).getCommand("memory.update");
      if (!command) throw new Error("Command not registered: memory.update");
      const record = (await command.execute(fields, COMMAND_CONTEXT)) as MemoryRecord;
      res.json({ record });
    } catch (err) {
      await handleCommandError(res, err, "memories");
    }
  });

  app.post("/api/memories/:id/supersede", async (req, res) => {
    const oldId = req.params.id;
    if (!oldId) {
      res.status(400).json({ error: "Memory ID required" });
      return;
    }
    const params = parseSupersedeBody(oldId, (req.body ?? {}) as Record<string, unknown>, res);
    if (!params) return;

    try {
      const memoryService = await resolveMemoryServiceForRequest(res, options);
      if (!memoryService) return;
      const command = commandsFor(memoryService, options).getCommand("memory.supersede");
      if (!command) throw new Error("Command not registered: memory.supersede");
      const result = (await command.execute(params, COMMAND_CONTEXT)) as {
        old: MemoryRecord;
        replacement: MemoryRecord;
      };
      res.json(result);
    } catch (err) {
      await handleCommandError(res, err, "memories");
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "Memory ID required" });
      return;
    }
    try {
      const memoryService = await resolveMemoryServiceForRequest(res, options);
      if (!memoryService) return;
      const command = commandsFor(memoryService, options).getCommand("memory.delete");
      if (!command) throw new Error("Command not registered: memory.delete");
      const result = (await command.execute({ id }, COMMAND_CONTEXT)) as {
        deleted: boolean;
        id: string;
      };
      res.json(result);
    } catch (err) {
      await handleCommandError(res, err, "memories");
    }
  });

  const BULK_RETAG_ALLOWED = new Set(["ids", "tags", "execute"]);

  app.post("/api/memories/bulk/retag", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseBulkIdsBody(body, BULK_RETAG_ALLOWED, res);
    if (!parsed) return;
    if (!isStringArray(body.tags)) {
      res.status(400).json({ error: "`tags` must be an array of strings" });
      return;
    }
    const { ids, execute } = parsed;
    const tags = body.tags;

    try {
      const memoryService = await resolveMemoryServiceForRequest(res, options);
      if (!memoryService) return;
      const current = await previewLookup(memoryService, ids, res);
      if (!current) return;

      if (!execute) {
        res.json({
          preview: true,
          changes: ids.map((id) => ({
            id,
            name: current.get(id)?.name,
            currentTags: current.get(id)?.tags,
            newTags: tags,
          })),
        });
        return;
      }

      const command = commandsFor(memoryService, options).getCommand("memory.update");
      if (!command) throw new Error("Command not registered: memory.update");
      const changed: string[] = [];
      for (const id of ids) {
        await command.execute({ id, tags }, COMMAND_CONTEXT);
        changed.push(id);
      }
      res.json({ executed: true, changed });
    } catch (err) {
      await handleCommandError(res, err, "memories");
    }
  });

  const BULK_DELETE_ALLOWED = new Set(["ids", "execute"]);

  app.post("/api/memories/bulk/delete", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseBulkIdsBody(body, BULK_DELETE_ALLOWED, res);
    if (!parsed) return;
    const { ids, execute } = parsed;

    try {
      const memoryService = await resolveMemoryServiceForRequest(res, options);
      if (!memoryService) return;
      const current = await previewLookup(memoryService, ids, res);
      if (!current) return;

      if (!execute) {
        const changes: BulkPreviewRow[] = ids.map((id) => ({
          id,
          name: current.get(id)?.name ?? "",
        }));
        res.json({ preview: true, changes });
        return;
      }

      const command = commandsFor(memoryService, options).getCommand("memory.delete");
      if (!command) throw new Error("Command not registered: memory.delete");
      const deleted: string[] = [];
      for (const id of ids) {
        await command.execute({ id }, COMMAND_CONTEXT);
        deleted.push(id);
      }
      res.json({ executed: true, deleted });
    } catch (err) {
      await handleCommandError(res, err, "memories");
    }
  });
}
