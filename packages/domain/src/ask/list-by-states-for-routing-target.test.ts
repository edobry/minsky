/**
 * `listByStatesForRoutingTarget` — the paged, filtered, ordered read the
 * cockpit's resolved-asks view runs on (mt#4092).
 *
 * This method exists because composing the same result from `listByState` per
 * state pulls every row in every requested state across every routing target
 * and discards ~97% of it in JS — 2.7-6.4s against the real store versus 0.47s
 * for this. The tests below pin the four things that composition was doing in
 * JS and this now does in SQL: the state set, the routing-target filter, the
 * conclusion-time ordering, and the limit-with-true-total.
 */
import { describe, test, expect } from "bun:test";
import { FakeAskRepository } from "./repository";
import { ALL_PROJECTS } from "../project/scope";
import type { Ask, AskState } from "./types";

interface Seed {
  title: string;
  state: AskState;
  routingTarget?: string;
  closedAt?: string;
  respondedAt?: string;
  createdAt?: string;
  projectId?: string;
}

async function seed(repo: FakeAskRepository, s: Seed): Promise<Ask> {
  const ask = await repo.create({
    kind: "direction.decide",
    classifierVersion: "v1",
    requestor: "test-agent",
    title: s.title,
    question: `Question for ${s.title}`,
    serviceStrategy: "scheduled",
    windowMissedCount: 0,
    forceImmediate: false,
    routingTarget: s.routingTarget ?? "operator",
  });
  repo._seedAtState({
    ...ask,
    state: s.state,
    routingTarget: s.routingTarget ?? "operator",
    closedAt: s.closedAt,
    respondedAt: s.respondedAt,
    ...(s.createdAt ? { createdAt: s.createdAt } : {}),
    ...(s.projectId ? { projectId: s.projectId } : {}),
  });
  const reread = await repo.getById(ask.id);
  if (!reread) throw new Error("fixture re-read failed");
  return reread;
}

const TERMINAL: AskState[] = ["closed", "cancelled", "expired"];

/** Two project uuids, so a scoped read has something to exclude. */
const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "22222222-2222-2222-2222-222222222222";

describe("listByStatesForRoutingTarget (mt#4092)", () => {
  test("returns only the requested states", async () => {
    const repo = new FakeAskRepository();
    await seed(repo, { title: "still pending", state: "suspended" });
    const closed = await seed(repo, { title: "closed", state: "closed" });

    const { asks, total } = await repo.listByStatesForRoutingTarget({
      states: TERMINAL,
      routingTarget: "operator",
      limit: 50,
    });

    expect(asks.map((a) => a.id)).toEqual([closed.id]);
    expect(total).toBe(1);
  });

  test("returns only the requested routing target", async () => {
    const repo = new FakeAskRepository();
    const mine = await seed(repo, { title: "mine", state: "closed" });
    await seed(repo, { title: "reviewer's", state: "closed", routingTarget: "reviewer" });
    await seed(repo, { title: "policy's", state: "closed", routingTarget: "policy" });

    const { asks, total } = await repo.listByStatesForRoutingTarget({
      states: TERMINAL,
      routingTarget: "operator",
      limit: 50,
    });

    expect(asks.map((a) => a.id)).toEqual([mine.id]);
    expect(total).toBe(1);
  });

  test("orders by conclusion time, most recent first", async () => {
    const repo = new FakeAskRepository();
    const oldest = await seed(repo, {
      title: "oldest",
      state: "closed",
      closedAt: "2026-08-01T00:00:00.000Z",
    });
    const newest = await seed(repo, {
      title: "newest",
      state: "closed",
      closedAt: "2026-08-12T00:00:00.000Z",
    });
    const middle = await seed(repo, {
      title: "middle",
      state: "closed",
      closedAt: "2026-08-06T00:00:00.000Z",
    });

    const { asks } = await repo.listByStatesForRoutingTarget({
      states: TERMINAL,
      routingTarget: "operator",
      limit: 50,
    });

    expect(asks.map((a) => a.id)).toEqual([newest.id, middle.id, oldest.id]);
  });

  test("falls back per-row: respondedAt, then createdAt, when closedAt is absent", async () => {
    const repo = new FakeAskRepository();
    // Deliberately adversarial: the row with NO closedAt is the most recently
    // concluded. A "sort by closedAt, tie-break on respondedAt" ordering would
    // put it last; the per-row COALESCE this mirrors puts it first.
    const withClosedAt = await seed(repo, {
      title: "closed a week ago",
      state: "closed",
      closedAt: "2026-08-05T00:00:00.000Z",
    });
    const withRespondedAt = await seed(repo, {
      title: "responded yesterday, never closed",
      state: "cancelled",
      respondedAt: "2026-08-12T00:00:00.000Z",
    });

    const { asks } = await repo.listByStatesForRoutingTarget({
      states: TERMINAL,
      routingTarget: "operator",
      limit: 50,
    });

    expect(asks.map((a) => a.id)).toEqual([withRespondedAt.id, withClosedAt.id]);
  });

  test("caps the page but reports the true match count", async () => {
    const repo = new FakeAskRepository();
    for (let i = 1; i <= 5; i++) {
      await seed(repo, {
        title: `decision ${i}`,
        state: "closed",
        closedAt: `2026-08-0${i}T00:00:00.000Z`,
      });
    }

    const { asks, total } = await repo.listByStatesForRoutingTarget({
      states: TERMINAL,
      routingTarget: "operator",
      limit: 2,
    });

    expect(total).toBe(5);
    expect(asks).toHaveLength(2);
    // The cap keeps the NEWEST rows — a limit applied before the sort would
    // return an arbitrary two and still satisfy the length assertion.
    expect(asks.map((a) => a.title)).toEqual(["decision 5", "decision 4"]);
  });

  test("an empty state set issues no query and returns nothing", async () => {
    const repo = new FakeAskRepository();
    await seed(repo, { title: "closed", state: "closed" });

    const result = await repo.listByStatesForRoutingTarget({
      states: [],
      routingTarget: "operator",
      limit: 50,
    });

    expect(result).toEqual({ asks: [], total: 0 });
  });

  test("a uuid project scope restricts the read; ALL_PROJECTS does not", async () => {
    // (see the sibling scope test below for listShortIdsForRoutingTarget)
    const repo = new FakeAskRepository();
    const scoped = await seed(repo, {
      title: "in project A",
      state: "closed",
      projectId: PROJECT_A,
    });
    const other = await seed(repo, {
      title: "in project B",
      state: "closed",
      projectId: PROJECT_B,
    });

    const restricted = await repo.listByStatesForRoutingTarget({
      states: TERMINAL,
      routingTarget: "operator",
      limit: 50,
      projectScope: PROJECT_A,
    });
    expect(restricted.asks.map((a) => a.id)).toEqual([scoped.id]);
    expect(restricted.total).toBe(1);

    // ALL_PROJECTS and an omitted scope must agree — the cockpit's asks route
    // passes the former on a request with no `?project=`, and the pending path
    // has always behaved as the latter.
    const all = await repo.listByStatesForRoutingTarget({
      states: TERMINAL,
      routingTarget: "operator",
      limit: 50,
      projectScope: ALL_PROJECTS,
    });
    const omitted = await repo.listByStatesForRoutingTarget({
      states: TERMINAL,
      routingTarget: "operator",
      limit: 50,
    });
    expect(new Set(all.asks.map((a) => a.id))).toEqual(new Set([scoped.id, other.id]));
    expect(all.asks.map((a) => a.id)).toEqual(omitted.asks.map((a) => a.id));
  });
});

/**
 * The linkifier's id-set source (mt#4095). Deliberately state-agnostic: the
 * defect it fixes is that an `ask#N` in a memory, spec or transcript stopped
 * resolving the moment its ask closed.
 */
describe("listShortIdsForRoutingTarget (mt#4095)", () => {
  async function seedWithShortId(
    repo: FakeAskRepository,
    s: Seed & { shortId?: string }
  ): Promise<Ask> {
    const ask = await seed(repo, s);
    repo._seedAtState({ ...ask, shortId: s.shortId });
    const reread = await repo.getById(ask.id);
    if (!reread) throw new Error("fixture re-read failed");
    return reread;
  }

  test("covers every state, not just the pending ones", async () => {
    const repo = new FakeAskRepository();
    await seedWithShortId(repo, { title: "pending", state: "suspended", shortId: "ask#1" });
    await seedWithShortId(repo, { title: "closed", state: "closed", shortId: "ask#2" });
    await seedWithShortId(repo, { title: "cancelled", state: "cancelled", shortId: "ask#3" });
    await seedWithShortId(repo, { title: "expired", state: "expired", shortId: "ask#4" });

    const pairs = await repo.listShortIdsForRoutingTarget({ routingTarget: "operator" });

    expect(new Set(pairs.map((p) => p.shortId))).toEqual(
      new Set(["ask#1", "ask#2", "ask#3", "ask#4"])
    );
  });

  test("pairs the short id with the UUID, which is the deeplink target", async () => {
    const repo = new FakeAskRepository();
    const closed = await seedWithShortId(repo, {
      title: "closed",
      state: "closed",
      shortId: "ask#7754",
    });

    const pairs = await repo.listShortIdsForRoutingTarget({ routingTarget: "operator" });

    // ADR-029: the uuid is the SOLE minsky:// deeplink target; a pair that
    // echoed the short id back would be useless to the linkifier.
    expect(pairs).toEqual([{ shortId: "ask#7754", id: closed.id }]);
  });

  test("omits rows with no short id, and other routing targets", async () => {
    const repo = new FakeAskRepository();
    await seedWithShortId(repo, { title: "mine", state: "closed", shortId: "ask#10" });
    await seedWithShortId(repo, { title: "legacy", state: "closed" });
    await seedWithShortId(repo, {
      title: "reviewer's",
      state: "closed",
      routingTarget: "reviewer",
      shortId: "ask#11",
    });

    const pairs = await repo.listShortIdsForRoutingTarget({ routingTarget: "operator" });

    expect(pairs.map((p) => p.shortId)).toEqual(["ask#10"]);
  });

  test("honors a uuid project scope", async () => {
    const repo = new FakeAskRepository();
    await seedWithShortId(repo, {
      title: "project A",
      state: "closed",
      shortId: "ask#20",
      projectId: PROJECT_A,
    });
    await seedWithShortId(repo, {
      title: "project B",
      state: "closed",
      shortId: "ask#21",
      projectId: PROJECT_B,
    });

    const scoped = await repo.listShortIdsForRoutingTarget({
      routingTarget: "operator",
      projectScope: PROJECT_A,
    });
    const all = await repo.listShortIdsForRoutingTarget({
      routingTarget: "operator",
      projectScope: ALL_PROJECTS,
    });

    expect(scoped.map((p) => p.shortId)).toEqual(["ask#20"]);
    expect(new Set(all.map((p) => p.shortId))).toEqual(new Set(["ask#20", "ask#21"]));
  });
});

/**
 * The fake's `getById` must resolve the same id FORMS the Drizzle backend does
 * (mt#4095). Without this the double, not the behavior, becomes the assertion
 * target: a short-id lookup test would pass or fail on the fake's own
 * limitations rather than on what production does (ADR-036).
 */
describe("FakeAskRepository.getById id-form parity (mt#4095)", () => {
  test("resolves an ask#N short id", async () => {
    const repo = new FakeAskRepository();
    const ask = await seed(repo, { title: "closed", state: "closed" });
    repo._seedAtState({ ...ask, shortId: "ask#7754" });

    const found = await repo.getById("ask#7754");

    expect(found?.id).toBe(ask.id);
  });

  test("resolves an unambiguous uuid prefix, and refuses an ambiguous one", async () => {
    const repo = new FakeAskRepository();
    const ask = await seed(repo, { title: "closed", state: "closed" });

    expect((await repo.getById(ask.id.slice(0, 8)))?.id).toBe(ask.id);
    // Too short to be a prefix lookup at all — must not match by accident.
    expect(await repo.getById(ask.id.slice(0, 3))).toBeNull();
  });

  test("still resolves a full uuid, and still misses an unknown id", async () => {
    const repo = new FakeAskRepository();
    const ask = await seed(repo, { title: "closed", state: "closed" });

    expect((await repo.getById(ask.id))?.id).toBe(ask.id);
    expect(await repo.getById("ask#999999")).toBeNull();
    expect(await repo.getById("not-an-id")).toBeNull();
  });
});
