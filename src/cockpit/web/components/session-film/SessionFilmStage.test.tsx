/**
 * Tests for SessionFilmStage.tsx (mt#3184).
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/components/session-film/SessionFilmStage.test.tsx
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { buildKeyframes, foldAtBatchIndex, foldEvents } from "../../lib/session-film-fold";
import { groupEventsIntoBatchRows } from "../../lib/session-film-batches";
import { computeStageLayout } from "../../lib/session-film-layout";
import { DEFAULT_SESSION_FILM_CONFIG } from "../../lib/session-film-config";
import { SessionFilmStage } from "./SessionFilmStage";

afterEach(() => cleanup());

function ev(overrides: Partial<SemanticEvent> = {}): SemanticEvent {
  return {
    schemaVersion: "v0",
    tStart: "2026-07-24T00:00:00.000Z",
    actor: { kind: "agent", agentSessionId: "a1" },
    verb: "read",
    target: { realm: "repo", id: "file:workspace:foo.ts" },
    outcome: "ok",
    weight: 1,
    adapterVersion: "test",
    ...overrides,
  };
}

function buildFixture(events: SemanticEvent[]) {
  const world = foldEvents(events, events.length - 1);
  const nowIso = events.at(-1)?.tStart ?? "2026-07-24T00:00:00.000Z";
  const layout = computeStageLayout(world, nowIso, DEFAULT_SESSION_FILM_CONFIG);
  return { world, layout };
}

/**
 * Row-aware fixture builder — unlike `buildFixture` (event-grain `foldEvents`,
 * which never populates the fan-out signal), this folds row-by-row via
 * `applyRow` (through `buildKeyframes` + `foldAtBatchIndex`, the SAME path
 * the real page uses) so `world.lastRowIsParallelBatch` /
 * `lastRowTargetsByActor` reflect the LAST row folded.
 */
function buildRowAwareFixture(events: SemanticEvent[]) {
  const rows = groupEventsIntoBatchRows(events);
  const keyframes = buildKeyframes(events, rows, DEFAULT_SESSION_FILM_CONFIG);
  const world = foldAtBatchIndex(events, rows, keyframes, rows.length - 1);
  const nowIso = events.at(-1)?.tStart ?? "2026-07-24T00:00:00.000Z";
  const layout = computeStageLayout(world, nowIso, DEFAULT_SESSION_FILM_CONFIG);
  return { world, layout };
}

describe("SessionFilmStage — realm roots + entity nodes", () => {
  test("renders all 7 realm root nodes even with no touches", () => {
    const { world, layout } = buildFixture([]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    expect(screen.getByTestId("session-film-node-repo:__root__")).toBeDefined();
    expect(screen.getByTestId("session-film-node-web:__root__")).toBeDefined();
    expect(screen.getByTestId("session-film-node-notion:__root__")).toBeDefined();
  });

  test("an in-flight (unpaired) touch renders the amber in-flight fill, not ok", () => {
    const { world, layout } = buildFixture([ev({ outcome: undefined })]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const node = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    expect(node).toBeDefined();
    const el = screen.getByTestId(`session-film-node-${node?.id}`);
    const circle = el.querySelector("circle");
    expect(circle?.getAttribute("class")).toContain("fill-warn-amber");
  });

  test("clicking an entity node fires onSelectEntity with its entity id", () => {
    const { world, layout } = buildFixture([ev()]);
    const onSelectEntity = mock(() => {});
    render(
      <SessionFilmStage layout={layout} world={world} reducedMotion={false} onSelectEntity={onSelectEntity} />
    );
    const node = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    fireEvent.click(screen.getByTestId(`session-film-node-${node?.id}`));
    expect(onSelectEntity).toHaveBeenCalledWith("file:workspace:foo.ts");
  });
});

describe("SessionFilmStage — avatars + policy denial receipts (AT4)", () => {
  test("an agent avatar renders in the iso.pastel companion color", () => {
    const { world, layout } = buildFixture([ev({ actor: { kind: "agent", agentSessionId: "a1" } })]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const avatar = screen.getByTestId("session-film-avatar-agent:a1");
    expect(avatar.getAttribute("class")).toContain("fill-iso-pastel");
  });

  test("the principal's own figure renders distinctly from agent avatars", () => {
    const { world, layout } = buildFixture([ev({ actor: { kind: "principal" }, verb: "ask" })]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const avatar = screen.getByTestId("session-film-avatar-principal");
    expect(avatar.getAttribute("class")).toContain("fill-signal-cyan");
  });

  test("a guard denial renders the policy actor with a receipt link to its guard doc", () => {
    const { world, layout } = buildFixture([
      ev({
        actor: { kind: "policy", guardName: "bypass-merge" },
        outcome: "denied",
        target: { realm: "minsky-substrate", id: "minsky:changeset:1234" },
      }),
    ]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const avatar = screen.getByTestId("session-film-avatar-policy:bypass-merge");
    expect(avatar.getAttribute("class")).toContain("fill-warn-red");
    expect(avatar.getAttribute("data-receipt-path")).toBe("docs/architecture/hooks/bypass-merge.md");
  });
});

describe("SessionFilmStage — reduced motion (AT7)", () => {
  test("under reduced motion, the avatar carries NO transition/tween class", () => {
    const { world, layout } = buildFixture([ev()]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={true} />);
    const avatar = screen.getByTestId("session-film-avatar-agent:a1");
    expect(avatar.getAttribute("class")).not.toContain("transition");
  });

  test("without reduced motion, the avatar DOES carry a transition class", () => {
    const { world, layout } = buildFixture([ev()]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const avatar = screen.getByTestId("session-film-avatar-agent:a1");
    expect(avatar.getAttribute("class")).toContain("transition");
  });
});

describe("SessionFilmStage — batch fan-out (SC5/SC10, AT1's stage half)", () => {
  test("a parallel batch renders beams to ALL targets simultaneously, avatar stays at home", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:b.ts" } }),
      ev({ batchId: "b1", target: { realm: "web", id: "web:example.com" } }),
    ];
    const { world, layout } = buildRowAwareFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);

    // All three beams render simultaneously — no sequencing, no single walk.
    expect(screen.getByTestId("session-film-beam-agent:a1-file:ws:a.ts")).toBeDefined();
    expect(screen.getByTestId("session-film-beam-agent:a1-file:ws:b.ts")).toBeDefined();
    expect(screen.getByTestId("session-film-beam-agent:a1-web:example.com")).toBeDefined();

    // The avatar itself never walks to a single target during a fan-out.
    const avatar = screen.getByTestId("session-film-avatar-agent:a1");
    expect(avatar.getAttribute("data-at-home")).toBe("true");
  });

  test("a singleton row does NOT render fan-out beams — the avatar makes an ordinary excursion", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" })];
    const { world, layout } = buildRowAwareFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    expect(screen.queryAllByTestId(/session-film-beam-/).length).toBe(0);
    const avatar = screen.getByTestId("session-film-avatar-agent:a1");
    expect(avatar.getAttribute("data-at-home")).toBeNull();
  });
});

describe("SessionFilmStage — touched-set contour (SC7, AT5)", () => {
  function crossRealmEvents(): SemanticEvent[] {
    return [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({
        batchId: "b2",
        verb: "write",
        target: { realm: "minsky-substrate", id: "minsky:task:mt#1" },
      }),
    ];
  }

  test("off by default — no contour renders without hover/click", () => {
    const { world, layout } = buildRowAwareFixture(crossRealmEvents());
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    expect(screen.queryByTestId("session-film-contour-agent:a1")).toBeNull();
  });

  test("hovering the avatar draws the contour, labeled 'touched', spanning >=2 realm trees", () => {
    const { world, layout } = buildRowAwareFixture(crossRealmEvents());
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const avatar = screen.getByTestId("session-film-avatar-agent:a1");
    fireEvent.mouseEnter(avatar);
    const contour = screen.getByTestId("session-film-contour-agent:a1");
    expect(contour.getAttribute("aria-label")).toBe("touched");
    expect(contour.getAttribute("d")).toBeTruthy();
  });

  test("mouse leave hides the (un-pinned) contour again", () => {
    const { world, layout } = buildRowAwareFixture(crossRealmEvents());
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const avatar = screen.getByTestId("session-film-avatar-agent:a1");
    fireEvent.mouseEnter(avatar);
    expect(screen.getByTestId("session-film-contour-agent:a1")).toBeDefined();
    fireEvent.mouseLeave(avatar);
    expect(screen.queryByTestId("session-film-contour-agent:a1")).toBeNull();
  });

  test("clicking the avatar PINS the contour open even after the mouse leaves", () => {
    const { world, layout } = buildRowAwareFixture(crossRealmEvents());
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const avatar = screen.getByTestId("session-film-avatar-agent:a1");
    fireEvent.click(avatar);
    fireEvent.mouseEnter(avatar);
    fireEvent.mouseLeave(avatar);
    expect(screen.getByTestId("session-film-contour-agent:a1")).toBeDefined();
    fireEvent.click(avatar); // click again unpins
    expect(screen.queryByTestId("session-film-contour-agent:a1")).toBeNull();
  });

  test("the contour uses the agent's brand agent-identity color (iso.pastel)", () => {
    const { world, layout } = buildRowAwareFixture(crossRealmEvents());
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    fireEvent.mouseEnter(screen.getByTestId("session-film-avatar-agent:a1"));
    const contour = screen.getByTestId("session-film-contour-agent:a1");
    expect(contour.getAttribute("class")).toContain("iso-pastel");
  });
});

describe("SessionFilmStage — spawn buds + workspace-clone sub-territory (SC5)", () => {
  test("a spawn event renders a distinct badge with its kind label, not a plain circle", () => {
    const events: SemanticEvent[] = [
      ev({
        batchId: "b1",
        verb: "spawn",
        target: { realm: "agents", id: "agents:Explore", raw: { subagent_type: "Explore" } },
        outcome: "ok",
      }),
    ];
    const { world, layout } = buildFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const node = layout.nodes.find((n) => n.entityId === "agents:Explore");
    if (!node) throw new Error("fixture node missing — test setup bug");
    const el = screen.getByTestId(`session-film-node-${node.id}`);
    expect(el.getAttribute("data-spawn-bud")).toBe("true");
    expect(el.getAttribute("data-spawn-kind")).toBe("Explore");
    // A spawn bud is a <rect> badge, not a <circle> node.
    expect(el.querySelector("rect")).toBeDefined();
  });

  test("a clone event renders a bordered sub-territory with a tree glyph and a clone-of arc to the repo root", () => {
    const events: SemanticEvent[] = [
      ev({
        batchId: "b1",
        verb: "clone",
        target: { realm: "minsky-substrate", id: "minsky:workspace:mt-9999" },
        outcome: "ok",
      }),
    ];
    const { world, layout } = buildFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const node = layout.nodes.find((n) => n.entityId === "minsky:workspace:mt-9999");
    if (!node) throw new Error("fixture node missing — test setup bug");

    const el = screen.getByTestId(`session-film-node-${node.id}`);
    expect(el.getAttribute("data-clone-territory")).toBe("true");
    expect(screen.getByTestId("session-film-clone-border")).toBeDefined();
    expect(screen.getByTestId("session-film-clone-tree-glyph")).toBeDefined();

    const arc = screen.getByTestId(`session-film-clone-arc-${node.id}`);
    expect(arc.getAttribute("aria-label")).toBe("clone-of");
  });
});
