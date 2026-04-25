/**
 * AskRepository unit tests (mt#1068)
 *
 * Uses an in-memory fake DB following the MemoryService test pattern —
 * PgDialect.sqlToQuery() renders Drizzle conditions to SQL + params, then
 * a simple evaluator applies them to rows. This exercises real service code
 * without brittle AST introspection.
 *
 * Covers:
 *  - kind-exhaustiveness (compile-time assertion via assertNeverKind)
 *  - CRUD round-trip (create → get → list-by-filter)
 *  - close() sets state, response, respondedAt, closedAt and merges metadata
 *  - state-machine transitions: valid (pending→closed via close()) vs invalid
 *    (VALID_ASK_TRANSITIONS lookup rejects illegal hops)
 *  - per-kind payload/response type-narrowing compiles (static check via a
 *    switch that uses assertNeverKind in the default branch)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { AskRepository, createAsk, type AskRepositoryDb } from "../../../src/domain/ask/repository";
import {
  assertNeverKind,
  ASK_KINDS,
  ASK_STATES,
  VALID_ASK_TRANSITIONS,
  type Ask,
  type AskPayload,
  type AskResponse,
  type AskResponsePayload,
  type TransportBinding,
} from "../../../src/domain/ask/types";

// ── Row shape for the fake DB ────────────────────────────────────────────────

type AskRow = {
  id: string;
  kind: string;
  classifier_version: string;
  state: string;
  requestor: string;
  routing_target: TransportBinding | null;
  parent_task_id: string | null;
  parent_session_id: string | null;
  title: string;
  question: string;
  payload: AskPayload;
  response: AskResponse | null;
  metadata: Record<string, unknown> | null;
  deadline: Date | null;
  created_at: Date;
  routed_at: Date | null;
  suspended_at: Date | null;
  responded_at: Date | null;
  closed_at: Date | null;
};

const pgDialect = new PgDialect();

// ── SQL WHERE evaluator (subset sufficient for the patterns this repo emits) ─

function evalSqlWhere(sql: string, params: unknown[], row: AskRow): boolean {
  let s = sql.trim();
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();

  const andParts = splitTopLevel(s, " and ");
  if (andParts.length > 1) {
    return andParts.every((p) => evalSqlWhere(p, params, row));
  }

  // Only pattern this repo needs: "asks"."col" = $N
  const eqMatch = /^"asks"\."(\w+)" = \$(\d+)$/.exec(s.trim());
  if (eqMatch) {
    const colName = eqMatch[1] as keyof AskRow;
    const paramIdx = Number(eqMatch[2]) - 1;
    return (row[colName] as unknown) === params[paramIdx];
  }

  // Permissive fallback for unknown patterns (test-only)
  return true;
}

function splitTopLevel(sql: string, keyword: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
    else if (depth === 0 && sql.slice(i, i + keyword.length) === keyword) {
      parts.push(sql.slice(start, i).trim());
      start = i + keyword.length;
    }
  }
  parts.push(sql.slice(start).trim());
  return parts;
}

// ── Fake DB ──────────────────────────────────────────────────────────────────

let idCounter = 1;
function genId(): string {
  return `ask-${String(idCounter++).padStart(4, "0")}`;
}

function createFakeDb(initial: AskRow[] = []): AskRepositoryDb & {
  _rows: Map<string, AskRow>;
} {
  const rows = new Map<string, AskRow>(initial.map((r) => [r.id, r]));

  function queryRows(cond?: any): AskRow[] {
    const all = Array.from(rows.values());
    if (!cond) return all;
    const { sql, params } = pgDialect.sqlToQuery(cond);
    return all.filter((r) => evalSqlWhere(sql, params, r));
  }

  const fakeDb: AskRepositoryDb & { _rows: Map<string, AskRow> } = {
    _rows: rows,

    select(_fields?: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(cond: any) {
              const filtered = queryRows(cond);
              return {
                then(resolve: (v: AskRow[]) => void, reject?: (err: unknown) => void) {
                  Promise.resolve(filtered).then(resolve, reject);
                },
              };
            },
            then(resolve: (v: AskRow[]) => void) {
              resolve(queryRows());
            },
          };
        },
      };
    },

    insert(_table: unknown) {
      return {
        values(vals: any) {
          return {
            returning(): Promise<AskRow[]> {
              const id = genId();
              const now = new Date();
              const row: AskRow = {
                id,
                kind: vals.kind,
                classifier_version: vals.classifierVersion ?? "v1",
                state: vals.state ?? "pending",
                requestor: vals.requestor,
                routing_target: vals.routingTarget ?? null,
                parent_task_id: vals.parentTaskId ?? null,
                parent_session_id: vals.parentSessionId ?? null,
                title: vals.title,
                question: vals.question,
                payload: vals.payload,
                response: vals.response ?? null,
                metadata: vals.metadata ?? null,
                deadline: vals.deadline ?? null,
                created_at: now,
                routed_at: null,
                suspended_at: null,
                responded_at: null,
                closed_at: null,
              };
              rows.set(id, row);
              return Promise.resolve([row]);
            },
          };
        },
      };
    },

    update(_table: unknown) {
      return {
        set(setData: any) {
          return {
            where(cond: any) {
              return {
                returning(): Promise<AskRow[]> {
                  const matched = queryRows(cond);
                  const updated: AskRow[] = [];
                  for (const existing of matched) {
                    const next: AskRow = { ...existing };
                    if ("state" in setData) next.state = setData.state;
                    if ("response" in setData) next.response = setData.response;
                    if ("respondedAt" in setData) next.responded_at = setData.respondedAt;
                    if ("closedAt" in setData) next.closed_at = setData.closedAt;
                    if ("routedAt" in setData) next.routed_at = setData.routedAt;
                    if ("suspendedAt" in setData) next.suspended_at = setData.suspendedAt;
                    if ("metadata" in setData) next.metadata = setData.metadata;
                    if ("routingTarget" in setData) next.routing_target = setData.routingTarget;
                    rows.set(next.id, next);
                    updated.push(next);
                  }
                  return Promise.resolve(updated);
                },
              };
            },
          };
        },
      };
    },

    delete(_table: unknown) {
      return {
        where(cond: any) {
          return {
            returning(): Promise<AskRow[]> {
              const matched = queryRows(cond);
              const removed: AskRow[] = [];
              for (const r of matched) {
                rows.delete(r.id);
                removed.push(r);
              }
              return Promise.resolve(removed);
            },
          };
        },
      };
    },
  };

  return fakeDb;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AskRepository", () => {
  beforeEach(() => {
    idCounter = 1;
  });

  describe("create → get round-trip", () => {
    it("inserts an Ask with defaults and returns it", async () => {
      const db = createFakeDb();
      const repo = new AskRepository(db);

      const ask = await repo.create({
        kind: ASK_KINDS.DIRECTION_DECIDE,
        requestor: "agent:session:claude@task/mt-1068",
        title: "Pick framework",
        question: "Which test framework should we use?",
        payload: {
          kind: ASK_KINDS.DIRECTION_DECIDE,
          alternatives: [
            { id: "vitest", label: "Vitest" },
            { id: "bun", label: "Bun test" },
          ],
        },
      });

      expect(ask.id).toBe("ask-0001");
      expect(ask.kind).toBe(ASK_KINDS.DIRECTION_DECIDE);
      expect(ask.state).toBe("pending");
      expect(ask.classifierVersion).toBe("v1");
      expect(ask.response).toBeNull();
      expect(ask.closedAt).toBeNull();

      const fetched = await repo.get(ask.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.question).toBe("Which test framework should we use?");
    });

    it("get() returns null for missing id", async () => {
      const repo = new AskRepository(createFakeDb());
      expect(await repo.get("missing")).toBeNull();
    });
  });

  describe("list with filters", () => {
    it("filters by state", async () => {
      const db = createFakeDb();
      const repo = new AskRepository(db);

      await repo.create({
        kind: ASK_KINDS.QUALITY_REVIEW,
        requestor: "agent:session:a",
        title: "t1",
        question: "q1",
        payload: { kind: ASK_KINDS.QUALITY_REVIEW, artifact: "PR-1" },
      });
      await repo.create({
        kind: ASK_KINDS.CAPABILITY_ESCALATE,
        requestor: "agent:session:a",
        title: "t2",
        question: "q2",
        payload: { kind: ASK_KINDS.CAPABILITY_ESCALATE, model: "opus", prompt: "..." },
      });

      // Mutate one row to closed via the fake's internal map.
      const all = await repo.list();
      const firstId = all[0]?.id;
      if (firstId) {
        const stored = db._rows.get(firstId);
        if (stored) stored.state = "closed";
      }

      const open = await repo.list({ state: "pending" });
      const closed = await repo.list({ state: "closed" });
      expect(open.length).toBe(1);
      expect(closed.length).toBe(1);
    });

    it("filters by parentTaskId", async () => {
      const db = createFakeDb();
      const repo = new AskRepository(db);

      await repo.create({
        kind: ASK_KINDS.INFORMATION_RETRIEVE,
        requestor: "agent:session:a",
        parentTaskId: "mt#1068",
        title: "t",
        question: "q",
        payload: { kind: ASK_KINDS.INFORMATION_RETRIEVE, query: "docs?" },
      });
      await repo.create({
        kind: ASK_KINDS.INFORMATION_RETRIEVE,
        requestor: "agent:session:a",
        parentTaskId: "mt#1069",
        title: "t",
        question: "q",
        payload: { kind: ASK_KINDS.INFORMATION_RETRIEVE, query: "docs?" },
      });

      const r = await repo.list({ parentTaskId: "mt#1068" });
      expect(r.length).toBe(1);
      expect(r[0]?.parentTaskId).toBe("mt#1068");
    });

    it("filters by kind and classifierVersion", async () => {
      const db = createFakeDb();
      const repo = new AskRepository(db);

      await repo.create({
        kind: ASK_KINDS.STUCK_UNBLOCK,
        classifierVersion: "v1",
        requestor: "a",
        title: "t",
        question: "q",
        payload: { kind: ASK_KINDS.STUCK_UNBLOCK, attempts: ["a1"] },
      });
      await repo.create({
        kind: ASK_KINDS.STUCK_UNBLOCK,
        classifierVersion: "v2",
        requestor: "a",
        title: "t",
        question: "q",
        payload: { kind: ASK_KINDS.STUCK_UNBLOCK, attempts: ["a1"] },
      });

      const v1Results = await repo.list({ kind: ASK_KINDS.STUCK_UNBLOCK, classifierVersion: "v1" });
      expect(v1Results.length).toBe(1);
      expect(v1Results[0]?.classifierVersion).toBe("v1");
    });
  });

  describe("close()", () => {
    it("sets state to closed, records response, stamps closedAt and respondedAt", async () => {
      const db = createFakeDb();
      const repo = new AskRepository(db);

      const ask = await repo.create({
        kind: ASK_KINDS.AUTHORIZATION_APPROVE,
        requestor: "agent:session:a",
        title: "Approve commit",
        question: "Ok to commit?",
        payload: { kind: ASK_KINDS.AUTHORIZATION_APPROVE, action: "git commit" },
      });

      const before = Date.now();
      const closed = await repo.close(ask.id, {
        response: {
          responder: "operator",
          payload: { kind: ASK_KINDS.AUTHORIZATION_APPROVE, decision: "approve" },
        },
        metadata: { approver: "operator" },
      });

      expect(closed).not.toBeNull();
      expect(closed?.state).toBe("closed");
      expect(closed?.response).toMatchObject({
        responder: "operator",
        payload: { kind: ASK_KINDS.AUTHORIZATION_APPROVE, decision: "approve" },
      });
      expect(closed?.closedAt).toBeInstanceOf(Date);
      expect(closed?.respondedAt).toBeInstanceOf(Date);
      expect((closed?.closedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect(closed?.metadata).toMatchObject({ approver: "operator" });
    });

    it("merges close metadata with existing metadata (shallow)", async () => {
      const db = createFakeDb();
      const repo = new AskRepository(db);
      const ask = await repo.create({
        kind: ASK_KINDS.QUALITY_REVIEW,
        requestor: "a",
        title: "t",
        question: "q",
        payload: { kind: ASK_KINDS.QUALITY_REVIEW, artifact: "PR-5" },
        metadata: { origin: "session_pr_merge" },
      });

      const closed = await repo.close(ask.id, {
        response: {
          responder: "agent:session:reviewer-bot",
          payload: { kind: ASK_KINDS.QUALITY_REVIEW, verdict: "approve" },
        },
        metadata: { reviewer: "bot" },
      });

      expect(closed?.metadata).toMatchObject({
        origin: "session_pr_merge",
        reviewer: "bot",
      });
    });

    it("returns null for missing id", async () => {
      const repo = new AskRepository(createFakeDb());
      const closed = await repo.close("missing", {
        response: {
          responder: "policy",
          payload: { kind: ASK_KINDS.INFORMATION_RETRIEVE, answer: "n/a" },
        },
      });
      expect(closed).toBeNull();
    });
  });

  describe("createAsk helper", () => {
    it("delegates to repo.create", async () => {
      const db = createFakeDb();
      const repo = new AskRepository(db);

      const ask = await createAsk(repo, {
        kind: ASK_KINDS.COORDINATION_NOTIFY,
        requestor: "agent:session:a",
        title: "t",
        question: "q",
        payload: { kind: ASK_KINDS.COORDINATION_NOTIFY, event: "heartbeat" },
      });

      expect(ask.id).toBe("ask-0001");
      expect(db._rows.size).toBe(1);
    });
  });

  describe("state-machine transitions", () => {
    it("VALID_ASK_TRANSITIONS allows pending→routed and pending→closed", () => {
      expect(VALID_ASK_TRANSITIONS.pending).toContain("routed");
      expect(VALID_ASK_TRANSITIONS.pending).toContain("closed");
    });

    it("VALID_ASK_TRANSITIONS rejects illegal hops", () => {
      // closed is terminal — no outgoing transitions
      expect(VALID_ASK_TRANSITIONS.closed).toHaveLength(0);

      // responded can only → closed
      expect(VALID_ASK_TRANSITIONS.responded).toEqual(["closed"]);

      // Cannot go pending → responded directly
      expect(VALID_ASK_TRANSITIONS.pending).not.toContain("responded");

      // Cannot go pending → suspended directly (must route first)
      expect(VALID_ASK_TRANSITIONS.pending).not.toContain("suspended");
    });

    it("all AskStates have a (possibly empty) transition list", () => {
      const states = Object.values(ASK_STATES);
      for (const s of states) {
        expect(VALID_ASK_TRANSITIONS[s]).toBeInstanceOf(Array);
      }
    });
  });

  describe("kind exhaustiveness (compile-time)", () => {
    it("assertNeverKind catches missing handler at runtime", () => {
      // Simulates the compiler having missed a case (e.g. via `as never`).
      expect(() => assertNeverKind("unknown" as never)).toThrow("Unhandled AskKind");
    });

    it("payload/response type-narrowing compiles for all 7 kinds", () => {
      // Static compile-time check — if any kind is missing, tsgo fails at build.
      const kinds = Object.values(ASK_KINDS);
      expect(kinds.length).toBe(7);

      function narrowPayload(p: AskPayload): string {
        switch (p.kind) {
          case ASK_KINDS.CAPABILITY_ESCALATE:
            return p.model;
          case ASK_KINDS.DIRECTION_DECIDE:
            return p.alternatives.length.toString();
          case ASK_KINDS.QUALITY_REVIEW:
            return p.artifact;
          case ASK_KINDS.AUTHORIZATION_APPROVE:
            return p.action;
          case ASK_KINDS.INFORMATION_RETRIEVE:
            return p.query;
          case ASK_KINDS.COORDINATION_NOTIFY:
            return p.event;
          case ASK_KINDS.STUCK_UNBLOCK:
            return p.attempts.join(",");
          default:
            return assertNeverKind(p);
        }
      }

      function narrowResponse(r: AskResponsePayload): string {
        switch (r.kind) {
          case ASK_KINDS.CAPABILITY_ESCALATE:
            return r.output;
          case ASK_KINDS.DIRECTION_DECIDE:
            return r.chosenId;
          case ASK_KINDS.QUALITY_REVIEW:
            return r.verdict;
          case ASK_KINDS.AUTHORIZATION_APPROVE:
            return r.decision;
          case ASK_KINDS.INFORMATION_RETRIEVE:
            return r.answer;
          case ASK_KINDS.COORDINATION_NOTIFY:
            return String(r.acknowledged);
          case ASK_KINDS.STUCK_UNBLOCK:
            return r.suggestion;
          default:
            return assertNeverKind(r);
        }
      }

      // Envelope-narrowing: an AskResponse wraps a payload that itself is
      // discriminated by `kind`. Verify the envelope routes responder/payload
      // and that payload-level narrowing still type-checks.
      function narrowEnvelope(env: AskResponse): string {
        return `${env.responder}:${narrowResponse(env.payload)}`;
      }

      expect(
        narrowPayload({ kind: ASK_KINDS.CAPABILITY_ESCALATE, model: "opus", prompt: "x" })
      ).toBe("opus");
      expect(narrowResponse({ kind: ASK_KINDS.AUTHORIZATION_APPROVE, decision: "approve" })).toBe(
        "approve"
      );
      expect(
        narrowEnvelope({
          responder: "policy",
          payload: { kind: ASK_KINDS.AUTHORIZATION_APPROVE, decision: "approve" },
        })
      ).toBe("policy:approve");
    });
  });
});

// Type-level regression check: Ask is a valid shape.

const _askShape: Ask = {
  id: "x",
  kind: ASK_KINDS.DIRECTION_DECIDE,
  classifierVersion: "v1",
  state: "pending",
  requestor: "agent:session:x",
  routingTarget: null,
  parentTaskId: null,
  parentSessionId: null,
  title: "t",
  question: "q",
  payload: { kind: ASK_KINDS.DIRECTION_DECIDE, alternatives: [] },
  response: null,
  metadata: null,
  deadline: null,
  createdAt: new Date(),
  routedAt: null,
  suspendedAt: null,
  respondedAt: null,
  closedAt: null,
};
