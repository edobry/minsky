/**
 * Cognition Provider — public entry point.
 *
 * See ADR-007: Cognition Provider Abstraction for Multi-Mode AI Operation.
 */

export type {
  CognitionBatchValues,
  CognitionBundle,
  CognitionProvider,
  CognitionResult,
  CognitionTask,
  ModelHint,
} from "./types";

export {
  CognitionError,
  CognitionEvidenceSerializationError,
  CognitionExecutionError,
  CognitionValidationError,
} from "./types";

export { DirectCognitionProvider } from "./providers/direct";
