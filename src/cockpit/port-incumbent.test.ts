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
  classifyHolderAgainstState,
  decideIncumbentDisposition,
  resolveIncumbentDisposition,
  realIncumbentProbes,
  healthProbeAuthorities,
  parseElapsedSeconds,
  startedAtMsFromElapsed,
  COCKPIT_SERVICE_IDENTITY,
  PID_REUSE_SKEW_MS,
  type IncumbentEvidence,
  type IncumbentProbes,
} from "./port-recovery";

const JSON_HEADERS = { "content-type": "application/json" } as const;

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

describe("parseElapsedSeconds — ps -o etime=", () => {
  // The first implementation asked ps for `etimes`, which macOS does not have;
  // it returned null for every live process, and because an unreadable start
  // time preserves, the displacement path was silently unreachable. Every test
  // above passed throughout — they inject the probe. These cases pin the
  // portable spelling's actual output format.
  test.each([
    ["00:03", 3],
    ["00:59", 59],
    ["01:00", 60],
    ["59:59", 3599],
    ["01:02:03", 3723],
    ["2-01:02:03", 176_523],
    ["  00:07  ", 7],
  ])("parses %p as %p seconds", (raw, expected) => {
    expect(parseElapsedSeconds(raw as string)).toBe(expected as number);
  });

  test.each([[""], ["keyword not found"], ["abc"], ["12"]])(
    "returns null for unparseable %p",
    (raw) => {
      expect(parseElapsedSeconds(raw as string)).toBeNull();
    }
  );

  // mt#4260. The regex matches POSITIONS and bounds no field, so every case
  // below used to parse into a confident seconds count. The last one is the
  // value a `test-forced-tz` CI run actually reported on 2026-08-18 — an age of
  // ~1.2 million years for a `sleep` spawned microseconds earlier.
  test.each([
    ["00:99"], // seconds past a clock field
    ["99:00"], // minutes past a clock field
    ["24:00:00"], // hours past 23 — procps rolls into the days field instead
    ["0-99:99:99"], // every field out of range at once
    ["99999999:00:00"],
    ["10585853616:18:40"], // == 38,109,073,018,720s, the observed CI value
  ])("returns null for out-of-range %p rather than summing it", (raw) => {
    expect(parseElapsedSeconds(raw as string)).toBeNull();
  });

  test("the documented rendering's boundary values still parse", () => {
    // The bound must reject garbage without rejecting legitimate maxima, or it
    // trades a fabricated age for a spurious null.
    expect(parseElapsedSeconds("23:59:59")).toBe(86_399);
    expect(parseElapsedSeconds("0-23:59:59")).toBe(86_399);
    // Days is genuinely unbounded — a process can run for years.
    expect(parseElapsedSeconds("3650-00:00:00")).toBe(315_360_000);
  });

  // -------------------------------------------------------------------------
  // mt#4275: the DAYS rendering, which mt#4260's field bounds leave open.
  // -------------------------------------------------------------------------

  test("mt#4275: the days field is NOT bounded — the parse stays faithful", () => {
    // This is the reading that defeated mt#4260's guard, in the form CI saw it.
    // Every bounded field is in range (00 hours, 18 minutes, 40 seconds); only
    // the day count is absurd, and `parseElapsedSeconds` deliberately does not
    // judge it. Asserting this pins the division of labour: the parser reports
    // what the string says, the consumer decides whether it is possible.
    expect(parseElapsedSeconds("441077234-00:18:40")).toBe(38_109_073_018_720);

    // Same garbage, the rendering mt#4260 DID bound — 10,585,853,616 hours is
    // exactly 441,077,234 days, which is how the two occurrences were identified
    // as one reading rather than two coincidences.
    expect(parseElapsedSeconds("10585853616:18:40")).toBeNull();
  });
});

describe("startedAtMsFromElapsed — the epoch bound (mt#4275)", () => {
  // A fixed "now" rather than Date.now(): the function takes the clock as a
  // parameter precisely so these assertions do not depend on when they run.
  const NOW_MS = new Date("2026-08-19T00:00:00.000Z").getTime();

  test("rejects a reading that would place the start before the UNIX epoch", () => {
    // The CI failure, end to end. Pre-mt#4275 this returned a NEGATIVE timestamp,
    // which the caller then rendered as an age of ~1.2 million years.
    expect(startedAtMsFromElapsed("441077234-00:18:40", NOW_MS)).toBeNull();
  });

  test("a genuinely long-lived process still yields a real timestamp", () => {
    // ~10 years. The bound rejects IMPOSSIBLE readings, not merely large ones —
    // if this returned null the fix would have replaced one wrong answer with
    // another.
    const tenYears = startedAtMsFromElapsed("3650-00:00:00", NOW_MS);
    expect(tenYears).toBe(NOW_MS - 315_360_000 * 1000);
    expect(tenYears).toBeGreaterThan(0);
  });

  test("the exact epoch boundary is admitted, not rejected", () => {
    // elapsed == now: start time is exactly 0. `< 0` is the bound, so this is
    // the last accepted value — worth pinning so a later `<= 0` does not slip in.
    const elapsedSecToEpoch = NOW_MS / 1000;
    const raw = `${Math.floor(elapsedSecToEpoch / 86_400)}-00:00:00`;
    const result = startedAtMsFromElapsed(raw, NOW_MS);
    expect(result).not.toBeNull();
    expect(result as number).toBeGreaterThanOrEqual(0);
  });

  test("an ordinary recent reading passes through unchanged", () => {
    expect(startedAtMsFromElapsed("00:30", NOW_MS)).toBe(NOW_MS - 30_000);
  });

  test("an unparseable reading is still null, via the parser", () => {
    expect(startedAtMsFromElapsed("not-a-time", NOW_MS)).toBeNull();
    expect(startedAtMsFromElapsed("99:00", NOW_MS)).toBeNull();
  });

  test("a live process yields a plausible start time, and a dead pid yields null", async () => {
    // The end-to-end shell-out — the exact check that caught the `etimes` bug.
    const child = Bun.spawn(["sleep", "30"]);
    try {
      const startedAt = realIncumbentProbes.processStartedAtMs(child.pid);

      // mt#4275: assert what the probe PROMISES — a plausible timestamp, or an
      // explicit null — rather than `not.toBeNull()`.
      //
      // The old assertion contradicted the code it guards. Some CI runners emit
      // an `etime` of ~441 million days for a process spawned microseconds
      // earlier; on such a host `null` is the CORRECT answer, and a test that
      // fails on it is failing the probe for behaving properly. The end-to-end
      // shell-out is kept — it is what caught the original `etimes` bug — but
      // its contract is now the disjunction the probe actually offers.
      //
      // What this still catches, which is the point of the live probe: a
      // fabricated age. If the probe ever returns a NUMBER, that number must be
      // plausible for a process spawned moments ago. The pre-mt#4275 failure was
      // exactly this — a non-null 1.2-million-year age — and it would still be
      // caught here.
      if (startedAt !== null) {
        // `no-real-fs-in-tests` guards against Date.now()-derived FILE PATHS
        // colliding across parallel tests. Nothing here touches the filesystem:
        // the clock IS the quantity under test, because the probe's entire job is
        // converting `ps` elapsed time into an absolute start time.
        // eslint-disable-next-line custom/no-real-fs-in-tests -- clock under test, no paths
        const ageMs = Date.now() - startedAt;
        // Generous bound: `etime` has whole-second granularity, so a process
        // started moments ago can read as up to ~1s old.
        expect(ageMs).toBeGreaterThanOrEqual(0);
        expect(ageMs).toBeLessThan(60_000);
      }
    } finally {
      child.kill();
    }
    // mt#4275 R1: don't GUESS a dead pid — make one.
    //
    // This was `processStartedAtMs(4_194_302)`, picked to sit just under Linux's
    // usual `pid_max` of 4,194,304. That reasoning is backwards: being under
    // pid_max is exactly what makes it ALLOCATABLE, so on a busy runner the pid
    // can be live, `ps` answers, and the assertion fails. It is the same
    // ambient-machine-state dependency this file has been bitten by twice today.
    //
    // Spawning and reaping gives a pid that is definitively gone: `exited`
    // resolves only after the child is reaped, so the pid is free at that point.
    const doomed = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    doomed.kill();
    await doomed.exited;
    expect(realIncumbentProbes.processStartedAtMs(doomed.pid)).toBeNull();
  });
});

describe("healthProbeAuthorities — probe the door the incumbent is holding", () => {
  // PR #3064 R1 (BLOCKING). The probe hardcoded `localhost`, whose resolution
  // order varies by platform and runtime — while `findPortHolder` identifies
  // the holder with `lsof -i tcp@localhost`, chosen in mt#3787 because it
  // reaches BOTH loopback families. So the classifier could hand back a holder
  // the probe never reached, and the miss reads as "nothing answered", which is
  // the branch that kills.
  test.each([
    ["127.0.0.1", ["127.0.0.1"]],
    ["192.168.1.50", ["192.168.1.50"]],
    ["::1", ["[::1]"]],
    ["fe80::1", ["[fe80::1]"]],
  ])("a specific bind host %p probes exactly it: %p", (host, expected) => {
    expect(healthProbeAuthorities(host as string)).toEqual(expected as string[]);
  });

  test.each([["0.0.0.0"], ["::"], ["*"], [""], ["localhost"]])(
    "the ambiguous/wildcard host %p probes BOTH loopback families",
    (host) => {
      expect(healthProbeAuthorities(host as string)).toEqual(["127.0.0.1", "[::1]"]);
    }
  );

  test("an IPv6-only listener is reached — the case lsof was chosen for", async () => {
    // Honest bound on what this proves: run against the pre-fix hardcoded
    // `localhost`, this case still PASSES on a machine where `localhost`
    // resolves ::1-first (measured here: Bun returns ::1 then 127.0.0.1). So it
    // documents that the wildcard path reaches an IPv6 listener; it does not by
    // itself discriminate the fix on this platform. The cases that do are the
    // authority assertions above — all 9 go red against the old behavior — and
    // the sharpest real-world case is a specific non-loopback `--host`, which
    // `localhost` can never reach and which cannot be bound portably in a test.
    const server = createServer((_req, res) => {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ service: COCKPIT_SERVICE_IDENTITY }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", resolve);
    }).catch(() => null);

    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      // No IPv6 loopback on this machine — nothing to assert, and skipping is
      // honest: the case is unreachable here, not passing.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    }
    try {
      // Wildcard resolution must find it via the [::1] candidate.
      expect(await realIncumbentProbes.health(addr.port, "0.0.0.0")).toEqual({
        service: COCKPIT_SERVICE_IDENTITY,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
        res.writeHead(503, JSON_HEADERS);
        res.end(JSON.stringify({ service: COCKPIT_SERVICE_IDENTITY, status: "degraded" }));
      },
      async (port) => {
        expect(await realIncumbentProbes.health(port, "127.0.0.1")).toEqual({
          service: COCKPIT_SERVICE_IDENTITY,
        });
      }
    );
  });

  test("a 200 with no service field answers, but carries no identity", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ status: "ok" }));
      },
      async (port) => {
        expect(await realIncumbentProbes.health(port, "127.0.0.1")).toEqual({ service: null });
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
        expect(await realIncumbentProbes.health(port, "127.0.0.1")).toEqual({ service: null });
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
    expect(await realIncumbentProbes.health(freed, "127.0.0.1")).toBeNull();
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

  test("passes the probed port, pid AND bind host through to the probes", async () => {
    // The bind host is threaded because probing the wrong address reads as
    // absence, which is the branch that kills (PR #3064 R1).
    const seen: { port?: number; pid?: number; host?: string } = {};
    await resolveIncumbentDisposition(
      3737,
      4242,
      "192.168.1.50",
      probes({
        health: async (port, bindHost) => {
          seen.port = port;
          seen.host = bindHost;
          return null;
        },
        processStartedAtMs: (pid) => {
          seen.pid = pid;
          return CONSISTENT_START.holderStartedAtMs;
        },
      })
    );
    expect(seen).toEqual({ port: 3737, pid: 4242, host: "192.168.1.50" });
  });

  test("a serving incumbent resolves to preserve", async () => {
    expect((await resolveIncumbentDisposition(3737, 1, "127.0.0.1", probes())).kind).toBe(
      "preserve"
    );
  });

  test("a silent incumbent resolves to displace", async () => {
    const d = await resolveIncumbentDisposition(
      3737,
      1,
      "127.0.0.1",
      probes({ health: async () => null })
    );
    expect(d).toEqual({ kind: "displace" });
  });
});

describe("classifyHolderAgainstState — a record naming a dead pid is void (mt#4800)", () => {
  const HOLDER = { pid: 61109, command: "bun run src/cli.ts cockpit start" };
  const alive = (aliveSet: number[]) => (pid: number) => aliveSet.includes(pid);

  test("a live record matching the holder recognizes it", () => {
    const c = classifyHolderAgainstState(HOLDER, 3737, { pid: 61109, port: 3737 }, alive([61109]));
    expect(c).toEqual({ kind: "recognized-zombie", pid: 61109, command: HOLDER.command });
  });

  test("a record naming a DEAD pid classifies exactly like no record at all", () => {
    // The 2026-08-31 shape: state names 16865 (dead), the port is held by a
    // live process. The dead record must not block, recognize, or be cited.
    const withDeadRecord = classifyHolderAgainstState(
      HOLDER,
      3737,
      { pid: 16865, port: 3737 },
      alive([61109])
    );
    const withNoRecord = classifyHolderAgainstState(HOLDER, 3737, null, alive([61109]));
    expect(withDeadRecord).toEqual(withNoRecord);
    expect(withDeadRecord).toEqual({
      kind: "unrecognized",
      pid: 61109,
      command: HOLDER.command,
    });
  });

  test("a dead record can never recognize a holder, even on pid equality", () => {
    // Defensive half of the invariant: if the liveness read and the lsof read
    // ever disagree (a holder that exited between the two probes), the record
    // stays void rather than vouching for a pid that is gone.
    const c = classifyHolderAgainstState(
      { pid: 16865, command: "<unknown>" },
      3737,
      { pid: 16865, port: 3737 },
      alive([])
    );
    expect(c.kind).toBe("unrecognized");
  });

  test("a live record for a DIFFERENT port does not recognize this holder", () => {
    const c = classifyHolderAgainstState(HOLDER, 3737, { pid: 61109, port: 3838 }, alive([61109]));
    expect(c.kind).toBe("unrecognized");
  });
});
