/**
 * @fileoverview Forbid hand-rolled command param types in the shared-command
 * tree (mt#2779). Execute handlers must derive their param type from the
 * command's params map — `InferParams<typeof <map>>` — or omit the annotation
 * entirely so contextual inference from `parameters:` applies. Hand-rolled
 * `*Params` interfaces/literal aliases let a handler read `params.<key>` for
 * keys the command never declares, compiling cleanly while the value is
 * always undefined at runtime (the mt#2742 Detector-B bug class; root cause
 * analysis in mt#2743 Investigation finding #4).
 *
 * Two distinct compile-time holes this rule closes at the lint tier (the
 * compiler cannot: excess property checking applies only to fresh object
 * literals, and method-override params check bivariantly):
 *   1. Explicit annotations — an interface with OPTIONAL undeclared fields
 *      accepts an `InferParams<T>` lacking them via function-parameter
 *      contravariance, so `params.<ghost>` compiles.
 *   2. Class-based commands — `BaseTaskCommand`'s generic must be the params
 *      MAP type (`typeof <map const>`); a hand-rolled generic is never tied
 *      to the `parameters` property, so the two can disagree arbitrarily.
 *
 * What is flagged:
 *   - `interface FooParams { ... }` declarations (any `*Params` interface —
 *     genuinely-non-handler projection types carry an eslint-disable with a
 *     recorded justification, e.g. BaseTaskParams / CreateAskParams)
 *   - `type FooParams = { ... }` literal-shape aliases (derived aliases like
 *     `type FooParams = InferParams<typeof map>` are allowed)
 *   - `execute` handler first params annotated with anything other than
 *     `InferParams<...>` (no annotation = contextual inference = allowed)
 *   - `extends BaseTaskCommand<X>` where X is not `typeof <map const>`
 *   - `expr as FooParams` casts (bypass the derived typing; test files are
 *     excluded from this rule via the ESLint config scope)
 *
 * Precedent: `custom/no-unregistered-minsky-env-var` (mt#1788) — the same
 * declare-before-use discipline, applied here to command params.
 *
 * Tracking task: mt#2779 (parent umbrella mt#2743).
 */

const PARAMS_NAME = /Params$/;

/** `typeof someIdentifier` — the only allowed BaseTaskCommand generic shape. */
function isTypeQuery(node) {
  return node?.type === "TSTypeQuery";
}

function isInferParamsRef(node) {
  return (
    node?.type === "TSTypeReference" &&
    node.typeName?.type === "Identifier" &&
    node.typeName.name === "InferParams"
  );
}

/** Walk unions/intersections looking for a literal object shape. */
function containsTypeLiteral(node) {
  if (!node) return false;
  if (node.type === "TSTypeLiteral") return true;
  if (node.type === "TSUnionType" || node.type === "TSIntersectionType") {
    return node.types.some(containsTypeLiteral);
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require command execute handlers to derive param types from the params map (InferParams<typeof map>) instead of hand-rolled *Params types (mt#2779)",
    },
    schema: [],
    messages: {
      handRolledInterface:
        "Hand-rolled param interface '{{name}}'. Handler param types must derive from the params map: `InferParams<typeof <map>>` (mt#2779). If this is genuinely not a handler param type (helper/projection input), keep it under an eslint-disable with a recorded justification — or rename it off the *Params namespace.",
      handRolledAliasLiteral:
        "Type alias '{{name}}' declares a literal shape. Derive it from the params map instead: `type {{name}} = InferParams<typeof <map>>` (mt#2779).",
      handRolledAnnotation:
        "Execute handler param annotated with '{{got}}' instead of a map-derived type. Omit the annotation (contextual inference from `parameters:`) or use `InferParams<typeof <map>>` (mt#2779).",
      untiedClassGeneric:
        "BaseTaskCommand's generic must be the params map type (`typeof <map const>`) so the execute param type derives from the map — a hand-rolled generic is never tied to `parameters` and the two can disagree (mt#2779).",
      paramsCast:
        "Cast to '{{name}}' bypasses map-derived typing. Type the value via `InferParams<typeof <map>>` (or fix the source type) instead of casting (mt#2779).",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function checkExecuteFunction(fnNode) {
      const firstParam = fnNode.params?.[0];
      if (!firstParam) return;
      const annotation = firstParam.typeAnnotation?.typeAnnotation;
      if (!annotation) return; // no annotation — contextual inference, the preferred form
      if (isInferParamsRef(annotation)) return;
      context.report({
        node: firstParam,
        messageId: "handRolledAnnotation",
        data: { got: sourceCode.getText(annotation) },
      });
    }

    function checkClassHeritage(node) {
      const superClass = node.superClass;
      if (!superClass || superClass.type !== "Identifier") return;
      if (superClass.name !== "BaseTaskCommand") return;
      // Parser-version tolerant: typescript-eslint >=6 uses superTypeArguments,
      // older versions superTypeParameters.
      const typeArgs = node.superTypeArguments ?? node.superTypeParameters;
      const firstArg = typeArgs?.params?.[0];
      if (!firstArg || !isTypeQuery(firstArg)) {
        context.report({
          node: firstArg ?? superClass,
          messageId: "untiedClassGeneric",
        });
      }
    }

    return {
      TSInterfaceDeclaration(node) {
        if (PARAMS_NAME.test(node.id.name)) {
          context.report({
            node: node.id,
            messageId: "handRolledInterface",
            data: { name: node.id.name },
          });
        }
      },

      TSTypeAliasDeclaration(node) {
        if (PARAMS_NAME.test(node.id.name) && containsTypeLiteral(node.typeAnnotation)) {
          context.report({
            node: node.id,
            messageId: "handRolledAliasLiteral",
            data: { name: node.id.name },
          });
        }
      },

      "Property[key.name='execute']"(node) {
        const value = node.value;
        if (
          value &&
          (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression")
        ) {
          checkExecuteFunction(value);
        }
      },

      "MethodDefinition[key.name='execute']"(node) {
        if (node.value) checkExecuteFunction(node.value);
      },

      "PropertyDefinition[key.name='execute']"(node) {
        const value = node.value;
        if (
          value &&
          (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression")
        ) {
          checkExecuteFunction(value);
        }
      },

      ClassDeclaration: checkClassHeritage,
      ClassExpression: checkClassHeritage,

      TSAsExpression(node) {
        const target = node.typeAnnotation;
        if (
          target?.type === "TSTypeReference" &&
          target.typeName?.type === "Identifier" &&
          PARAMS_NAME.test(target.typeName.name)
        ) {
          context.report({
            node,
            messageId: "paramsCast",
            data: { name: target.typeName.name },
          });
        }
      },
    };
  },
};
