/**
 * mt#4205 — disposition of a recognized cockpit holding the port.
 *
 * Deliberately a SEPARATE file from `port-recovery.test.ts`, which races on the
 * workspace's real cockpit state file under the gated suite in two independent
 * ways (mt#3543, mt#3733). Every case below runs through injected probes, so
 * nothing here binds a port, spawns a process, reads the state file, or makes an
 * HTTP request — adding these to that file would have produced a third flake
 * rather than a regression signal.
 */
import { describe, test, expect } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import {
  decideIncumbentDisposition,
  resolveIncumbentDisposition,
  realIncumbentProbes,
  COCKPIT_SERVICE_IDENTITY,
  PID_REUSE_SKEW_MS,
  type IncumbentEvidence,
  type IncumbentProbes,
} from "./port-recovery";

/** A holder whose start time corroborates the record — the displace-eligible shape. */
const CONSISTENT_START: Pick<IncumbentEvidence, "holderStartedAtMs" | "recordedStartedAtMs"> = {
  holderStartedAtMs: 1_000_000,
  // The state file is written shortly AFTER the process starts, so the recorded
  // time sits slightly later. This is the normal, healthy relationship.
  recordedStartedAtMs: 1_002_000,
};

describe("decideIncumbentDisposition — an incumbent that ANSWERS is preserved", () => {
  test("answering as minsky-cockpit preserves", () => {
    const d = decideIncumbentDisposition({
      health: { service: COCKPIT_SERVICE_IDENTITY },
      ...CONSISTENT_START,
    });
    expect(d.kind).toBe("preserve");
  });

  test("a 503-shaped answer still preserves — the status is never consulted", () => {
    // The daemon answers 503 while persistence is unhealthy (mt#2949), and
    // mt#3638's pool-recycle self-heals it. Reading that as "not serving" would
    // SIGKILL a live process for correctly reporting a problem, which is the
    // exact defect this task's own spec originally described. The probe
    // contract encodes this by reporting only the identity, so a degraded
    // answer is indistinguishable here from a healthy one — by design.
    const d = decideIncumbentDisposition({
      health: { service: COCKPIT_SERVICE_IDENTITY },
      ...CONSISTENT_START,
    });
    expect(d).toEqual({
      kind: "preserve",
      reason: `it is answering /api/health as ${COCKPIT_SERVICE_IDENTITY}`,
    });
  });

  test("an answer with NO service field preserves (fail-closed, mt#3148)", () => {
    const d = decideIncumbentDisposition({ health: { service: null }, ...CONSISTENT_START });
    expect(d.kind).toBe("preserve");
    if (d.kind === "preserve") expect(d.reason).toContain("absent");
  });

  test("an answer from a DIFFERENT Minsky service preserves", () => {
    // Every Minsky service is built from the same monorepo and answers 200
    // identically; only the identity separates them.
    const d = decideIncumbentDisposition({
      health: { service: "minsky-mcp" },
      ...CONSISTENT_START,
    });
    expect(d.kind).toBe("preserve");
    if (d.kind === "preserve") expect(d.reason).toContain("minsky-mcp");
  });
});

describe("decideIncumbentDisposition — only a silent incumbent is displaced", () => {
  test("nothing answered, start times corroborate → displace", () => {
    expect(decideIncumbentDisposition({ health: null, ...CONSISTENT_START })).toEqual({
      kind: "displace",
    });
  });

  test("a recycled PID preserves — the holder started long after the record", () => {
    const d = decideIncumbentDisposition({
      health: null,
      holderStartedAtMs: 5_000_000,
      recordedStartedAtMs: 1_000_000,
    });
    expect(d.kind).toBe("preserve");
    if (d.kind === "preserve") expect(d.reason).toContain("recycled");
  });

  test("an unreadable holder start time preserves rather than guessing", () => {
    const d = decideIncumbentDisposition({
      health: null,
      holderStartedAtMs: null,
      recordedStartedAtMs: 1_000_000,
    });
    expect(d.kind).toBe("preserve");
  });

  test("an absent state-file start time preserves rather than guessing", () => {
    const d = decideIncumbentDisposition({
      health: null,
      holderStartedAtMs: 1_000_000,
      recordedStartedAtMs: null,
    });
    expect(d.kind).toBe("preserve");
  });

  test("clock jitter inside the skew window still displaces", () => {
    // `ps` reports whole seconds and Date.now() drifts, so the recorded time can
    // land slightly BEFORE the holder's computed start without meaning reuse.
    expect(
      decideIncumbentDisposition({
        health: null,
        holderStartedAtMs: 1_000_000,
        recordedStartedAtMs: 1_000_000 - (PID_REUSE_SKEW_MS - 1),
      })
    ).toEqual({ kind: "displace" });
  });

  test("just past the skew window preserves", () => {
    const d = decideIncumbentDisposition({
      health: null,
      holderStartedAtMs: 1_000_000,
      recordedStartedAtMs: 1_000_000 - (PID_REUSE_SKEW_MS + 1),
    });
    expect(d.kind).toBe("preserve");
  });
});

describe("realIncumbentProbes.health — what counts as an ANSWER", () => {
  // The cases above prove the DECISION preserves when something answered. These
  // prove the real probe REPORTS a degraded answer as an answer — the gap
  // between them is exactly where an `resp.ok` check would sit, and an `resp.ok`
  // check passes every test above while displacing a live 503-ing daemon.
  //
  // Binds an EPHEMERAL port (0) rather than a fixed one, so nothing here can
  // collide with a real cockpit or with a parallel test.
  async function withServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (port: number) => Promise<void>
  ): Promise<void> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no ephemeral port");
      await run(addr.port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test("a 503 carrying our identity is an ANSWER, not absence", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ service: COCKPIT_SERVICE_IDENTITY, status: "degraded" }));
      },
      async (port) => {
        expect(await realIncumbentProbes.health(port)).toEqual({
          service: COCKPIT_SERVICE_IDENTITY,
        });
      }
    );
  });

  test("a 200 with no service field answers, but carries no identity", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      },
      async (port) => {
        expect(await realIncumbentProbes.health(port)).toEqual({ service: null });
      }
    );
  });

  test("an unparseable body still answers", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not json</html>");
      },
      async (port) => {
        expect(await realIncumbentProbes.health(port)).toEqual({ service: null });
      }
    );
  });

  test("nothing listening is absence", async () => {
    // Claim an ephemeral port, then release it — nothing is listening on it now.
    let freed = 0;
    await withServer(
      (_req, res) => res.end(),
      async (port) => {
        freed = port;
      }
    );
    expect(await realIncumbentProbes.health(freed)).toBeNull();
  });
});

describe("resolveIncumbentDisposition — gathers from the probe seam", () => {
  function probes(over: Partial<IncumbentProbes> = {}): IncumbentProbes {
    return {
      health: async () => ({ service: COCKPIT_SERVICE_IDENTITY }),
      processStartedAtMs: () => CONSISTENT_START.holderStartedAtMs,
      recordedStartedAtMs: () => CONSISTENT_START.recordedStartedAtMs,
      ...over,
    };
  }

  test("passes the probed port and pid through to the probes", async () => {
    const seen: { port?: number; pid?: number } = {};
    await resolveIncumbentDisposition(
      3737,
      4242,
      probes({
        health: async (port) => {
          seen.port = port;
          return null;
        },
        processStartedAtMs: (pid) => {
          seen.pid = pid;
          return CONSISTENT_START.holderStartedAtMs;
        },
      })
    );
    expect(seen).toEqual({ port: 3737, pid: 4242 });
  });

  test("a serving incumbent resolves to preserve", async () => {
    expect((await resolveIncumbentDisposition(3737, 1, probes())).kind).toBe("preserve");
  });

  test("a silent incumbent resolves to displace", async () => {
    const d = await resolveIncumbentDisposition(3737, 1, probes({ health: async () => null }));
    expect(d).toEqual({ kind: "displace" });
  });
});
