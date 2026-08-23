/**
 * @fileoverview Tests for custom/require-registered-cockpit-loop (mt#4185).
 *
 * The invalid cases reproduce `startPrincipalChannelPoller`'s pre-fix shape — a hand-rolled
 * `while (!stopped) { await … }` in a `start*` export that joins no registry, which is what made
 * a 44-hour park invisible to a meta-watchdog built to catch exactly that.
 *
 * The valid cases are the ones that matter for whether this rule can stay ON. Four of them come
 * straight from the `src/cockpit` census done at authoring time: a per-connection `setInterval`,
 * a bounded queue-drain `while`, a counted `for`, and a non-exported helper. If any of those
 * started failing, the rule would be flagging shipped, correct code and would be disabled — so
 * they are pinned here rather than left to a reviewer's judgement.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./require-registered-cockpit-loop.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const FILE = "src/cockpit/some-loop.ts";
const UNREGISTERED_LOOP = "unregisteredLoop";
const MODULE_SCOPE_INTERVAL = "moduleScopeInterval";

tester.run("require-registered-cockpit-loop", rule, {
  valid: [
    // The shape this rule is steering toward: self-scheduling AND registered.
    {
      filename: FILE,
      code: `
        export function startThing(deps) {
          const liveness = registerSelfSchedulingSweep({
            name: "thing",
            progressBudgetMs: 1000,
            restart: () => {},
          });
          const loop = async () => {
            while (!stopped) {
              await cycle(deps);
              liveness.noteProgress();
            }
          };
          void loop();
        }
      `,
    },
    // An arrow-function export, registered the same way.
    {
      filename: FILE,
      code: `
        export const startArrow = (deps) => {
          const h = registerSelfSchedulingSweep({ name: "a", progressBudgetMs: 1, restart: () => {} });
          const loop = async () => { while (true) { await cycle(); h.noteProgress(); } };
          void loop();
        };
      `,
    },
    // An interval sweeper registers by construction — no self-scheduling loop at all.
    {
      filename: FILE,
      code: `
        export function startSweeper() {
          return createIntervalSweeper({ name: "s", intervalMs: 1000, tick: async () => {} });
        }
      `,
    },
    // CENSUS CASE — a bounded queue drain. Has `await`, but it is not a daemon loop and
    // terminates on its own (entity-thread-reply-buffer.ts).
    {
      filename: FILE,
      code: `
        export function startDrain(queue) {
          const run = async () => {
            while (queue.length > 0) {
              await send(queue.shift());
            }
          };
          void run();
        }
      `,
    },
    // CENSUS CASE — a deadline loop. Runs until the clock passes, not until a flag flips
    // (port-recovery.ts, dev-chromium.ts).
    {
      filename: FILE,
      code: `
        export function startWait(deadline) {
          const run = async () => {
            while (Date.now() < deadline) {
              await probe();
            }
          };
          void run();
        }
      `,
    },
    // CENSUS CASE — a counted `for` with a test clause terminates; only `for(;;)` is loop-shaped.
    {
      filename: FILE,
      code: `
        export function startBatch(items) {
          const run = async () => {
            for (let i = 0; i < items.length; i++) {
              await handle(items[i]);
            }
          };
          void run();
        }
      `,
    },
    // CENSUS CASE — a per-connection/per-send `setInterval`, inside a function. Cannot join the
    // registry even in principle: it is name-keyed and throws on a duplicate active name, so a
    // second connection would collide with the first.
    {
      filename: FILE,
      code: `
        export function startTypingLoop(opts) {
          const timer = setInterval(() => send(opts), 4000);
          return { stop: () => clearInterval(timer) };
        }
      `,
    },
    // CENSUS CASE — a non-exported helper. Not a daemon entry point.
    {
      filename: FILE,
      code: `
        function pumpForever() {
          const run = async () => { while (true) { await tick(); } };
          void run();
        }
      `,
    },
    // An exported function whose name does not begin with `start` is not a daemon entry point.
    {
      filename: FILE,
      code: `
        export function runOnce() {
          const run = async () => { while (true) { await tick(); } };
          void run();
        }
      `,
    },
    // A `while` with no `await` is a synchronous shift/pop loop, not a park risk.
    {
      filename: FILE,
      code: `
        export function startTrim(buffer) {
          while (buffer.length > 100) buffer.shift();
        }
      `,
    },
    // PR #3056 R1 — a specifier-exported start* that DOES register is still valid.
    {
      filename: FILE,
      code: `
        function startSpecifier() {
          const h = registerSelfSchedulingSweep({ name: "s", progressBudgetMs: 1, restart: () => {} });
          const run = async () => { while (true) { await tick(); h.noteProgress(); } };
          void run();
        }
        export { startSpecifier };
      `,
    },
    // PR #3056 R1 — a specifier export where NEITHER name begins with `start` is not an entry
    // point this rule polices, exactly like a non-exported helper.
    {
      filename: FILE,
      code: `
        function pumpForever() {
          const run = async () => { while (true) { await tick(); } };
          void run();
        }
        export { pumpForever };
      `,
    },
  ],

  invalid: [
    // AT4 — the pre-fix `startPrincipalChannelPoller` shape, verbatim in structure.
    {
      filename: FILE,
      code: `
        export function startPrincipalChannelPoller(deps, opts = {}) {
          const controller = new AbortController();
          let stopped = false;
          const loop = async () => {
            while (!stopped) {
              await runPollCycle({ ...deps, signal: controller.signal });
            }
          };
          void loop();
          return { stop: () => { stopped = true; controller.abort(); } };
        }
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    // Same defect via an arrow export and an unbounded `for(;;)`.
    {
      filename: FILE,
      code: `
        export const startTailer = () => {
          const run = async () => {
            for (;;) {
              await readNext();
            }
          };
          void run();
        };
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    // `do…while` reaches the same shape.
    {
      filename: FILE,
      code: `
        export function startPump() {
          const run = async () => {
            do {
              await tick();
            } while (!stopped);
          };
          void run();
        }
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    // Registering something OTHER than this loop does not cover it — the registration has to be
    // inside the start export that owns the loop.
    {
      filename: FILE,
      code: `
        const other = registerSelfSchedulingSweep({ name: "x", progressBudgetMs: 1, restart: () => {} });
        export function startUnregistered() {
          const run = async () => { while (true) { await tick(); } };
          void run();
        }
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    // PR #3056 R1 — the four evasions the reviewer found. Each is the same defect wearing a
    // different export spelling, and each was invisible to the first version of this rule.
    {
      filename: FILE,
      code: `
        export default function startDefaultExport() {
          const run = async () => { while (true) { await tick(); } };
          void run();
        }
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    {
      filename: FILE,
      code: `
        function startSpecifierExport() {
          const run = async () => { while (!stopped) { await tick(); } };
          void run();
        }
        export { startSpecifierExport };
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    // Renamed ON EXPORT to a start* name — the local name would not have matched.
    {
      filename: FILE,
      code: `
        function pump() {
          const run = async () => { while (true) { await tick(); } };
          void run();
        }
        export { pump as startRenamed };
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    // Renamed AWAY from a start* name on export — the exported name would not have matched.
    {
      filename: FILE,
      code: `
        function startRenamedAway() {
          const run = async () => { while (true) { await tick(); } };
          void run();
        }
        export { startRenamedAway as pump };
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    // `export default <identifier>` resolves to the declaration, which may precede it.
    {
      filename: FILE,
      code: `
        function startDefaultIdentifier() {
          const run = async () => { while (true) { await tick(); } };
          void run();
        }
        export default startDefaultIdentifier;
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    // The export precedes the declaration — resolution happens at Program:exit for this reason.
    {
      filename: FILE,
      code: `
        export { startHoisted };
        function startHoisted() {
          const run = async () => { while (true) { await tick(); } };
          void run();
        }
      `,
      errors: [{ messageId: UNREGISTERED_LOOP }],
    },
    // A module-scope `setInterval` runs for the daemon's whole life outside the factory.
    {
      filename: FILE,
      code: `const timer = setInterval(() => refresh(), 60000);`,
      errors: [{ messageId: MODULE_SCOPE_INTERVAL }],
    },
  ],
});
