/**
 * Tests for the cockpit memory curation write routes (mt#4766).
 *
 * These tests inject a FRESH `registryOverride` per test (mirroring
 * `memory-commands.test.ts`'s own pattern: `registerMemoryCommands(registry,
 * { memoryService })` against a fresh registry) so every route call runs
 * through the REAL command-layer `execute` handlers — including
 * `validateAssociations` — against a fake in-memory `MemoryServiceSurface`.
 * This is what makes AT2 below meaningful: a route calling `MemoryService`
 * directly would have no vocabulary check to fail against.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";
import { mountMemoryRoutes, COCKPIT_OPERATOR_SOURCE_AGENT_ID, BULK_RECORD_CAP } from "./memories";
import { isPublicPath } from "../passkey-auth";
import {
  createSharedCommandRegistry,
  type SharedCommand,
} from "../../adapters/shared/command-registry";
import { registerMemoryCommands } from "../../adapters/shared/commands/memory";
import type {
  MemoryRecord,
  MemoryUpdateInput,
  MemoryCreateInput,
} from "@minsky/domain/memory/types";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

// ─── Fake MemoryServiceSurface — in-memory, minimal ──────────────────────────

let nextFakeId = 1;

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const id = overrides.id ?? `fake-id-${nextFakeId++}`;
  return {
    id,
    shortId: overrides.shortId,
    type: "user",
    name: "Original name",
    description: "Original description",
    content: "Original content",
    scope: "project",
    projectId: null,
    tags: ["original-tag"],
    sourceAgentId: "some-original-agent",
    sourceSessionId: "some-original-session",
    confidence: null,
    supersededBy: null,
    metadata: null,
    associations: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  };
}

class FakeMemoryService
  implements
    Pick<
      MemoryServiceSurface,
      "get" | "getWithoutAccessTracking" | "update" | "delete" | "supersede"
    >
{
  private store = new Map<string, MemoryRecord>();

  seed(record: MemoryRecord): MemoryRecord {
    this.store.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.store.get(id) ?? null;
  }

  async getWithoutAccessTracking(id: string): Promise<MemoryRecord | null> {
    return this.store.get(id) ?? null;
  }

  async update(id: string, input: MemoryUpdateInput): Promise<MemoryRecord | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated: MemoryRecord = {
      ...existing,
      ...input,
      associations: input.associations
        ? { ...existing.associations, ...input.associations }
        : existing.associations,
      updatedAt: new Date(),
    } as MemoryRecord;
    this.store.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async supersede(
    oldId: string,
    newInput: MemoryCreateInput,
    reason?: string
  ): Promise<{ old: MemoryRecord; replacement: MemoryRecord }> {
    const old = this.store.get(oldId);
    if (!old) throw new Error(`Memory not found: "${oldId}"`);
    const replacement = makeRecord({
      ...newInput,
      tags: newInput.tags ?? [],
      sourceAgentId: newInput.sourceAgentId ?? null,
      sourceSessionId: newInput.sourceSessionId ?? null,
      confidence: newInput.confidence ?? null,
    });
    const updatedOld: MemoryRecord = {
      ...old,
      supersededBy: replacement.id,
      metadata: { supersessionReason: reason ?? null },
    };
    this.store.set(oldId, updatedOld);
    this.store.set(replacement.id, replacement);
    return { old: updatedOld, replacement };
  }
}

function buildRegistry(memoryService: FakeMemoryService): {
  getCommand(id: string): SharedCommand | undefined;
} {
  const registry = createSharedCommandRegistry();
  registerMemoryCommands(registry, {
    memoryService: memoryService as unknown as MemoryServiceSurface,
  });
  return registry;
}

async function makeHarness(memoryService: FakeMemoryService): Promise<{ url: string }> {
  const app = express();
  app.use(express.json());
  // Both overrides are needed: `registryOverride` covers the command-layer
  // write path (update/supersede/delete), and `memoryServiceOverride` covers
  // the bulk routes' read-only preview lookups — the two are independent
  // resolution paths inside `memories.ts` (see its module docblock).
  mountMemoryRoutes(app, {
    registryOverride: buildRegistry(memoryService),
    memoryServiceOverride: memoryService as unknown as MemoryServiceSurface,
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no ephemeral port");
  return { url: `http://127.0.0.1:${address.port}` };
}

async function postJson(url: string, body: unknown, method = "POST") {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── PATCH /api/memories/:id ──────────────────────────────────────────────────

describe("PATCH /api/memories/:id", () => {
  test("updates tags through the command layer and returns the record", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord({ tags: ["a", "b"] }));
    const { url } = await makeHarness(service);

    const res = await postJson(`${url}/api/memories/${record.id}`, { tags: ["x", "y"] }, "PATCH");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: MemoryRecord };
    expect(body.record.tags).toEqual(["x", "y"]);

    const persisted = await service.get(record.id);
    expect(persisted?.tags).toEqual(["x", "y"]);
  });

  test("AT2 — rejects an association key outside the ADR-012 vocabulary with 400", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    const res = await postJson(
      `${url}/api/memories/${record.id}`,
      { associations: { notARealAssociationType: ["mt#1"] } },
      "PATCH"
    );

    // This is the test that discriminates routing through the command layer
    // from calling MemoryService directly: `MemoryService.update` has no
    // vocabulary check at all, so only the command-layer `validateAssociations`
    // call can produce this 400.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ADR-012");

    // And the write never happened.
    const persisted = await service.get(record.id);
    expect(persisted?.associations).toEqual({});
  });

  test("accepts a KNOWN association type", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    const res = await postJson(
      `${url}/api/memories/${record.id}`,
      { associations: { tracksTask: ["mt#4766"] } },
      "PATCH"
    );
    expect(res.status).toBe(200);
  });

  test("rejects an unknown body field with 400", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    const res = await postJson(
      `${url}/api/memories/${record.id}`,
      { content: "sneaky rewrite" },
      "PATCH"
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("content");
  });

  test("AT7 — a wrong-typed field returns 400, not 500", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    const res = await postJson(
      `${url}/api/memories/${record.id}`,
      { tags: "not-an-array" },
      "PATCH"
    );
    expect(res.status).toBe(400);
  });

  test("404 when the memory does not exist", async () => {
    const service = new FakeMemoryService();
    const { url } = await makeHarness(service);

    const res = await postJson(`${url}/api/memories/does-not-exist`, { tags: ["x"] }, "PATCH");
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/memories/:id/supersede ─────────────────────────────────────────

const VALID_SUPERSEDE_BODY = {
  type: "user",
  name: "Replacement name",
  description: "Replacement description",
  content: "Replacement content",
  scope: "project",
  reason: "correcting an earlier finding",
};

describe("POST /api/memories/:id/supersede", () => {
  test("creates a replacement, marks the old row superseded", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    const res = await postJson(`${url}/api/memories/${record.id}/supersede`, VALID_SUPERSEDE_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { old: MemoryRecord; replacement: MemoryRecord };
    expect(body.old.supersededBy).toBe(body.replacement.id);
    expect(body.replacement.name).toBe("Replacement name");
  });

  test("actor attribution — the replacement's sourceAgentId is server-ascribed, never client-suppliable", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    // A normal, well-formed request gets the ascribed constant.
    const res = await postJson(`${url}/api/memories/${record.id}/supersede`, VALID_SUPERSEDE_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replacement: MemoryRecord };
    expect(body.replacement.sourceAgentId).toBe(COCKPIT_OPERATOR_SOURCE_AGENT_ID);
    expect(body.replacement.sourceSessionId).toBeNull();
  });

  test("actor attribution — a client-supplied sourceAgentId cannot override the ascribed one", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    // mt#2898's finding applied to memory: `sourceAgentId`/`sourceSessionId`
    // are not in the route's whitelist at all, so a caller attempting to set
    // them is rejected outright — the value never reaches the command layer,
    // and no record is ever created carrying an attacker-controlled identity.
    const res = await postJson(`${url}/api/memories/${record.id}/supersede`, {
      ...VALID_SUPERSEDE_BODY,
      sourceAgentId: "attacker-controlled",
    });
    expect(res.status).toBe(400);

    const persisted = await service.get(record.id);
    expect(persisted?.supersededBy).toBeNull();
  });

  test("rejects an invalid type with 400", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    const res = await postJson(`${url}/api/memories/${record.id}/supersede`, {
      ...VALID_SUPERSEDE_BODY,
      type: "not-a-real-type",
    });
    expect(res.status).toBe(400);
  });

  test("404 when the old memory does not exist", async () => {
    const service = new FakeMemoryService();
    const { url } = await makeHarness(service);

    const res = await postJson(
      `${url}/api/memories/does-not-exist/supersede`,
      VALID_SUPERSEDE_BODY
    );
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /api/memories/:id ──────────────────────────────────────────────────

describe("DELETE /api/memories/:id", () => {
  test("hard-deletes the record through the command layer", async () => {
    const service = new FakeMemoryService();
    const record = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    const res = await fetch(`${url}/api/memories/${record.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; id: string };
    expect(body.deleted).toBe(true);

    const persisted = await service.get(record.id);
    expect(persisted).toBeNull();
  });
});

// ─── Bulk routes ──────────────────────────────────────────────────────────────

describe("POST /api/memories/bulk/retag", () => {
  test("AT6 — preview lists exactly the selected records without writing", async () => {
    const service = new FakeMemoryService();
    const records = [makeRecord(), makeRecord(), makeRecord()];
    for (const r of records) service.seed(r);
    const untouched = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    const ids = records.map((r) => r.id);
    const res = await postJson(`${url}/api/memories/bulk/retag`, {
      ids,
      tags: ["new-tag"],
      execute: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preview: true; changes: Array<{ id: string }> };
    expect(body.preview).toBe(true);
    expect(body.changes.map((c) => c.id).sort()).toEqual([...ids].sort());

    // Nothing was written.
    for (const r of records) {
      const persisted = await service.get(r.id);
      expect(persisted?.tags).toEqual(r.tags);
    }
    expect((await service.get(untouched.id))?.tags).toEqual(untouched.tags);
  });

  test("AT6 — execute changes exactly the selected records", async () => {
    const service = new FakeMemoryService();
    const records = [makeRecord(), makeRecord(), makeRecord()];
    for (const r of records) service.seed(r);
    const untouched = service.seed(makeRecord());
    const { url } = await makeHarness(service);

    const ids = records.map((r) => r.id);
    const res = await postJson(`${url}/api/memories/bulk/retag`, {
      ids,
      tags: ["new-tag"],
      execute: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { executed: true; changed: string[] };
    expect(body.changed.sort()).toEqual([...ids].sort());

    for (const r of records) {
      expect((await service.get(r.id))?.tags).toEqual(["new-tag"]);
    }
    // The unselected record is untouched.
    expect((await service.get(untouched.id))?.tags).toEqual(untouched.tags);
  });

  test("rejects a selection over BULK_RECORD_CAP with 400", async () => {
    const service = new FakeMemoryService();
    const ids = Array.from({ length: BULK_RECORD_CAP + 1 }, (_, i) => `id-${i}`);
    const { url } = await makeHarness(service);

    const res = await postJson(`${url}/api/memories/bulk/retag`, {
      ids,
      tags: ["x"],
      execute: false,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("task wrapper");
  });
});

describe("POST /api/memories/bulk/delete", () => {
  test("preview then execute deletes exactly the selected records", async () => {
    const service = new FakeMemoryService();
    const records = [makeRecord(), makeRecord()];
    for (const r of records) service.seed(r);
    const untouched = service.seed(makeRecord());
    const { url } = await makeHarness(service);
    const ids = records.map((r) => r.id);

    const preview = await postJson(`${url}/api/memories/bulk/delete`, { ids, execute: false });
    expect(preview.status).toBe(200);
    for (const r of records) {
      expect(await service.get(r.id)).not.toBeNull();
    }

    const execute = await postJson(`${url}/api/memories/bulk/delete`, { ids, execute: true });
    expect(execute.status).toBe(200);
    const body = (await execute.json()) as { executed: true; deleted: string[] };
    expect(body.deleted.sort()).toEqual([...ids].sort());

    for (const r of records) {
      expect(await service.get(r.id)).toBeNull();
    }
    expect(await service.get(untouched.id)).not.toBeNull();
  });
});

// ─── AT5 — auth gating ─────────────────────────────────────────────────────────

describe("AT5 — every memory write route requires a session", () => {
  // Two independent, deployment-mode-scoped gates cover these routes, and
  // BOTH apply with zero per-route code in `memories.ts` — see server.ts
  // around its `mutationAuthMiddleware` / `requirePasskeySession` mounts:
  //
  //   - Public Railway deployment (`opts.isPublicDeployment`): PATH-based —
  //     `requirePasskeySession` denies any path not on `isPublicPath`'s
  //     closed allowlist, the same gate `/api/shares` (mint/list/revoke)
  //     relies on.
  //   - Local daemon: METHOD-based — `mutationAuthMiddleware` requires a
  //     bearer token (or the loopback bootstrap cookie) on every non-GET
  //     request, regardless of path. Every route this file mounts is
  //     PATCH/POST/DELETE, so all of them are covered by construction.
  test.each([
    "/api/memories/some-id",
    "/api/memories/some-id/supersede",
    "/api/memories/bulk/retag",
    "/api/memories/bulk/delete",
  ])("%s is NOT in the public-path allowlist", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});
