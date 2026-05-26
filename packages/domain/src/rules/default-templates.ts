/**
 * Default Rule Templates
 *
 * This module re-exports all default rule templates and aggregates them into
 * the DEFAULT_TEMPLATES array. Templates are organized by category in sub-files
 * under the templates/ directory.
 */

export {
  MINSKY_WORKFLOW_TEMPLATE,
  INDEX_TEMPLATE,
  MINSKY_WORKFLOW_ORCHESTRATOR_TEMPLATE,
  CORE_WORKFLOW_TEMPLATES,
} from "./templates/core-workflow-templates";

export {
  TASK_IMPLEMENTATION_WORKFLOW_TEMPLATE,
  TASK_STATUS_PROTOCOL_TEMPLATE,
  TASK_TEMPLATES,
} from "./templates/task-templates";

export {
  MINSKY_SESSION_MANAGEMENT_TEMPLATE,
  SESSION_TEMPLATES,
} from "./templates/session-templates";

export {
  PR_PREPARATION_WORKFLOW_TEMPLATE,
  INTEGRATION_TEMPLATES,
} from "./templates/integration-templates";

import {
  MINSKY_WORKFLOW_TEMPLATE,
  INDEX_TEMPLATE,
  MINSKY_WORKFLOW_ORCHESTRATOR_TEMPLATE,
} from "./templates/core-workflow-templates";
import {
  TASK_IMPLEMENTATION_WORKFLOW_TEMPLATE,
  TASK_STATUS_PROTOCOL_TEMPLATE,
} from "./templates/task-templates";
import { MINSKY_SESSION_MANAGEMENT_TEMPLATE } from "./templates/session-templates";
import { PR_PREPARATION_WORKFLOW_TEMPLATE } from "./templates/integration-templates";
import { type RuleTemplate } from "./rule-template-service";

/**
 * All default templates available in the system, in their original order.
 */
export const DEFAULT_TEMPLATES: RuleTemplate[] = [
  MINSKY_WORKFLOW_TEMPLATE,
  INDEX_TEMPLATE,
  MINSKY_WORKFLOW_ORCHESTRATOR_TEMPLATE,
  TASK_IMPLEMENTATION_WORKFLOW_TEMPLATE,
  MINSKY_SESSION_MANAGEMENT_TEMPLATE,
  TASK_STATUS_PROTOCOL_TEMPLATE,
  PR_PREPARATION_WORKFLOW_TEMPLATE,
];
