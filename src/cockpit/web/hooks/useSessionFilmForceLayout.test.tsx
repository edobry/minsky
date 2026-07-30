/**
 * Tests for useSessionFilmForceLayout.ts (mt#3231 SC 4).
 *
 * Deliberately light: the FORCE-SIMULATION logic itself is thoroughly
 * covered at the pure-module level (session-film-force-layout.test.ts).
 * This file covers the REACT-SPECIFIC wiring: it renders successfully under
 * both reduced-motion states (a regression guard for the reference-
 * stability bug this hook's own comments document — an earlier version
 * returned a brand-new `nodes` array every render, which combined with a
 * downstream reference-keyed effect to become a synchronous infinite
 * render loop), and returns a `StageLayout`-shaped value.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup, screen } from "@testing-library/react";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { foldEvents } from "../lib/session-film-fold";
import { computeStageLayout } from "../lib/session-film-layout";
import { DEFAULT_SESSION_FILM_CONFIG } from "../lib/session-film-config";
import { useSessionFilmForceLayout } from "./useSessionFilmForceLayout";

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

function Probe({ reducedMotion }: { reducedMotion: boolean }) {
  const events: SemanticEvent[] = [ev()];
  const world = foldEvents(events, events.length - 1);
  const staticLayout = computeStageLayout(world, events[0]?.tStart ?? "", DEFAULT_SESSION_FILM_CONFIG);
  const live = useSessionFilmForceLayout(staticLayout, DEFAULT_SESSION_FILM_CONFIG, reducedMotion);
  return (
    <div data-testid="probe" data-node-count={live.nodes.length} data-home-x={live.homeX} />
  );
}

describe("useSessionFilmForceLayout — React wiring (mt#3231 SC 4)", () => {
  test("renders without hanging under reducedMotion=true (regression guard: reference-stability infinite-loop bug)", () => {
    const start = Date.now();
    render(<Probe reducedMotion={true} />);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("renders without hanging under reducedMotion=false", () => {
    const start = Date.now();
    render(<Probe reducedMotion={false} />);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("returns a StageLayout-shaped value with the SAME node count as the static input", () => {
    const events: SemanticEvent[] = [ev()];
    const world = foldEvents(events, events.length - 1);
    const staticLayout = computeStageLayout(world, events[0]?.tStart ?? "", DEFAULT_SESSION_FILM_CONFIG);
    render(<Probe reducedMotion={true} />);
    const probe = screen.getByTestId("probe");
    expect(Number(probe.getAttribute("data-node-count"))).toBe(staticLayout.nodes.length);
    expect(Number(probe.getAttribute("data-home-x"))).toBe(staticLayout.homeX);
  });
});
