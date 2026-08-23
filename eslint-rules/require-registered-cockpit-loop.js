/**
 * @fileoverview Flag a long-lived cockpit-daemon loop that never joins the sweep-liveness
 * registry (mt#4185).
 *
 * Originating incident: `startPrincipalChannelPoller` is a hand-rolled `while (!stopped) { await
 * … }` loop. It parked on an unsettled await for ~44 hours while the daemon stayed alive,
 * `/api/health` reported the channel `running`, and `GET /api/sweeps` listed 16 healthy sweeps
 * and never mentioned it — because membership in that registry is purely a side effect of
 * calling `createIntervalSweeper`, and this loop called nothing. Seven shipped tasks had each
 * widened the mechanism INSIDE the registry; the recurrence landed in the one place none of them
 * could reach.
 *
 * Prose could not hold this class. `docs/architecture/cockpit.md`'s meta-watchdog `What this
 * does NOT cover` block enumerates process death and total timer death; a non-registrant loop is
 * in neither the covered nor the not-covered list, so repeated `Does NOT cover` audits — a
 * discipline this repo applies well — could never surface it. An enumeration can only be audited
 * for what it enumerates, which is why this is a lint rule and not another paragraph.
 *
 * ## What it flags, and why only this
 *
 * 1. A `while` / `do…while` / `for(;;)` loop with a FLAG-SHAPED test (see `isFlagShapedTest`)
 *    whose body contains an `await`, inside an EXPORTED function whose name begins with
 *    `start`, where that function never calls a registration function. `start*` + runs-until-a-
 *    flag-flips + `await` is the shape of a daemon-lifetime loop; the registration call is what
 *    puts it in the meta-watchdog's reach.
 * 2. A `setInterval` at MODULE scope — unambiguously daemon-lifetime, and outside the factory
 *    that would have registered it.
 *
 * ## Export forms recognized (PR #3056 R1)
 *
 * A rule that exists to prevent an evasion must not be evadable by how the entry point is
 * spelled. All four forms are recognized: `export function startX()`, `export const startX =`,
 * `export default function startX()`, and a specifier export (`function startX(){} … export
 * { startX }`, including `export { pump as startX }` and `export default startX`). Specifiers
 * resolve at `Program:exit` against every named declaration in the file, so an export may
 * precede its declaration. For a renamed specifier EITHER side beginning with `start` counts —
 * keying on the exported name alone would let `export { startFoo as foo }` through, and on the
 * local name alone would miss `export { pump as startFoo }`.
 *
 * **Stated honestly, not implied:** an ANONYMOUS default export (`export default function () {
 * while (true) { await … } }`) is NOT caught, because there is no name to test against `start`
 * and this rule's entry-point signal is the name. That form is not present in `src/cockpit`
 * today and would be an odd way to write a daemon entry point, but it is a real gap rather
 * than one this rule closes.
 *
 * ## What it deliberately does NOT flag
 *
 * A `setInterval` inside a function. A census of `src/cockpit` (excluding `web/` and tests) at
 * authoring time found five such sites and all five are legitimate, because each is scoped to
 * something shorter-lived than the daemon: `principal-channel-poller.ts`'s typing-indicator
 * refresh (one send), `live-tail-poller.ts`'s file tailer (one SSE connection), and the SSE
 * heartbeats in `routes/conversations.ts`, `routes/agents.ts` and `routes/events.ts` (one
 * connection each). None could join the registry even in principle: it is keyed by name and
 * THROWS on a duplicate active registration, so a per-connection loop would collide with itself
 * on the second connection. Flagging them would produce five false positives and teach readers
 * to disable the rule — so the daemon-lifetime/per-connection distinction is drawn where it can
 * be drawn statically (module scope) rather than guessed.
 *
 * Reference: mt#4185 (this rule), mt#4183 (the incident), mt#2894 (the registry + meta-watchdog),
 * mem#1060 (the fix-lands-on-the-instance lesson this mechanizes).
 */

const DEFAULT_REGISTRATION_FUNCTIONS = ["createIntervalSweeper", "registerSelfSchedulingSweep"];

/** True when `inner` lies entirely within `outer` (both are ESLint `[start, end]` ranges). */
function contains(outer, inner) {
  return outer[0] <= inner[0] && inner[1] <= outer[1];
}

/**
 * True when a loop's test marks it as running until a FLAG flips, rather than until DATA runs
 * out or a DEADLINE passes.
 *
 * This is the discriminator between a daemon loop and a bounded one, and it is drawn from the
 * `src/cockpit` census rather than invented: the one daemon loop tests `!stopped`, while every
 * bounded loop tests a comparison — `queue.length > 0`, `Date.now() - start < timeout`,
 * `offset < srcSize`, `next < thunks.length`. A bounded loop terminates on its own and has
 * nothing to report progress to, so flagging one is a false positive that would get the rule
 * disabled.
 *
 * Accepted as flag-shaped: `while (true)`, `for (;;)`, a bare identifier (`while (running)`),
 * and a negated identifier (`while (!stopped)`) — optionally through a member expression, so
 * `while (!this.stopped)` and `while (state.running)` are covered too.
 */
function isFlagShapedTest(test) {
  if (test === null) return true; // `for (;;)`
  if (test.type === "Literal") return test.value === true;
  if (test.type === "Identifier" || test.type === "MemberExpression") return true;
  if (test.type === "UnaryExpression" && test.operator === "!") {
    return isFlagShapedTest(test.argument);
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a long-lived cockpit-daemon loop to register with the sweep-liveness registry",
      category: "Possible Errors",
      recommended: false,
      url: "https://github.com/edobry/minsky/blob/main/eslint-rules/require-registered-cockpit-loop.js",
    },
    schema: [
      {
        type: "object",
        properties: {
          registrationFunctions: {
            type: "array",
            items: { type: "string" },
            description:
              "Names of calls that count as joining the sweep-liveness registry. Defaults to createIntervalSweeper + registerSelfSchedulingSweep.",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unregisteredLoop:
        "'{{name}}' runs a self-scheduling loop containing `await` but never calls {{registrations}} — so the sweep meta-watchdog cannot see it, and a park on any await inside it is invisible on GET /api/sweeps (mt#4185). Register the loop with `registerSelfSchedulingSweep` and report progress after each await that could park.",
      moduleScopeInterval:
        "A `setInterval` at module scope runs for the daemon's whole lifetime but is outside `createIntervalSweeper`, so the meta-watchdog cannot restart it when its timer stops firing (mt#4185). Create it through `createIntervalSweeper` instead.",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const registrationFunctions = Array.isArray(options.registrationFunctions)
      ? options.registrationFunctions
      : DEFAULT_REGISTRATION_FUNCTIONS;

    /** Ranges of every function body in the file — used to tell module scope from inside one. */
    const functionRanges = [];
    /** Ranges of exported `start*` functions, with their names. */
    const startExports = [];
    /**
     * Every named function-ish declaration in the file, by LOCAL name, whether or not it is
     * exported inline. `export { startX }` names a binding declared elsewhere in the file, so
     * the specifier alone carries no range — this is what it resolves against.
     */
    const declaredByName = new Map();
    /** `export { local as exported }` pairs, resolved at Program:exit against `declaredByName`. */
    const exportSpecifiers = [];
    /** Ranges of calls that count as registering. */
    const registrationRanges = [];
    /** Ranges of every `await` expression. */
    const awaitRanges = [];
    /** Candidate self-scheduling loops. */
    const loops = [];
    /** Module-scope `setInterval` calls, resolved at Program:exit once every function is known. */
    const intervalCalls = [];

    /** A public entry point this rule polices is any binding whose name begins with `start`. */
    function isStartName(name) {
      return typeof name === "string" && name.startsWith("start");
    }

    /** Record an exported `start*` binding, however it is spelled. */
    function noteStartExport(name, node) {
      if (isStartName(name)) {
        startExports.push({ name, range: node.range });
      }
    }

    /** True when a variable's initializer makes it a function-ish binding. */
    function isFunctionish(init) {
      return (
        init != null &&
        (init.type === "ArrowFunctionExpression" ||
          init.type === "FunctionExpression" ||
          init.type === "CallExpression")
      );
    }

    return {
      FunctionDeclaration(node) {
        functionRanges.push(node.range);
        // Recorded whether or not it is exported here: `export { startX }` may appear anywhere
        // in the file, including before this declaration.
        if (node.id?.name) declaredByName.set(node.id.name, node.range);
      },
      FunctionExpression(node) {
        functionRanges.push(node.range);
      },
      ArrowFunctionExpression(node) {
        functionRanges.push(node.range);
      },
      VariableDeclarator(node) {
        if (node.id?.type === "Identifier" && isFunctionish(node.init)) {
          declaredByName.set(node.id.name, node.range);
        }
      },

      // `export function startX() {}`
      "ExportNamedDeclaration > FunctionDeclaration"(node) {
        noteStartExport(node.id?.name, node);
      },
      // `export const startX = () => {}` / `= function () {}`
      "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator"(node) {
        if (!isFunctionish(node.init)) return;
        noteStartExport(node.id?.name, node);
      },
      // `export default function startX() {}` and `export default startX`.
      ExportDefaultDeclaration(node) {
        const declaration = node.declaration;
        if (!declaration) return;
        if (declaration.type === "FunctionDeclaration") {
          noteStartExport(declaration.id?.name, declaration);
          return;
        }
        if (declaration.type === "Identifier") {
          // Resolved at Program:exit — the declaration may appear later in the file.
          exportSpecifiers.push({ local: declaration.name, exported: declaration.name });
        }
      },
      // `function startX() {} … export { startX }` / `export { pump as startX }`.
      //
      // EITHER side beginning with `start` counts. Keying on the exported name alone would let
      // `export { startFoo as foo }` slip through, and on the local name alone would miss
      // `export { pump as startFoo }` — and a rule whose whole job is preventing an evasion
      // should not itself be evadable by a rename.
      ExportNamedDeclaration(node) {
        if (!Array.isArray(node.specifiers)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ExportSpecifier") continue;
          const local = specifier.local?.name;
          const exported = specifier.exported?.name;
          if (isStartName(local) || isStartName(exported)) {
            exportSpecifiers.push({ local, exported: exported ?? local });
          }
        }
      },

      AwaitExpression(node) {
        awaitRanges.push(node.range);
      },

      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "Identifier") return;
        if (registrationFunctions.includes(callee.name)) {
          registrationRanges.push(node.range);
          return;
        }
        if (callee.name === "setInterval") {
          intervalCalls.push(node);
        }
      },

      WhileStatement(node) {
        if (isFlagShapedTest(node.test)) loops.push(node);
      },
      DoWhileStatement(node) {
        if (isFlagShapedTest(node.test)) loops.push(node);
      },
      ForStatement(node) {
        // Only an unbounded `for (;;)` is loop-shaped in the way this rule cares about; a
        // counted `for` terminates on its own and is not a daemon loop.
        if (node.test === null) loops.push(node);
      },

      "Program:exit"() {
        // Resolve specifier and `export default <identifier>` exports now that every
        // declaration in the file has been seen — an export may precede its declaration.
        for (const { local, exported } of exportSpecifiers) {
          if (!isStartName(local) && !isStartName(exported)) continue;
          const range = declaredByName.get(local);
          if (range) startExports.push({ name: exported ?? local, range });
        }

        for (const loop of loops) {
          const hasAwait = awaitRanges.some((range) => contains(loop.range, range));
          if (!hasAwait) continue;

          const enclosing = startExports.find((fn) => contains(fn.range, loop.range));
          if (!enclosing) continue;

          const registers = registrationRanges.some((range) => contains(enclosing.range, range));
          if (registers) continue;

          context.report({
            node: loop,
            messageId: "unregisteredLoop",
            data: {
              name: enclosing.name,
              registrations: registrationFunctions.map((fn) => `\`${fn}\``).join(" or "),
            },
          });
        }

        for (const call of intervalCalls) {
          const insideFunction = functionRanges.some((range) => contains(range, call.range));
          if (insideFunction) continue;
          context.report({ node: call, messageId: "moduleScopeInterval" });
        }
      },
    };
  },
};
