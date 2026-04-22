/**
 * Derivation-Discipline Validator — backward-compat re-export
 *
 * The canonical implementation has moved to the domain layer so that both
 * the command-layer (child 2) and the importer script (child 3) share the
 * same logic without duplication.
 *
 * @see src/domain/memory/validation.ts
 */

export { checkDerivation, type DerivationIssue } from "../../../../domain/memory/validation";
