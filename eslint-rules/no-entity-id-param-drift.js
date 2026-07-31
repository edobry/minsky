/**
 * @fileoverview Flag intra-family entity-id param-name drift at authoring
 * time (mt#2780, child C of mt#2743 — the mt#2741 Detector-A class).
 *
 * A command in a family directory (e.g. `src/adapters/shared/commands/tasks/`)
 * whose params map declares the family's back-compat ALIAS name without the
 * family's CANONICAL name silently diverges from the family convention: a
 * convention-following caller passes the canonical key, the boundary rejects
 * it (mt#2778) or — pre-boundary — dropped it, and the handler read resolved
 * undefined. mt#2741 realigned 8 commands after an after-the-fact audit; this
 * rule catches the same shape when the map is AUTHORED.
 *
 * Conventions are DECLARED, not inferred (decision record: mt#2741). The
 * table below is keyed by the family directory name under
 * `src/adapters/shared/commands/`; families are added as their conventions
 * are confirmed. Compliance shapes per family entry:
 *   - canonical alone ........................ clean
 *   - canonical + alias (back-compat pair) ... clean (the mt#2737/mt#2741 pattern)
 *   - alias alone ............................ FLAGGED
 *
 * Coverage model (PR #1933 R1): the ESLint config block enumerates the
 * covered family directories as explicit `files` globs — config, not
 * path-parsing, is what determines enforcement scope. Adding a family =
 * add a `FAMILY_CONVENTIONS` entry here AND its glob in `eslint.config.js`
 * (both named in the code-style rule doc). The path parsing below is
 * defense-in-depth for direct/RuleTester invocations, not the scoping
 * mechanism.
 *
 * Conservatism (zero-false-positive requirement, mt#2780 acceptance test 3):
 * - A map containing a spread (`...taskContextParams`) may receive the
 *   canonical key through the spread, which per-file analysis cannot see —
 *   such maps are skipped when the canonical is not locally visible.
 * - The `parameters:` object/class-field paths only fire on objects that
 *   LOOK like command param maps (at least one property value shaped like a
 *   param definition — an object literal with a `schema` key). A generic
 *   options bag that happens to be named `parameters` and contain a `task`
 *   string field is not a param map and is not checked. The
 *   `satisfies CommandParameterMap` path needs no shape guard — the type
 *   assertion is definitive.
 *
 * NOTE: alias names are only checked within their OWN family directory —
 * `session` is a legitimate workspace-scoping context param in `tasks/`
 * maps (taskContextParams), and `task` is a legitimate co-selector in
 * `session/` maps. Cross-family key reuse is NOT drift.
 *
 * Siblings: `custom/no-hand-rolled-command-params` (mt#2779, Detector-B
 * class — handler typing); precedent `custom/no-unregistered-minsky-env-var`
 * (mt#1788).
 */

import { sep as pathSep } from "node:path";

/**
 * family directory name → { canonical, aliases } (decision record: mt#2741).
 * An alias declared without the canonical in the same map is drift.
 */
const FAMILY_CONVENTIONS = {
  tasks: { canonical: "taskId", aliases: ["task"] },
  session: { canonical: "sessionId", aliases: ["session"] },
};

const COMMANDS_ROOT_POSIX = "src/adapters/shared/commands";

/** Extract the family directory name from the file path, or null. */
function familyForFilename(filename) {
  const normalized = filename.split(pathSep).join("/");
  const idx = normalized.indexOf(`${COMMANDS_ROOT_POSIX}/`);
  if (idx === -1) return null;
  const rest = normalized.slice(idx + COMMANDS_ROOT_POSIX.length + 1);
  const firstSegment = rest.split("/")[0];
  // Top-level files (e.g. asks.ts) have no family directory — no entry, no check.
  if (!firstSegment || firstSegment.endsWith(".ts") || firstSegment.endsWith(".js")) return null;
  return firstSegment;
}

function propertyKeyName(prop) {
  if (prop.type !== "Property") return null;
  if (prop.key?.type === "Identifier") return prop.key.name;
  if (prop.key?.type === "Literal" && typeof prop.key.value === "string") return prop.key.value;
  return null;
}

/** A value shaped like a CommandParameterDefinition: `{ schema: ..., ... }`. */
function isParamDefShaped(valueNode) {
  return (
    valueNode?.type === "ObjectExpression" &&
    valueNode.properties.some((p) => p.type === "Property" && propertyKeyName(p) === "schema")
  );
}

/**
 * Shape guard for the `parameters:` property/class-field paths: only treat
 * the object as a command param map when at least one property value is
 * param-definition-shaped. Prevents false positives on generic objects that
 * happen to be named `parameters` (PR #1933 R1 blocker 1).
 */
function looksLikeParamMap(objectNode) {
  if (!objectNode || objectNode.type !== "ObjectExpression") return false;
  return objectNode.properties.some((p) => p.type === "Property" && isParamDefShaped(p.value));
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Flag a command params map declaring a family's alias entity-id name without the family's canonical name (mt#2780, Detector-A drift class)",
    },
    schema: [],
    messages: {
      aliasWithoutCanonical:
        "Entity-id param drift: this `{{family}}` family map declares '{{alias}}' without the family's canonical '{{canonical}}' (convention record: mt#2741). Declare '{{canonical}}' (optionally keeping '{{alias}}' as a back-compat alias alongside it).",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const family = familyForFilename(filename);
    const convention = family ? FAMILY_CONVENTIONS[family] : null;
    if (!convention) return {};

    /**
     * A param-map object literal is one that either sits under
     * `... satisfies CommandParameterMap` or is the value of a
     * `parameters:` property / `readonly parameters =` class field.
     */
    function checkMapObject(objectNode) {
      if (!objectNode || objectNode.type !== "ObjectExpression") return;

      const keys = [];
      let hasSpread = false;
      for (const prop of objectNode.properties) {
        if (prop.type === "SpreadElement") {
          hasSpread = true;
          continue;
        }
        const name = propertyKeyName(prop);
        if (name) keys.push({ name, node: prop.key });
      }

      const hasCanonical = keys.some((k) => k.name === convention.canonical);
      if (hasCanonical) return;
      // Canonical may arrive via a spread this per-file rule cannot see —
      // skip rather than risk a false positive.
      if (hasSpread) return;

      for (const alias of convention.aliases) {
        const hit = keys.find((k) => k.name === alias);
        if (hit) {
          context.report({
            node: hit.node,
            messageId: "aliasWithoutCanonical",
            data: { family, alias, canonical: convention.canonical },
          });
        }
      }
    }

    return {
      // `{ ... } satisfies CommandParameterMap`
      TSSatisfiesExpression(node) {
        const t = node.typeAnnotation;
        if (
          t?.type === "TSTypeReference" &&
          t.typeName?.type === "Identifier" &&
          t.typeName.name === "CommandParameterMap"
        ) {
          checkMapObject(node.expression);
        }
      },

      // `parameters: { ... }` in registration object literals — shape-guarded
      "Property[key.name='parameters']"(node) {
        if (looksLikeParamMap(node.value)) checkMapObject(node.value);
      },

      // `readonly parameters = { ... }` class fields — shape-guarded
      "PropertyDefinition[key.name='parameters']"(node) {
        if (looksLikeParamMap(node.value)) checkMapObject(node.value);
      },
    };
  },
};
