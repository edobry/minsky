/**
 * Tests for SessionFilmStage.tsx (mt#3184).
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/components/session-film/SessionFilmStage.test.tsx
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

  test("a singleton row does NOT render FAN-OUT beams — the avatar makes an ordinary excursion (it still gets its OWN single action beam, mt#3231 SC 7)", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" })];
    const { world, layout } = buildRowAwareFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    for (const beam of screen.queryAllByTestId(/session-film-beam-/)) {
      expect(beam.getAttribute("data-fan-out")).toBeNull();
    }
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

describe("SessionFilmStage — aliveness pass (mt#3226 SC 4 / AT 5)", () => {
  test("prefers-reduced-motion renders NO ambient affordances at all", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" })];
    const { world, layout } = buildFixture(events);
    const { container } = render(
      <SessionFilmStage layout={layout} world={world} reducedMotion={true} nowIso={events[0]?.tStart} />
    );
    // No bloom filter defs, no glow-underlay circles, no avatar glow, no
    // ambient scene marker — "renders no ambient animation classes/elements."
    expect(container.querySelector("defs")).toBeNull();
    expect(container.querySelector('[data-testid^="session-film-glow-"]')).toBeNull();
    expect(container.querySelector('[data-testid^="session-film-avatar-glow-"]')).toBeNull();
    expect(screen.getByTestId("session-film-stage-scene").getAttribute("data-ambient")).toBeNull();
    expect(container.querySelector(".session-film-avatar-float")).toBeNull();
    expect(container.querySelector(".session-film-arrival-settle")).toBeNull();
  });

  test("default (motion allowed) renders the ambient scene marker, bloom defs, and avatar glow/float", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" })];
    const { world, layout } = buildFixture(events);
    const { container } = render(
      <SessionFilmStage layout={layout} world={world} reducedMotion={false} nowIso={events[0]?.tStart} />
    );
    expect(screen.getByTestId("session-film-stage-scene").getAttribute("data-ambient")).toBe("true");
    expect(container.querySelector("defs filter")).not.toBeNull();
    const agentKey = [...world.agents.keys()][0];
    if (!agentKey) throw new Error("fixture agent missing — test setup bug");
    expect(screen.getByTestId(`session-film-avatar-glow-${agentKey}`)).toBeDefined();
    expect(
      screen.getByTestId(`session-film-avatar-${agentKey}`).className
    ).toContain("session-film-avatar-float");
  });

  test("a touched entity renders a glow-underlay circle whose opacity reflects recency (brighter = more recent)", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:fresh.ts" } }),
    ];
    const { world, layout } = buildFixture(events);
    const node = layout.nodes.find((n) => n.entityId === "file:ws:fresh.ts");
    if (!node) throw new Error("fixture node missing — test setup bug");

    // Fresh touch, playhead AT the touch moment — near-max brightness.
    const { container: freshContainer } = render(
      <SessionFilmStage layout={layout} world={world} reducedMotion={false} nowIso="2026-07-24T00:00:00.000Z" />
    );
    const freshGlow = freshContainer.querySelector(`[data-testid="session-film-glow-${node.id}"]`);
    expect(freshGlow).not.toBeNull();
    const freshOpacity = Number((freshGlow as SVGCircleElement).style.opacity);

    cleanup();

    // Same touch, playhead an hour later — cooled, dimmer halo.
    const { container: staleContainer } = render(
      <SessionFilmStage layout={layout} world={world} reducedMotion={false} nowIso="2026-07-24T01:00:00.000Z" />
    );
    const staleGlow = staleContainer.querySelector(`[data-testid="session-film-glow-${node.id}"]`);
    const staleOpacity = Number((staleGlow as SVGCircleElement).style.opacity);

    expect(freshOpacity).toBeGreaterThan(staleOpacity);
  });

  test("a newly-materialized node gets the arrival spring-settle class", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:brand-new.ts" } }),
    ];
    const { world, layout } = buildFixture(events);
    const node = layout.nodes.find((n) => n.entityId === "file:ws:brand-new.ts");
    if (!node) throw new Error("fixture node missing — test setup bug");
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} nowIso={events[0]?.tStart} />);
    const el = screen.getByTestId(`session-film-node-${node.id}`);
    const circle = el.querySelector("circle");
    expect(circle?.getAttribute("class")).toContain("session-film-arrival-settle");
  });
});

describe("SessionFilmStage — beam on every action (mt#3231 SC 7 / AT 7)", () => {
  test("a single (non-batch) read event renders a beam from target toward the agent", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1", verb: "read" })];
    const { world, layout } = buildRowAwareFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const beam = screen.getByTestId(`session-film-beam-agent:a1-file:workspace:foo.ts`);
    expect(beam.getAttribute("data-beam-kind")).toBe("pull");
    // pull: x1/y1 is the TARGET, x2/y2 is home (energy flows toward the agent).
    const targetNode = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    if (!targetNode) throw new Error("fixture node missing — test setup bug");
    expect(Number(beam.getAttribute("x1"))).toBe(targetNode.x);
    expect(Number(beam.getAttribute("x2"))).toBe(layout.homeX);
  });

  test("a write renders a beam from the agent toward the target — the opposite direction of a read", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1", verb: "write" })];
    const { world, layout } = buildRowAwareFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const beam = screen.getByTestId(`session-film-beam-agent:a1-file:workspace:foo.ts`);
    expect(beam.getAttribute("data-beam-kind")).toBe("push");
    const targetNode = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    if (!targetNode) throw new Error("fixture node missing — test setup bug");
    expect(Number(beam.getAttribute("x1"))).toBe(layout.homeX);
    expect(Number(beam.getAttribute("x2"))).toBe(targetNode.x);
  });

  test("an error renders the distinct bounce treatment, not an ordinary push/pull", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1", verb: "write", outcome: "error" })];
    const { world, layout } = buildRowAwareFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const beam = screen.getByTestId(`session-film-beam-agent:a1-file:workspace:foo.ts`);
    expect(beam.getAttribute("data-beam-kind")).toBe("bounce");
    expect(beam.getAttribute("class")).toContain("warn-red");
  });

  test("read/write/error beams are all visually distinct from one another", () => {
    const pullEvents: SemanticEvent[] = [ev({ batchId: "b1", verb: "read" })];
    const { world: pullWorld, layout: pullLayout } = buildRowAwareFixture(pullEvents);
    const { unmount } = render(
      <SessionFilmStage layout={pullLayout} world={pullWorld} reducedMotion={false} />
    );
    const pullBeam = screen.getByTestId("session-film-beam-agent:a1-file:workspace:foo.ts");
    const pullKind = pullBeam.getAttribute("data-beam-kind");
    unmount();

    const pushEvents: SemanticEvent[] = [ev({ batchId: "b1", verb: "write" })];
    const { world: pushWorld, layout: pushLayout } = buildRowAwareFixture(pushEvents);
    const { unmount: unmount2 } = render(
      <SessionFilmStage layout={pushLayout} world={pushWorld} reducedMotion={false} />
    );
    const pushBeam = screen.getByTestId("session-film-beam-agent:a1-file:workspace:foo.ts");
    const pushKind = pushBeam.getAttribute("data-beam-kind");
    unmount2();

    const errorEvents: SemanticEvent[] = [ev({ batchId: "b1", verb: "write", outcome: "error" })];
    const { world: errorWorld, layout: errorLayout } = buildRowAwareFixture(errorEvents);
    render(<SessionFilmStage layout={errorLayout} world={errorWorld} reducedMotion={false} />);
    const errorBeam = screen.getByTestId("session-film-beam-agent:a1-file:workspace:foo.ts");
    const errorKind = errorBeam.getAttribute("data-beam-kind");

    expect(new Set([pullKind, pushKind, errorKind]).size).toBe(3);
  });

  test("a conversational (think) event renders no beam — nothing to beam to", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1", verb: "think", actor: { kind: "agent", agentSessionId: "a1" } })];
    const { world, layout } = buildRowAwareFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    expect(screen.queryAllByTestId(/session-film-beam-/).length).toBe(0);
  });

  test("a fanned-out parallel batch is NOT double-beamed by the singleton path", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:b.ts" } }),
    ];
    const { world, layout } = buildRowAwareFixture(events);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    // Exactly the two fan-out beams — no extra singleton beam for the same actor.
    const beams = screen.queryAllByTestId(/session-film-beam-agent:a1/);
    expect(beams.length).toBe(2);
    for (const beam of beams) {
      expect(beam.getAttribute("data-fan-out")).toBe("true");
    }
  });
});

describe("SessionFilmStage — node labels + hover + working click (mt#3231 SC 6 / AT 6)", () => {
  test("a leaf entity node carries a visible-on-hover <title> with its label", () => {
    const { world, layout } = buildFixture([ev()]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const node = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    if (!node) throw new Error("fixture node missing — test setup bug");
    const el = screen.getByTestId(`session-film-node-${node.id}`);
    const title = el.querySelector("title");
    expect(title).not.toBeNull();
    expect(title?.textContent).toContain(node.label);
  });

  test("clicking a node invokes onSelectEntity AND renders a visible detail panel for that entity", () => {
    const { world, layout } = buildFixture([ev()]);
    const onSelectEntity = mock(() => {});
    render(
      <SessionFilmStage layout={layout} world={world} reducedMotion={false} onSelectEntity={onSelectEntity} />
    );
    const node = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    if (!node) throw new Error("fixture node missing — test setup bug");
    fireEvent.click(screen.getByTestId(`session-film-node-${node.id}`));
    expect(onSelectEntity).toHaveBeenCalledWith("file:workspace:foo.ts");
    const panel = screen.getByTestId("session-film-entity-detail-panel");
    expect(panel.textContent).toContain("file:workspace:foo.ts");
    expect(panel.textContent).toContain("repo");
  });

  test("the detail panel renders an EntityRef deeplink for a routable minsky-substrate entity", () => {
    const events: SemanticEvent[] = [
      ev({ target: { realm: "minsky-substrate", id: "minsky:task:mt#1772" } }),
    ];
    const { world, layout } = buildFixture(events);
    const originalFetch = global.fetch;
    global.fetch = mock(async () => ({
      ok: false,
      json: async () => ({ state: "degraded", reason: "not mocked in test" }),
    })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionFilmStage layout={layout} world={world} reducedMotion={false} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const node = layout.nodes.find((n) => n.entityId === "minsky:task:mt#1772");
    if (!node) throw new Error("fixture node missing — test setup bug");
    fireEvent.click(screen.getByTestId(`session-film-node-${node.id}`));
    const panel = screen.getByTestId("session-film-entity-detail-panel");
    expect(panel.querySelector("a")).not.toBeNull();
    global.fetch = originalFetch;
  });

  test("closing the detail panel hides it again", () => {
    const { world, layout } = buildFixture([ev()]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const node = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    if (!node) throw new Error("fixture node missing — test setup bug");
    fireEvent.click(screen.getByTestId(`session-film-node-${node.id}`));
    expect(screen.getByTestId("session-film-entity-detail-panel")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Close entity detail"));
    expect(screen.queryByTestId("session-film-entity-detail-panel")).toBeNull();
  });

  // ── mt#3231 review R1, BLOCKING: the panel was non-dismissible whenever a
  // parent controlled `selectedEntityId` — the close button only cleared
  // this component's OWN internal fallback state, never the parent's. ──

  test("closing the detail panel ALSO works when a parent controls selectedEntityId (open-then-close, controlled mode)", () => {
    const { world, layout } = buildFixture([ev()]);
    function ControlledHarness() {
      const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
      return (
        <SessionFilmStage
          layout={layout}
          world={world}
          reducedMotion={false}
          onSelectEntity={setSelectedEntityId}
          selectedEntityId={selectedEntityId}
        />
      );
    }
    render(<ControlledHarness />);
    const node = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    if (!node) throw new Error("fixture node missing — test setup bug");

    fireEvent.click(screen.getByTestId(`session-film-node-${node.id}`));
    expect(screen.getByTestId("session-film-entity-detail-panel")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Close entity detail"));
    expect(screen.queryByTestId("session-film-entity-detail-panel")).toBeNull();
  });

  test("the Escape key closes the detail panel", () => {
    const { world, layout } = buildFixture([ev()]);
    render(<SessionFilmStage layout={layout} world={world} reducedMotion={false} />);
    const node = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    if (!node) throw new Error("fixture node missing — test setup bug");
    fireEvent.click(screen.getByTestId(`session-film-node-${node.id}`));
    expect(screen.getByTestId("session-film-entity-detail-panel")).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("session-film-entity-detail-panel")).toBeNull();
  });

  test("a pointerdown outside the detail panel closes it", () => {
    const { world, layout } = buildFixture([ev()]);
    render(
      <div>
        <div data-testid="outside-target">elsewhere on the page</div>
        <SessionFilmStage layout={layout} world={world} reducedMotion={false} />
      </div>
    );
    const node = layout.nodes.find((n) => n.entityId === "file:workspace:foo.ts");
    if (!node) throw new Error("fixture node missing — test setup bug");
    fireEvent.click(screen.getByTestId(`session-film-node-${node.id}`));
    expect(screen.getByTestId("session-film-entity-detail-panel")).toBeDefined();
    fireEvent.pointerDown(screen.getByTestId("outside-target"));
    expect(screen.queryByTestId("session-film-entity-detail-panel")).toBeNull();
  });
});
