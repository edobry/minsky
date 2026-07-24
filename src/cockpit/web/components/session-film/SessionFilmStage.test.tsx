/**
 * Tests for SessionFilmStage.tsx (mt#3184).
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/components/session-film/SessionFilmStage.test.tsx
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { foldEvents } from "../../lib/session-film-fold";
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
